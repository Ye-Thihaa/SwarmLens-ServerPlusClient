# client-2 — guest app + operator console

Two separate applications that share one design system and nothing else:
no shared components, no shared data, no role flag. The only thing in
common is `src/styles.css`'s tokens.

- **Guest app** — used by many people on their own phones, one-handed,
  mid-event, often in low light. Real camera, offline outbox, live AI
  composition guidance, gallery, likes, public wall, end-of-event recap.
  Never shows system internals.
- **Operator console** (`/console`) — one person on a laptop feeding the
  room's display. Live Raft/gossip state, a node graph, hosted-event
  administration with printable QR cards, quorum reads, and chaos
  controls. Never shows a camera.

Both talk to the real three-node cluster in the repo root. There is no
mock data anywhere.

## Run it

The backend must already be running (see the repo root's README).

```sh
npm install
npm run dev -- --host
```

Defaults to `:8080`, but Vite silently moves to the next free port if
that one is taken — read the real port off the terminal output. `--host`
is what makes it reachable from a phone on the same network.

## Configuration

`client-2/.env` (gitignored; `.env.example` documents the shape):

| Key | Purpose |
|---|---|
| `CONSOLE_PASSWORD` | Password for the `/console` gate. Verified server-side; the route's loader checks it on every request, so an unauthenticated visitor's HTML never contains console data. |
| `OPERATOR_TOKEN` | Sent as `X-Operator-Token` on operator-gated backend calls. Read from `process.env` inside server functions, so it never reaches client JS. Must match the backend nodes' own `OPERATOR_TOKEN` if they set one. |
| `VITE_NODE_URLS` | Where the guest app looks for nodes. Unset means the absolute `127.0.0.1:8001-8003` URLs. Set to `/n1,/n2,/n3` when testing on a phone (see below). |

## Testing on a real phone

Three separate things have to be true, and each fails silently on its own:

1. `getUserMedia` needs a **secure context**, and only `localhost` is
   exempt — so over plain HTTP the app loads fine on a phone and simply
   has no camera. `vite.config.ts` enables HTTPS when `certs/dev-key.pem`
   and `certs/dev-cert.pem` exist (gitignored; generate them with the
   `openssl` command in that file's comments). The LAN IP must be in the
   cert's `subjectAltName` — browsers stopped honouring CN for host
   matching years ago.
2. An HTTPS page may not fetch `http://` URLs (mixed content).
3. `127.0.0.1` means *the phone* when the page is running on a phone.

The `/n1,/n2,/n3` proxy in `vite.config.ts` solves 2 and 3 together by
keeping the browser on one origin it already trusts. Point the guest app
at it with `VITE_NODE_URLS=/n1,/n2,/n3`. The console is deliberately
unaffected: it reads absolute cluster URLs, because `/chaos/partition`
indexes positionally into a specific node's own peer list.

## Where the real documentation is

This directory is one half of a distributed-systems project. The design,
the phase-by-phase build log, the endpoint reference and the accumulated
gotchas all live in the repo root:

- `../CLAUDE.md` — working notes, conventions, and every gotcha hit so far
- `../ROADMAP.md` — full design and phase-by-phase writeup
- `../README.md` — endpoint list and manual demo commands
