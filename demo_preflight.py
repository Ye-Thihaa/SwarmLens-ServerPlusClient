"""Pre-demo environment check. Run this BEFORE presenting, not during.

Every check here corresponds to something that has actually broken a run,
and each one fails in a way that looks like a different bug than it is:

  * A second OpenCV distribution shadowing the contrib build -- the
    saliency detector vanishes, and /analyze/preview 400s only for frames
    with no detectable face. On stage that reads as "the AI is broken",
    intermittently, depending on where the camera is pointed.
  * A dev cert that doesn't cover the LAN IP the venue's router handed
    out this morning. The laptop is fine; the phone gets a cert warning,
    and getUserMedia needs a secure context, so the camera silently never
    starts. This is the one that changes on demo day by itself.
  * Nodes up but not converged, or no Raft leader -- every distributed
    claim in the presentation is then unprovable.

Exit code is 0 only if nothing is FAIL. WARN means "know about this",
not "stop".
"""
import asyncio
import ipaddress
import os
import socket
import ssl
import sys

CLUSTER = ["http://127.0.0.1:8001", "http://127.0.0.1:8002", "http://127.0.0.1:8003"]
WEB = "https://127.0.0.1:8080"
CERT = os.path.join("client-2", "certs", "dev-cert.pem")

results: list[tuple[str, str, str]] = []


def record(level: str, name: str, detail: str = "") -> None:
    results.append((level, name, detail))
    print(f"  {level:4}  {name}" + (f"  -- {detail}" if detail else ""))


def check_ai_models() -> None:
    print("\n[AI engine]")
    needed = ["face_detection_yunet_2023mar.onnx", "vision_model_quantized.onnx",
              "text_model_quantized.onnx", "aesthetic_vit_b_32_linear.pth",
              "face_landmarker.task", "tokenizer.json"]
    missing = [f for f in needed if not os.path.exists(os.path.join("models", f))]
    if missing:
        record("FAIL", "model cache complete",
               f"missing {', '.join(missing)} -- first call downloads ~154MB")
    else:
        record("OK", "model cache complete", "no download needed at demo time")

    # The failure this whole script exists for. Two OpenCV distributions
    # (opencv-python and opencv-contrib-python*) unpack into the SAME cv2
    # directory; whichever resolves first wins, and the base build has no
    # cv2.saliency implementation. `import cv2` still succeeds, so nothing
    # complains until a frame with no face reaches the fallback path.
    try:
        import cv2  # noqa: PLC0415
        cv2.saliency.StaticSaliencySpectralResidual_create()
        record("OK", "cv2.saliency available", f"cv2 {cv2.__version__}")
    except Exception as exc:  # noqa: BLE001
        record("FAIL", "cv2.saliency available",
               f"{exc} -- see the OpenCV entry in CLAUDE.md's Gotchas")

    try:
        from importlib.metadata import distributions  # noqa: PLC0415
        installed = sorted(d.metadata["Name"] for d in distributions()
                           if (d.metadata["Name"] or "").startswith("opencv"))
        if len(installed) > 1:
            record("FAIL", "exactly one OpenCV distribution", f"found {installed}")
        else:
            record("OK", "exactly one OpenCV distribution", installed[0] if installed else "none")
    except Exception as exc:  # noqa: BLE001
        record("WARN", "OpenCV distribution check", str(exc))


def local_ips() -> set[str]:
    found = set()
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        found.add(info[4][0])
    return {ip for ip in found if not ip.startswith(("127.", "169.254."))}


