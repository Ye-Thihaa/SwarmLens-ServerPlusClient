<#
.SYNOPSIS
  Publishes the LOCAL 3-node cluster to a public HTTPS URL via SSH reverse
  tunnels through serveo.net. No account, no login, no card, nothing to
  install beyond the OpenSSH client Windows 10+ already ships.

.DESCRIPTION
  Why tunnel the local cluster instead of deploying it: locally the cluster
  runs at full fidelity -- three real nodes, default raft timers (~250ms
  failover, not the 3-6s a public-URL PaaS forces), working chaos,
  partitions, quorum reads and blob replication. A free single-node deploy
  can't demonstrate any of that, because there are no peers to gossip with
  or partition from.

  Why serveo.net and not Cloudflare Quick Tunnels: tried first, and it does
  not work on every network. Quick Tunnels register over a plain HTTPS POST
  to api.trycloudflare.com, and on a network that blocks that domain at the
  TLS/SNI layer (confirmed here: raw TCP connects fine, the TLS handshake
  never completes -- the signature of SNI-based filtering, not a slow or
  down server), cloudflared has no way through it: it does not honor
  HTTP_PROXY/HTTPS_PROXY for that call even when a working proxy is
  configured and reachable directly with curl. SSH to serveo.net was tested
  on the same blocked network and works with no proxy at all.

  Trade-off against Cloudflare: a guest who taps the web app link sees a
  one-time "Continue to Site" interstitial (a single button, no signup, no
  captcha) before reaching the app -- serveo's free-tier warning page,
  triggered only by a browser's Accept: text/html, not by the JS fetch()
  calls (Accept: */*) the app itself makes. Confirmed both cases directly.
  Backend node tunnels are pure API traffic and never see this page.

  Four tunnels: one per node so the browser can reach each of them
  individually (the console addresses nodes separately -- /chaos/partition
  indexes into a specific node's own PEERS list), plus one for the web app.

  A useful side effect: the tunnel is HTTPS, so the local dev server can
  stay plain HTTP and guests still get a secure context. That is what
  getUserMedia requires, so the camera works on a phone with no dev
  certificate involved at all -- which is why this script moves
  client-2/certs aside rather than using it.

  The URLs are random per run and die with the process. That is the trade:
  zero setup and zero cost, in exchange for a link that only lives as long
  as this window.

  serveo.net rate-limits rapid tunnel creation from one client ("Too many
  tunnel starts from this client. Please wait a moment and try again.",
  printed to the ssh subprocess's stdout, exit code non-zero). Hit live
  while iterating on this script -- roughly a dozen open/close cycles in
  under 30 minutes was enough to trigger it. If a run fails at the tunnel
  -opening step with no other explanation, check node*.out/.err in
  $env:TEMP\swarmlens-tunnels for this exact message before assuming the
  script itself regressed. There is no documented cooldown; waiting
  several minutes between attempts during development is the practical
  fix, and it does not affect a single real demo run (this limit is about
  start-stop-start cycling, not about running one tunnel for a while).

.EXAMPLE
  ./scripts/demo-tunnel.ps1
#>
[CmdletBinding()]
param(
    [int[]] $NodePorts = @(8001, 8002, 8003),
    [int]   $WebPort   = 8080
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

# Bypass any system proxy for every .NET web call THIS SCRIPT makes (the
# local health checks below). Not related to the tunnel mechanism, which is
# plain SSH and needs no proxy on this network -- see the .DESCRIPTION note
# on why Cloudflare's path did.
#
# The bypass is still needed here because a loopback-intercepting proxy
# (Outline and similar) swallows 127.0.0.1 traffic and makes healthy nodes
# look unreachable. See CLAUDE.md's proxy gotcha.
[System.Net.WebRequest]::DefaultWebProxy = $null

$log = Join-Path $env:TEMP "swarmlens-tunnels"
New-Item -ItemType Directory -Force -Path $log | Out-Null
$procs = @()

# Throws only. The message is printed once by the catch at the bottom --
# printing here as well produced the message twice plus a stack trace,
# which buried a plain "install this first" under noise that looked like a
# crash.
function Fail($msg) { throw $msg }

# serveo prints "Forwarding HTTP traffic from https://..." -- but WHICH
# stream (stdout or stderr) carries it varies run to run, apparently
# depending on how the remote server buffers its banner. Checking only one
# stream missed it outright on one run. The regex also has to anchor on
# "Forwarding HTTP traffic from" specifically: serveo's OTHER banner line
# advertises https://console.serveo.net (its own dashboard, unrelated to
# this tunnel), and a looser pattern matches that domain instead -- the
# same class of bug Cloudflare's banner caused, where cloudflared's own
# failure message happened to contain a real-looking https://...
# trycloudflare.com substring.
function Start-ServeoTunnel([int] $Port, [string] $Name) {
    $out = Join-Path $log "$Name.out"
    $err = Join-Path $log "$Name.err"
    Remove-Item $out, $err -ErrorAction SilentlyContinue
    # StrictHostKeyChecking=accept-new: first connection to a new host would
    # otherwise prompt interactively and hang forever under Start-Process,
    # which has no terminal to answer it.
    $p = Start-Process ssh `
        -ArgumentList @("-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15",
                        "-R", "80:localhost:$Port", "serveo.net") `
        -RedirectStandardOutput $out -RedirectStandardError $err `
        -WindowStyle Hidden -PassThru
    $script:procs += $p

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $combined = @()
        if (Test-Path $out) { $combined += Get-Content $out -ErrorAction SilentlyContinue }
        if (Test-Path $err) { $combined += Get-Content $err -ErrorAction SilentlyContinue }
        $m = $combined | Select-String -Pattern "Forwarding HTTP traffic from (https://\S+)"
        if ($m) { return $m.Matches[0].Groups[1].Value }
        if ($p.HasExited) { Fail "ssh exited early for port $Port. See $out / $err" }
        Start-Sleep -Milliseconds 700
    }
    Fail "timed out waiting for a serveo URL on port $Port. See $out / $err"
}

try {
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        Fail "ssh not found. It ships with Windows 10+ (Settings > Optional Features > OpenSSH Client) if genuinely missing."
    }

    Write-Host "`n[1/5] checking the local cluster" -ForegroundColor Cyan

    # Distinguish "Docker Desktop isn't running" from "the cluster isn't
    # started". An earlier version reported only the latter, which sent you
    # to a command that cannot work while the daemon is down, with an error
    # that's a wall of npipe text.
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "Docker Desktop is not running. Start it from the Start menu, wait for the whale icon to settle, then re-run this script."
    }

    # Bring the cluster up rather than telling you to. If it is already
    # running this is a no-op, so it costs nothing to just do it.
    $running = (docker compose ps --status running --format '{{.Name}}' 2>$null | Measure-Object -Line).Lines
    if ($running -lt $NodePorts.Count) {
        Write-Host "  starting the cluster (docker compose up -d)..." -ForegroundColor DarkGray
        docker compose up -d 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }

    foreach ($p in $NodePorts) {
        $ok = $false
        $deadline = (Get-Date).AddSeconds(45)   # containers need a moment after a cold start
        while (-not $ok -and (Get-Date) -lt $deadline) {
            try {
                $h = Invoke-RestMethod "http://127.0.0.1:$p/health" -TimeoutSec 8
                Write-Host "  :$p $($h.node) events=$($h.events) raft=$($h.raft.role)"
                $ok = $true
            } catch { Start-Sleep -Milliseconds 1500 }
        }
        if (-not $ok) { Fail ":$p never answered. Check: docker compose logs --tail 30" }
    }

    # HTTPS locally would force nothing here (SSH tunnels don't care), but
    # the guest-facing HTTPS comes from the tunnel, not this dev cert -- so
    # a self-signed cert would just be an extra warning with no purpose.
    $certs = Join-Path $repo "client-2\certs"
    if (Test-Path $certs) {
        Move-Item $certs "$certs.bak" -Force
        Write-Host "  moved client-2/certs aside (the tunnel supplies HTTPS)" -ForegroundColor DarkGray
    }

    Write-Host "`n[2/5] opening a tunnel per node" -ForegroundColor Cyan
    $nodeUrls = @()
    for ($i = 0; $i -lt $NodePorts.Count; $i++) {
        # Spacing, not just retry backoff between whole script runs. Hit
        # live: opening node1 and node2 back-to-back was enough on its own
        # to trip serveo's "Too many tunnel starts from this client" on the
        # very next one (node3), inside a SINGLE run, no repeated runs
        # involved. Whatever their limit is measuring, it counts requests
        # this close together as one burst. 4s between opens (this script
        # opens 4 tunnels total) has not been proven sufficient by a full
        # clean run yet -- see the module docstring's rate-limit note.
        if ($i -gt 0) { Start-Sleep -Seconds 4 }
        $u = Start-ServeoTunnel $NodePorts[$i] "node$($i+1)"
        $nodeUrls += $u
        Write-Host "  node$($i+1) -> $u"
    }

    # Order is load-bearing: it must match each backend's own PEERS order,
    # because /chaos/partition/{i} indexes into that list positionally.
    Write-Host "`n[3/5] pointing the web app at those tunnels" -ForegroundColor Cyan
    # A real process environment variable, NOT a written .env.local file.
    # Earlier versions wrote the file, and Vite's own file watcher treated
    # it as a live change once the watcher attached a beat after boot --
    # even though this script writes it before npm ever starts -- and
    # restarted the dev server. That restart's delay was measured at ~28s
    # on one run and needed a 60s detection window on another, growing
    # with how slow Vite's cold start happened to be that time; chasing it
    # with an ever-larger timeout was fixing the symptom, not the cause.
    # $env: set here is inherited by Start-Process's child by default (no
    # extra flag needed), so npm/vite see VITE_CLUSTER_URLS from the
    # moment the process is created -- there is no file, so there is
    # nothing for a watcher to notice, so there is no restart to wait out.
    $env:VITE_CLUSTER_URLS = ($nodeUrls -join ',')
    Write-Host "  exported VITE_CLUSTER_URLS to the environment (no file written)"

    Write-Host "`n[4/5] starting the web app (requesting :$WebPort)" -ForegroundColor Cyan
    # `npm` resolves to npm.ps1 (a PowerShell script) on a stock Windows
    # install, and Start-Process calls CreateProcess directly -- which
    # cannot execute a .ps1 and fails with the deeply unhelpful "%1 is not
    # a valid Win32 application". npm.cmd sits right next to it and is a
    # real Windows executable wrapper; resolve and launch that instead.
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCmd) { Fail "npm.cmd not found. Is Node.js installed and on PATH?" }

    $webLog = Join-Path $log "web.log"
    Remove-Item $webLog -ErrorAction SilentlyContinue
    $web = Start-Process $npmCmd.Source -ArgumentList @("--prefix", "client-2", "run", "dev", "--", "--port", "$WebPort") `
        -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $webLog -RedirectStandardError (Join-Path $log "web.err")
    $procs += $web

    # Detect the bound port by CONNECTING to it, not by reading Vite's own
    # "Local: http://localhost:PORT/" banner out of the redirected log
    # file. Measured live, twice, with two different fixes in between:
    # the banner sat in the file -- correct, unchanged -- for well over
    # 45s after the server was already accepting real connections. That
    # is a buffering artifact, not a startup delay: Windows appears to
    # give a redirected-to-FILE child process's stdout a much less eager
    # flush than a redirected-to-PIPE one (a known libuv distinction), so
    # parsing the file for readiness was chasing the wrong signal
    # entirely. A bare TCP connect has no such lag -- confirmed against
    # the exact process this script spawns, mid-incident, before rewriting
    # around it.
    #
    # Vite can also silently move to the next free port instead of failing
    # when the one requested is already taken (documented in this repo's
    # own CLAUDE.md gotchas) -- hit live earlier in this exact debugging
    # session. Handled by trying $WebPort first, then scanning a few ports
    # above it, rather than by trusting either the value asked for or a
    # log line.
    function Test-PortOpen([int] $Port) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(400) -and $c.Connected
            $c.Close()
            return $ok
        } catch { return $false }
    }

    $realPort = $null
    $deadline = (Get-Date).AddSeconds(45)
    while (-not $realPort -and (Get-Date) -lt $deadline) {
        foreach ($candidate in @($WebPort) + @(($WebPort + 1)..($WebPort + 5))) {
            if (Test-PortOpen $candidate) { $realPort = $candidate; break }
        }
        if (-not $realPort) {
            Start-Sleep -Milliseconds 500
            if ($web.HasExited) { Fail "npm exited before it ever bound a port. See $webLog" }
        }
    }
    if (-not $realPort) {
        Fail "no port in $WebPort..$($WebPort + 5) ever accepted a connection within 45s. See $webLog"
    }
    if ($realPort -ne $WebPort) {
        Write-Host "  :$WebPort was already taken -- Vite moved to :$realPort instead" -ForegroundColor Yellow
    }

    # A fixed grace period BEFORE the first request, then slow polling.
    # Measured live: Vite prints "ready" before Nitro's dev server can
    # actually complete a first request -- something in its first-request
    # compilation path is still settling. Polling immediately and every
    # 800ms (the original interval) wedged it into a state that failed
    # EVERY subsequent request for 60+ seconds straight, confirmed by
    # curl calls run entirely outside this script against the same
    # process. A single request issued after Vite had a few seconds
    # undisturbed always succeeded on the first try. Slow, patient
    # polling avoids whatever the rapid-fire path breaks.
    Start-Sleep -Seconds 5
    $deadline = (Get-Date).AddSeconds(60)
    $up = $false
    while (-not $up -and (Get-Date) -lt $deadline) {
        try { Invoke-WebRequest "http://localhost:$realPort/" -TimeoutSec 8 | Out-Null; $up = $true }
        catch { Start-Sleep -Seconds 3 }
    }
    if (-not $up) { Fail "web app never answered on :$realPort. See $log\web.err" }
    Write-Host "  web app is serving on :$realPort"

    Write-Host "`n[5/5] opening the public tunnel" -ForegroundColor Cyan
    $publicUrl = Start-ServeoTunnel $realPort "web"

    Write-Host "`n────────────────────────────────────────────────" -ForegroundColor Green
    Write-Host " GUEST APP   $publicUrl/capture" -ForegroundColor Green
    Write-Host " CONSOLE     $publicUrl/console" -ForegroundColor Green
    Write-Host " RECAP       $publicUrl/recap" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────" -ForegroundColor Green
    Write-Host " First open of any page above shows a one-time serveo"
    Write-Host " 'Continue to Site' button (their free-tier interstitial,"
    Write-Host " not this app) -- one tap, then the real page loads."
    Write-Host " Paste the guest link into the console's PUBLIC URL field"
    Write-Host " before printing QR codes, or they will point at localhost."
    Write-Host "`n Ctrl+C to stop everything.`n" -ForegroundColor DarkGray

    while ($true) { Start-Sleep -Seconds 5 }
}
catch {
    # One clear line instead of PowerShell's exception spew. These are
    # nearly always "a prerequisite isn't ready", not a crash.
    Write-Host "`n  ! $($_.Exception.Message)`n" -ForegroundColor Red
}
finally {
    Write-Host "`nshutting down..." -ForegroundColor DarkGray
    foreach ($p in $procs) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    # Leave no stale VITE_CLUSTER_URLS behind: the tunnel URLs it names are
    # dead now, and a later command in THIS SAME TERMINAL would silently
    # inherit them otherwise. $env: assignments are real process
    # environment, not scoped to this script the way a normal PowerShell
    # variable would be -- they outlive the script unless removed here.
    Remove-Item Env:\VITE_CLUSTER_URLS -ErrorAction SilentlyContinue
    $certs = Join-Path $repo "client-2\certs"
    if (Test-Path "$certs.bak") { Move-Item "$certs.bak" $certs -Force }
    Write-Host "done.`n" -ForegroundColor DarkGray
}