def check_cert() -> None:
    print("\n[Phone access: dev cert]")
    if not os.path.exists(CERT):
        record("WARN", "dev cert present",
               f"{CERT} missing -- Vite falls back to HTTP and the phone camera won't start")
        return
    try:
        from cryptography import x509  # noqa: PLC0415
        cert = x509.load_pem_x509_certificate(open(CERT, "rb").read())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        covered = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
    except Exception as exc:  # noqa: BLE001
        record("WARN", "cert readable", str(exc))
        return

    import datetime  # noqa: PLC0415
    expiry = cert.not_valid_after_utc
    days = (expiry - datetime.datetime.now(datetime.timezone.utc)).days
    record("OK" if days > 0 else "FAIL", "cert not expired", f"{days} days left")

    mine = local_ips()
    uncovered = mine - covered
    if not mine:
        record("WARN", "LAN IP detected", "no non-loopback IPv4 found -- are you on Wi-Fi?")
    elif uncovered:
        record("FAIL", "cert covers this machine's LAN IP",
               f"{sorted(uncovered)} not in cert (has {sorted(covered)}) -- "
               f"regenerate before guests scan; see README")
    else:
        record("OK", "cert covers this machine's LAN IP", f"{sorted(mine)}")


def check_web_env() -> None:
    print("\n[Guest app / console config]")
    path = os.path.join("client-2", ".env")
    if not os.path.exists(path):
        record("FAIL", "client-2/.env present", "console login and operator calls need it")
        return
    keys = {line.split("=", 1)[0].strip()
            for line in open(path, encoding="utf-8")
            if "=" in line and not line.strip().startswith("#")}
    for key, why in [("CONSOLE_PASSWORD", "the /console password gate"),
                     ("OPERATOR_TOKEN", "operator-gated backend calls"),
                     ("VITE_NODE_URLS", "the phone's same-origin proxy to the nodes")]:
        record("OK" if key in keys else "WARN", f"{key} set", "" if key in keys else f"needed for {why}")


async def check_cluster() -> None:
    print("\n[Cluster]")
    import httpx  # noqa: PLC0415

    # trust_env=False: loopback traffic must never route through a system
    # proxy -- see CLAUDE.md's Gotchas, it breaks raft's timers outright.
    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
        health = []
        for url in CLUSTER:
            try:
                r = await client.get(f"{url}/health")
                health.append(r.json() if r.status_code == 200 else None)
            except Exception:  # noqa: BLE001
                health.append(None)

        up = [h for h in health if h]
        record("OK" if len(up) == 3 else "FAIL", "all 3 nodes answering", f"{len(up)}/3")
        if not up:
            return

        digests = {repr(h["digest"]) for h in up}
        record("OK" if len(digests) == 1 else "WARN", "nodes converged",
               "identical digests" if len(digests) == 1 else "still gossiping -- re-run in a few seconds")

        leaders = {h["raft"].get("leader_id") for h in up}
        leader = next(iter(leaders)) if len(leaders) == 1 else None
        record("OK" if leader else "FAIL", "single agreed Raft leader",
               f"leader={leader}" if leader else f"disagreement: {leaders}")

        partitioned = [h["node"] for h in up if h["gossip"]["partitioned"]]
        record("OK" if not partitioned else "WARN", "no leftover chaos partitions",
               "" if not partitioned else f"{partitioned} still partitioned -- POST /chaos/heal")

        events = {h["events"] for h in up}
        record("OK", "event log size", f"{sorted(events)}")

    print("\n[Guest app / console server]")
    async with httpx.AsyncClient(timeout=20.0, trust_env=False, verify=False) as client:
        for route in ["/capture", "/console", "/public", "/recap"]:
            try:
                r = await client.get(f"{WEB}{route}")
                record("OK" if r.status_code == 200 else "FAIL", f"GET {route}", f"{r.status_code}")
            except Exception as exc:  # noqa: BLE001
                record("FAIL", f"GET {route}", f"{type(exc).__name__} -- is the dev server up on 8080?")


async def main() -> int:
    print("SwarmLens pre-demo check")
    check_ai_models()
    check_cert()
    check_web_env()
    await check_cluster()

    fails = [r for r in results if r[0] == "FAIL"]
    warns = [r for r in results if r[0] == "WARN"]
    print(f"\n===== {len(results) - len(fails) - len(warns)} ok, {len(warns)} warn, {len(fails)} fail =====")
    for _, name, detail in fails:
        print(f"  FAIL  {name}  -- {detail}")
    return 1 if fails else 0


if __name__ == "__main__":
    ssl._create_default_https_context = ssl._create_unverified_context  # dev cert
    sys.exit(asyncio.run(main()))
