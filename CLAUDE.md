# SwarmLens backend

Three identical FastAPI nodes (`main.py`), each with its own SQLite file —
no shared database, no central authority. State converges by gossip.
Full design and phase-by-phase plan: [ROADMAP.md](ROADMAP.md). Endpoint
list and manual demo commands: [README.md](README.md).

## Files

- `main.py` — FastAPI app + all HTTP endpoints. Same file runs as every
  node; behavior is set entirely by env vars (`NODE_ID`, `DB_PATH`, `PEERS`,
  and now optionally `OPERATOR_TOKEN` — see below). `POST /photos` accepts
  an optional `image_base64`; gossip replicates it as part of the ordinary
  `photo` event payload (no second storage path), and `GET
  /photos/{photo_id}/image` serves the decoded bytes back out — kept as a
  separate endpoint so `GET /photos` (polled every few seconds by both
  guest clients) doesn't ship every photo's full image on every call;
  `store.photos()` strips `image_base64` back out of the list response for
  the same reason, and adds `taken_at` (already on the event as
  `created_at`, just not exposed until a client needed it for display).
  `POST /analyze/preview` is the live-viewfinder sibling of `/analyze`:
  same models, same `to_thread` offload, but it appends **no** events —
  a camera calls it every 1.5s against a frame that has no `photo_id` and
  was never shot, so persisting those would flood the log, gossip every
  one to all three nodes, and drag `/zones`' `avg_aesthetic` toward
  frames no guest kept. It is bounded by a `PREVIEW_CONCURRENCY`
  semaphore and sheds excess with 503 rather than queueing (guidance for
  a frame the guest already panned away from is worse than none), and
  caps the request body — measured at ~37ms/frame with `/health` staying
  under 10ms alongside it, so the asyncio loop and raft's 50ms heartbeat
  are unaffected.
  `/chaos/partition/{i}` and `/chaos/heal` are gated by
  `require_operator_token` (checks `X-Operator-Token` against
  `OPERATOR_TOKEN` with `secrets.compare_digest`) — fails open when
  `OPERATOR_TOKEN` is unset, so `test_quorum.py`, `load_test.py`, and
  `dashboard.html`, none of which set it, keep working unauthenticated.
  `client-2`'s operator console is the one real caller that sets it (see
  that entry below). `POST /photos/public` opts one of a guest's *own*
  photos into (or out of) the cross-guest public gallery — a curation
  cap (`PUBLIC_LIMIT_PER_GUEST = 25`), not the composited-strip "public
  album" `routes/album.tsx` already posts to zone `photo_booth` (see
  `client-2` below, and don't conflate the two — that confusion is what
  this feature replaced). Ownership is checked against the photo event's
  *own* `guest_id` (`store.photo_by_id`), never the caller-supplied one,
  so the cap can't be bypassed by mislabeling whose photo it is; the cap
  itself only blocks the *first* `public: true` past the limit — toggling
  an already-public photo back to `true` (a retry, a second device) is a
  no-op, not a 409. `GET /photos/public` is the derived read: every photo
  whose latest `public_mark` says `true`, same replay-the-log pattern as
  everything else, no second `is_public` column.
  **Multi-event hosting** ("hosted events" section, near the bottom of
  the file, right before the client API): the cluster hosts several
  events at once (a wedding and a donation ceremony the same weekend),
  and every derived read that touches photos takes an optional
  `event_id` query param so the two never merge — `GET /photos`, `GET
  /photos/public`, `GET /zones`, `GET /zones/local`, `GET /zones/ring`,
  `GET /zones/quorum`. `POST /events` registers (or, passing back an
  existing `event_id`, edits) one via an `event_created` event — no new
  table, gossiped and replayed exactly like a photo
  (`store.events_catalog`). It's gated by `require_operator_token`, the
  same gate as `/chaos/*`, and so is `GET /events` (the operator's own
  directory, join tokens included) — a guest app has no way to enumerate
  events, on purpose: a wedding's guests have no business listing the
  funeral booked the same weekend. A guest resolves exactly one event via
  `GET /events/{slug}?k=<join_token>` (`resolve_event`) — `k` is **not**
  authentication, the same non-guarantee as `GET /photos/public` needing
  no guest identity; it only stops a guest who mistypes or guesses a slug
  from landing in someone else's event, and the token is never echoed
  back in the response so a successful resolve doesn't hand out a
  shareable credential the scanner didn't already have. `PhotoIn` is the
  *only* request model carrying `event_id` (default
  `store.DEFAULT_EVENT_ID = "default"`, what every photo logged before
  this existed implicitly has) — a like, public mark, or delete all name
  a globally-unique `photo_id` and inherit that photo's event
  (`store.photo_by_id`), so event membership is recorded in exactly one
  place and a client can't push a like into a different event than its
  own photo by getting one field wrong. `ring_key(zone, event_id)`
  namespaces the consistent-hash key to `f"{event_id}/{zone}"` — without
  it, two events both naming a zone `"main"` would hash to one ring
  position, and `/zones` would proxy the wedding's `"main"` score from a
  node computing the donation's `"main"`; `event_id=None` (every caller
  that predates hosted events, including `test_hashing.py`) keeps the
  bare-zone key unchanged so existing ring assignments don't move.
  `_zone_scores_from_events` filters by `event_id` *after* the quorum
  merge, not on the wire in `GET /zones/events`, because a node can hold
  a `like` for a photo it hasn't gossiped-in yet — dropping it at the
  source on an unrelated technicality would lose a count the merge could
  still have resolved. The per-guest public-gallery cap
  (`PUBLIC_LIMIT_PER_GUEST`) is enforced *per event*, computed by
  intersecting `public_state()` against `store.photos(photo["event_id"])`
  — a guest who shoots at three weddings gets 25 public frames at each,
  not 25 total.
  **End-of-event recap** (`POST /recap/trigger`, `GET /recap`, both
  `event_id`-scoped): what happens when an event *ends*. The operator
  calls it over and `send_event_recap(event_id)` snapshots the
  `RECAP_TOP_N` (default 10) most-liked photos **into the `recap_sent`
  event's own payload** — a frozen list, not something `GET /recap`
  recomputes live on every read. That's the whole design choice: a like
  that lands after the host called it a wrap must not quietly reshuffle
  what "most memorable" meant at that moment, and a guest opening the
  slideshow a week later has to see the same reel as everyone else.
  Ranking is `(-likes, photo_id)` so the snapshot is deterministic even
  if two would-be leaders ever computed it independently. Exactly-once
  is unchanged from the original recap (only the Raft leader acts,
  idempotence re-checked against the *replicated log* via
  `store.recap_for`, which replaced `store.event_exists` — that function
  had no way to ask "for which event", and per-event recaps need one).
  `/recap/trigger` is gated by `require_operator_token` (ending an event
  is an operator decision); `GET /recap` is deliberately **not** — a
  guest coming back to relive the night is exactly who it's for, and it
  exposes nothing `GET /photos` didn't already.
  The snapshot freezes `RECAP_TOP_N` **plus `RECAP_SPARES`** photos and
  records each one's `blob_hash`. Both exist for production, not neatness:
  the spares let `GET /recap` drop a photo the guest later deleted and
  backfill from reserve, so a retraction costs the reel nothing instead of
  leaving a broken tile — **deletion outranks the freeze**, because a
  guest who retracts a photo has withdrawn consent and "the recap froze it
  first" is not an answer to that. The `blob_hash` is what pins those
  bytes (`store.pinned_hashes`), making them the ones `blob_sync`
  replicates first and the only ones `blob_archive` uploads. `GET /recap`
  reports `backfilled` and `exhausted` rather than silently serving a
  short reel.
  `GET /events` is paginated, newest first, carries a derived
  `status` (active/ended, from whether that event's recap has fired), and
  deliberately **omits `join_token`** — the console polls it every 5s, and
  the unpaginated version shipped every event ever hosted, each with the
  credential that opens it, on every poll. A token is fetched per event
  from `GET /events/{slug}/token` at the moment an operator prints one
  card.
- `blob_sync.py` — out-of-band replication for photo **bytes**, which
  deliberately do *not* ride the event log. Byte-budgeted
  (`BLOB_SYNC_BUDGET_BYTES`, default 8MB/round), one blob per request,
  recap-pinned blobs first, pull-only. Reuses `gossip`'s failure detector
  and partition set rather than keeping a second view of who's up.
  `fetch_from_peer` is the read-through `GET /photos/{id}/image` uses when
  this node has a photo's metadata but not yet its pixels — a real window
  now that the two replicate at different speeds, and a 404 there renders
  as a permanently broken image in both clients. See its module docstring
  for the measured failure that forced the split.
- `blob_archive.py` — leader-gated upload of recap-pinned blobs to
  Supabase Storage (`POST /blob_archive/trigger`, `GET
  /blob_archive/status`), disabled entirely unless `SUPABASE_URL` +
  `SUPABASE_KEY` are set. The object key **is** the blob's content hash,
  which is what makes a re-upload after a leadership change idempotent —
  same "let the destination be the dedup authority" reasoning as
  `cloud_sync.py`'s `UNIQUE(origin, seq)`. Only pinned blobs, not every
  frame every guest shot: archiving the whole roll is a cost decision
  nobody has made, and doing it by default would quietly turn a demo
  cluster into a storage bill.
- `store.py` — SQLite-backed append-only event log. All state (photos,
  likes, job leases, recap) is derived by replaying `events`, never
  written directly.
  **Photo bytes live in a separate `blobs` table, not in the log** —
  keyed by sha256, replicated by `blob_sync.py`, whose module docstring
  carries the measured reasoning (don't restate it here or in a third
  place). The rules that bind new code: never put a large payload in an
  event (it breaks gossip, see the Gotchas entry); strip legacy
  `image_base64` in **SQL** (`json_remove`) rather than a Python `.pop`
  after `json.loads` — `photos`, `photo_by_id` and `raw_events` all do;
  and `photo_image()` must keep serving **both storage generations**,
  because real databases hold pre-split rows and rewriting gossiped
  history to migrate them is a worse trade than one branch.
  `ensure_blob_for_photo` is how a legacy photo still gets archived: it
  materialises a blob and records the hash on the *recap* event, never by
  rewriting the photo event. `pinned_hashes()` derives the protected set
  from those recap events, never a flag column (see Gotchas).
  `events_missing_from` caps a batch by **bytes as well as rows**
  (`MAX_SYNC_BYTES`). `(origin, seq)` primary key makes merges idempotent.
  Each event also carries a `vclock` (JSON, envelope metadata like
  origin/seq — a guest device's `{device_id: counter}` clock, `{}` for
  internally-generated events with no device behind them) and `main.py`'s
  `GET /photos` uses it to compute `concurrent_with` per photo (see
  `_concurrent`/`_vclock_leq`) instead of implying a false total order
  from arrival time. `get_meta`/`set_meta` are node-local scratch state
  (like `local_seq`) — never gossiped, safe only for values it's fine to
  lose or recompute on a fresh process (`cloud_sync.py`'s checkpoint uses
  this — see its entry below for why that's still correct). `append_local`
  holds `self._write_lock` (an `asyncio.Lock`) around assigning the next
  seq + inserting — see the Gotchas section for the real concurrency bug
  this fixes. `photo_image_b64(photo_id)` is the read side of the
  image-sharing feature above — pulls straight from the same event row,
  no second table. `photo_by_id`/`public_state` back the public-gallery
  feature (`POST`/`GET /photos/public` in `main.py`, see below) — a new
  `public_mark` event kind, `{photo_id, guest_id, public}`, replayed the
  same last-write-wins way as `aesthetic_scores`, not a set-union CRDT
  like likes: a guest toggling their own photo is expected to converge on
  whichever toggle actually happened last, not be merged as a set.
  `photos(event_id=None)` filters by `payload["event_id"]` (defaulting
  missing values to `DEFAULT_EVENT_ID`) when given one, and returns every
  event's photos merged when not — every caller from before hosted
  events existed still gets that merged view for free. `events_catalog()`
  replays `event_created` into `event_id -> latest payload`, last write
  wins by created_at like `public_state` — except an edit (rename, venue
  change) carries its *original* created_at forward rather than the
  edit's own timestamp, so a later rename can't jump an event ahead of
  another one that claimed the same slug first (`main.py`'s
  `resolve_event` needs that ordering to pick a deterministic winner if
  two events ever raced on one slug during a partition). `recap_for(
  event_id)` returns one event's frozen top-liked snapshot and doubles as
  the exactly-once check `main.py`'s `send_event_recap` needs before
  appending a new one — it replaced the old `event_exists(kind)`, which
  could only answer "has *any* recap ever fired" and so would have let
  the first event's recap suppress every later event's. `raw_events` and
  `photo_by_id` both strip `image_base64` before returning — the former
  because it's what every `/zones/quorum` sample ships across the wire to
  every other node, and shipping pixels there turned a zone-score merge
  into a full gallery transfer once a node started holding several
  events' worth of photos, not just one.
- `gossip.py` — anti-entropy loop: every `GOSSIP_INTERVAL` (default 1s),
  pick one random peer, exchange version-vector digests, pull/push
  whatever's missing.
- `worker.py` — claims unclaimed jobs with an 8s lease, renews by
  heartbeat, another node reclaims it if the claimant dies. At-least-once,
  fine for idempotent work (photo enhancement).
- `raft.py` — leader election only (no log replication — the event log +
  gossip already do that). Used for exactly-once actions where at-least
  -once isn't safe (e.g. the one-time event recap notification).
- `hashing.py` — consistent-hash ring (100 virtual nodes per member) over
  the currently alive cluster. `GET /zones` in `main.py` uses it to route
  each zone to its one owning node instead of every node scoring every
  zone from its own replica.
- `GET /zones/quorum` (in `main.py`, no separate file — it's short
  enough to live next to the other zone endpoints) — samples `R` of `N`
  nodes at random, unions their raw photo/like/aesthetic_score events
  (`store.raw_events` / `GET /zones/events`) deduped on `(origin, seq)`,
  and recomputes scores from the merge. This is the CAP-tradeoff knob:
  `R` over `N/2` is always fresh, `R=1` can land on a stale/partitioned
  node.
- `ai_engine.py` — pretrained-only photo analysis (no training anywhere):
  **face-first** subject detection (`find_subject`: YuNet face detector,
  falling back to saliency when no face is present — saliency answers
  "what is visually unusual", which is not the same question as "what is
  this a photo of", and at an event it will box a bright lamp beside the
  guest; the response carries `subject_source` so callers can be honest
  about which ran, and `compute_reframe` sizes a face box with
  `FACE_SUBJECT_SHARE` so a portrait isn't cropped to a head shot), a rule-of-thirds AR reframe guide, CLIP
  film-stock suggestion, and a CLIP-embedding aesthetic score. Two entry
  points that differ in *persistence, not computation*: `analyze()` is the
  post-capture path whose `aesthetic_score` is written to the event log,
  and `preview()` is the live-viewfinder path (`POST /analyze/preview`)
  that computes strictly more — a subject box, a crop rectangle
  (`compute_reframe`), a dominant-colour read (`describe_scene`) and a
  templated recommendation sentence (`compose_reason`) — and writes
  nothing at all. `compute_ar_guide` returns `move_subject_*` *and* its
  inverse `pan_camera_*` explicitly, because a UI that renders the wrong
  one shows a confidently backwards arrow; it also reports `strength`
  bucketed off the real dx/dy magnitude so copy like "a little" tracks
  the measurement instead of being a fixed adverb. `FILM_STOCKS`' keys
  are a contract with `client-2/src/guest/data.ts` (rename one side alone
  and the recommendation silently stops matching anything), and each
  stock carries several short prompts that get ensembled — see the
  Gotchas entry on CLIP class priors for why one long prompt each did not
  work. Wired up as `POST /analyze` in `main.py`, which runs it on a thread (it's
  synchronous CPU-bound ONNX/OpenCV work — awaiting it directly would
  stall this node's asyncio loop, and gossip/raft both depend on that
  loop staying responsive). Models are downloaded on first use into
  `./models/` (gitignored, ~154MB) and cached after that:
  - faces: YuNet (`face_detection_yunet_2023mar.onnx`, ~230KB) from
    OpenCV Zoo. Must be fetched from `media.githubusercontent.com`, not
    `raw.` — the zoo keeps weights in Git LFS and the raw host returns a
    131-byte LFS *pointer* that loads as a corrupt model.
  - eyes-open / smiling: MediaPipe FaceLandmarker (`face_landmarker.task`,
    ~3.7MB). Runs only when YuNet already found a face, adding ~10ms;
    a no-face frame never pays for it. Uses the *blendshapes*
    (`eyeBlinkLeft/Right`, `mouthSmile*`) rather than a hand-rolled
    eye-aspect ratio — they're trained 0..1 outputs, so the thresholds
    are the model's own calibration. This is the capability YuNet's five
    landmarks fundamentally could not provide: one point per eye, its
    *centre*, which sits in the same place open or shut. Note mediapipe
    1.0 removed `mp.solutions.face_mesh`, so the Tasks API is the only
    route.
  - saliency: `cv2.saliency.StaticSaliencySpectralResidual` — ships in
    `opencv-contrib-python`, no download, classical CV.
  - filter suggestion + aesthetic embedding: CLIP ViT-B/32, int8-quantized
    ONNX export by Xenova of `openai/clip-vit-base-patch32`
    (huggingface.co/Xenova/clip-vit-base-patch32).
  - aesthetic score: LAION `aesthetic-predictor` v1's ViT-B/32 linear
    head (github.com/LAION-AI/aesthetic-predictor,
    `sa_0_4_vit_b_32_linear.pth`) — the *original* repo, not
    "improved-aesthetic-predictor" (that one is ViT-L/14 only, wrong
    embedding dimension for our ViT-B/32 CLIP). See `ai_engine.py`'s
    module docstring for the full reasoning and exact URLs.
  - the `aesthetic_score` event feeds `avg_aesthetic` into `/zones` and
    `/zones/quorum` the normal way (`store.append_local`, replicated by
    gossip) — see the Conventions section, no second source of truth.
- `cloud_sync.py` — leader-gated background loop (`POST
  /cloud_sync/trigger`, `GET /cloud_sync/status` in `main.py`, folded
  into `GET /health`) that pushes the event log to a Supabase/PostgREST
  -style endpoint, one-way and append-only. Disabled entirely (loop never
  starts) unless `SUPABASE_URL` is set — zero effect on any node that
  doesn't configure it. Reuses `store.events_missing_from()` — the exact
  primitive `gossip.py` already uses — treating "the cloud" as one more
  peer whose digest is tracked, except sync only pushes. The local sync
  checkpoint (`store.get_meta`/`set_meta`) is deliberately *not*
  replicated or authoritative — see the Gotchas section for why that's
  still correct across a Raft leadership change, not just convenient.
- `dashboard.html` — static chaos + metrics dashboard, served at `GET
  /dashboard` by every node (`main.py`, `FileResponse`). No build step,
  no external JS/CSS — polls `GET /health` on all 3 nodes every 1s and
  drives `/chaos/partition/{i}` and `/chaos/heal`. This is the lighter
  alternative from Phase 7's "Prometheus/Grafana vs. lighter" fork — see
  ROADMAP.md's Phase 7 writeup for why, and for a real bug (every button
  was broken) this caught by actually clicking through it in a browser.
- `load_test.py` — plain `asyncio` + `httpx` load test (no locust), spins
  up and tears down its own real clusters (1/2/3/4 nodes as needed),
  never mocks. Measures upload/like latency percentiles, convergence
  time, node-kill recovery time, leader re-election latency (20 trials),
  throughput vs. cluster size, and gossip bandwidth. `--quick` runs a
  fast reduced-scale version for validating the script itself. Outputs
  `results.json`/`summary.csv`/PNGs into `load_test_results/`
  (gitignored). Found and fixed a real concurrency bug in `store.py`
  (see the Gotchas section) — see the full writeup and numbers from a
  real run in ROADMAP.md's Phase 8 section.
- `client/` — Phase 5's guest client: React 19 + TypeScript PWA (Vite),
  Dexie.js offline `outbox`, `localStorage` vector clock, a service
  worker with a real Background Sync handler (`vite-plugin-pwa`,
  `injectManifest` strategy — needed for a custom `sync` event handler,
  which the default `generateSW` strategy doesn't support). A functional
  reference implementation proving the offline+causal-ordering mechanism,
  not the polished branded guest UI described elsewhere in the project's
  task list. Also has a working like button (`POST /likes`) and renders
  other guests' photos for real via `GET /photos/{id}/image` — falls back
  to a metadata-only placeholder, never a broken-image icon, for older
  captures with no `image_base64` attached. See `client/README.md` for
  the full stack breakdown and rationale, and the Phase 5 writeup in
  ROADMAP.md for what was verified live in a browser against the real
  backend.
- `client-2/` — the actual branded guest app + operator console (two
  separate apps sharing one design system), originally a Lovable-
  generated TanStack Start scaffold with zero backend calls anywhere
  (static bundled images standing in for the camera, fake
  `killLeader()`/`partition()` client state) — now fully wired to the
  real cluster, closing the gap `client/`'s entry above used to describe
  as unattached. See the "Branded guest app + operator console" writeup
  in ROADMAP.md for the full list of what got wired and the real bugs
  found doing it. Highlights:
  - `src/lib/api.ts` — the node-picking/fetch client (same "race
    `/health`, use whichever answers first" pattern as `client/src/nodes.ts`).
    Every read that takes an `event_id` types it `string | undefined` and
    makes the parameter **required** (not optional) — required so no call
    site can silently forget it exists, `| undefined` so the one
    legitimate caller that wants every event merged (the operator
    console's overview) can ask for that on purpose. Every guest route
    always passes a real event_id from `lib/event.ts`; only
    `routes/console.tsx` ever passes `undefined`.
  - `src/lib/event.ts` — which hosted event this phone joined, mirroring
    `guest.ts`'s SSR-safe localStorage pattern (`useCurrentEvent()` is a
    `useSyncExternalStore` hook with the same cached-snapshot discipline
    as `outbox.ts`'s `useOutbox()` — see the Gotchas entry on that).
    `DEFAULT_EVENT` is what every guest screen renders before a QR is
    ever scanned (including during SSR, where localStorage doesn't
    exist) — it mirrors `store.py`'s `DEFAULT_EVENT_ID` and the single
    demo room this app always had, not an empty state. `joinEvent()` is
    the only writer, called once by `routes/join.$slug.tsx` after a
    resolve succeeds.
  - `src/routes/join.$slug.tsx` — where a scanned QR actually lands:
    `/join/{slug}?k={join_token}` (see `main.py`'s `GET
    /events/{slug}`). Resolves once against whichever node answers
    first, stores the result via `joinEvent()`, and pushes the guest into
    `/capture`. Retries on a 3s timer rather than failing once — both
    real failure modes here (no node up yet, or this node hasn't
    gossiped-in the `event_created` row the QR points at) are routine and
    transient, and a guest standing at the door shouldn't have to
    manually refresh.
  - `src/routes/capture.tsx`'s zone strip only renders when the joined
    event actually has more than one zone (`event.zones.length > 1`) —
    most events are one location, and asking every guest to classify
    their own position on every shot was both work and a question they
    usually can't answer well. The zone itself never disappears from the
    photo payload; it still drives the consistent-hash ring, `/zones`,
    and quorum reads exactly as before — only the picker UI is
    conditional. The override is stored separately from the derived
    `zone` value and dropped the instant it stops being one of the
    *current* event's zones, so switching events mid-session can't leave
    a guest silently tagging frames with a zone the new room never
    declared.
  - `src/routes/console.tsx`'s **Hosted events** panel is where an
    operator actually creates/edits events and prints their QR cards —
    `serverCreateEvent`/`serverListEvents` in `lib/operatorGateway.ts`
    follow the exact same shape as the chaos actions (session re-checked
    server-side, `OPERATOR_TOKEN` read from `process.env`, never touches
    client JS). Selecting an event here scopes the room-stats/aesthetic
    -map/quorum panels below it to that one event; the default
    (`undefined`) merges every event, the only view that existed before
    this feature did. `src/lib/qr.ts` wraps the `qrcode` package's
    `toString(..., {type:"svg"})` path deliberately — it does its own
    matrix generation in pure JS with no `<canvas>`, so the same call
    works during SSR and the output stays crisp at any print size, unlike
    a canvas/PNG raster which goes blocky at table-card scale. The
    **PUBLIC URL FOR PRINTED QR CODES** field defaults to the console's
    own origin and warns when that's `localhost`/`127.0.0.1` — the
    console runs wherever the operator's laptop is, but the QR has to
    point at wherever a *guest's phone* can actually reach the cluster,
    the same LAN-IP-vs-localhost distinction the camera/HTTPS gotcha
    below already has to solve for a different reason.
  - `src/lib/outbox.ts` — offline photo/like queue, localStorage-backed
    (this app has no Dexie yet, unlike `client/`) — `useOutbox()` is a
    `useSyncExternalStore` hook; see the Gotchas entry on caching its
    snapshot. `OutboxPhoto.event_id` is captured once, at queue time, from
    whichever event the guest was actually standing in when the shutter
    fired — never re-read from the *current* joined event when the item
    finally syncs. That distinction is the whole point of the field: a
    guest shooting offline at a wedding who then walks into the next room
    and scans that event's QR would otherwise have their queued wedding
    frames sync straight into the second event once connectivity
    returned — visible to a roomful of strangers, not a cosmetic bug.
    `photosForEvent()` is the one place every guest screen filters the
    outbox down to "this event's photos", so the `event_id ?? "default"`
    fallback for rows queued before this field existed lives in one spot
    instead of four.
  - `POST /analyze` fires automatically after each photo syncs (see
    `outbox.ts`) — the first time either client has actually exercised
    `ai_engine.py`'s aesthetic pipeline instead of leaving it dark.
  - `src/routes/capture.tsx` also runs a live **AI compose** overlay
    before the shutter: a 1.5s loop posts a 224px frame to
    `/analyze/preview` and draws the subject box, the crop rectangle with
    its zoom factor, a camera-move instruction, and the recommendation
    sentence. `grabPreviewFrame()` center-crops the video to the selected
    ratio before sending — a correctness requirement, not bandwidth
    thrift, since the returned rects are normalized to whatever frame was
    sent and get painted straight onto the displayed video box. Every
    element is gated on the engine actually having found something
    (`subject_found`, `worth_it`, `confident`), and the whole overlay
    goes silent — not stale — when no node answers, since capture and the
    outbox are local and a partition should cost a guest advice, never a
    photo.
  - `src/routes/public.tsx` — the cross-guest **public gallery**: every
    photo any guest has opted in via the `MAKE PUBLIC` toggle on
    `routes/mine.tsx` (up to `PUBLIC_LIMIT_PER_GUEST` each, enforced
    server-side — see `main.py` above), open to anyone with the URL, no
    guest identity required to look. This is deliberately a *different*
    feature from `routes/album.tsx`'s "POST TO PUBLIC ALBUM" (composited
    strips tagged zone `photo_booth`) — the two were getting conflated
    under one name, and this route exists specifically so "make this
    public" can mean one hand-picked raw photo, not a whole composed
    strip. Layout mimics a real gallery-wall print sheet (asymmetric
    clusters of differently-sized rectangles, not a uniform grid): each
    tile's column/row span comes from `tileFor()`, an FNV-1a hash of the
    photo's own `photo_id` fed through weighted buckets (mostly 1×1/1×2,
    a few 2×2, rare 2×3/3×3 "anchor" tiles) into a `grid-auto-flow: dense`
    CSS grid — deterministic per photo, so the wall doesn't reshuffle
    itself on every 4s poll just because a photo further down the sorted
    order arrived; a real RNG seeded once per mount would do that this
    doesn't need. Tapping a tile opens a lightbox with a `DOWNLOAD`
    button (`fetch` → `blob` → object URL → synthetic `<a download>`,
    same pattern as `album.tsx`'s `downloadCanvas`) so a non-guest can
    take the image without needing the strip-maker.
  - `src/routes/mine.tsx`'s public toggle (`MAKE PUBLIC` / `★ PUBLIC` per
    photo card) polls `GET /photos/public` filtered to this guest's own
    `guest_id` for the live `x / 25` count — server state, not purely
    optimistic, so a toggle made from a second device still shows up
    here. A 409 from the cap surfaces as an inline message rather than a
    thrown error; only synced photos (real `photo_id`) show the button at
    all, since an unsynced local capture has nothing on the cluster yet
    for a `public_mark` event to reference.
  - `src/routes/recap.tsx` — the guest-facing **end-of-event slideshow**:
    the frozen top-liked reel for whichever event this phone joined (see
    `GET /recap` above), auto-advancing every 4s with tap-to-pause and
    PREV/NEXT/dot controls. Polls every 5s rather than fetching once, so
    a guest who opens the tab *before* the host ends the event sees it
    come alive on its own — same "no manual refresh" reasoning as
    `routes/join.$slug.tsx`'s retry timer. `ready: false` renders a
    "check back later" state, never an error: an event that hasn't ended
    yet is the normal case, not a failure.
  - `src/routes/console.tsx`'s **END EVENT & FREEZE RECAP** button (per
    event, in the Hosted events panel) is the operator side of that —
    `serverTriggerRecap` in `lib/operatorGateway.ts`, broadcast to every
    node like the chaos actions since the operator doesn't know which one
    holds Raft leadership, and only the leader's call appends anything.
    The button flips to `RE-CHECK RECAP` with a `RECAP READY · n PHOTOS
    FROZEN` line once it's fired.
  - `src/guest/ui.tsx`'s `GuestTabs` grew a 4th and 5th tab (`Public` →
    `/public`, `Recap` → `/recap`) alongside Camera/My roll/The room, for
    discoverability from anywhere in the guest app.
  - `src/routes/console.tsx` — the operator console: real Raft
    term/role and gossip/partition state polled from all 3 nodes, an
    event tape built from *observed state diffs* (term changes, peer
    reachability flips) rather than scripted log lines, and chaos
    actions relabeled honestly — "Isolate the leader", not "Kill", since
    partitioning doesn't force a re-election (`/chaos/partition` only
    stops gossip; raft's heartbeats bypass it entirely, same gotcha as
    below).
  - `src/lib/consoleAuth.ts` — real password gate on `/console`: a
    TanStack server function verifies the password server-side and
    issues an HttpOnly session cookie; the route's `loader` checks it on
    every request including the first SSR render, so an unauthenticated
    visitor's HTML never contains the console's data.
  - `src/lib/operatorGateway.ts` — chaos actions route through server
    functions (not straight from browser to FastAPI backend like the
    read-only calls in `api.ts` still do), so `main.py`'s
    `OPERATOR_TOKEN` is read from `process.env` server-side and never
    has to touch client JS. Also re-checks the console session itself,
    on every call — a `beforeLoad` route guard alone doesn't protect a
    server function, since it's reachable independently of the route
    that happens to call it.
  - `client-2/.env` (gitignored; `.env.example` documents the shape)
    holds `CONSOLE_PASSWORD` and `OPERATOR_TOKEN`.

## Run it

Three terminals, from this directory:

```bash
NODE_ID=node1 DB_PATH=./node1.db SELF_URL=http://127.0.0.1:8001 PEERS=http://127.0.0.1:8002,http://127.0.0.1:8003 uvicorn main:app --port 8001
NODE_ID=node2 DB_PATH=./node2.db SELF_URL=http://127.0.0.1:8002 PEERS=http://127.0.0.1:8001,http://127.0.0.1:8003 uvicorn main:app --port 8002
NODE_ID=node3 DB_PATH=./node3.db SELF_URL=http://127.0.0.1:8003 PEERS=http://127.0.0.1:8001,http://127.0.0.1:8002 uvicorn main:app --port 8003
```

`SELF_URL` must be the address peers reach this node at (i.e. it's the
one that appears in *their* `PEERS` lists) — see the Gotchas section.

Or `docker compose up --build` (nodes land on :8001-8003).

Guest client (needs the backend already running): `cd client && npm
install && npm run dev` — Vite dev server on :5173, talks to
`localhost:8001-8003` by default (override with `VITE_NODE_URLS`). A
`.claude/launch.json` entry (`swarmlens-client`) is already set up for
`preview_start` if driving it through the Browser tool.

Branded guest app + operator console (also needs the backend running):
`npm --prefix client-2 run dev -- --host`. Defaults to :8080, but Vite
auto-increments if that's taken — check the terminal output for the
real port, especially if an old instance from a previous session is
still holding it (see the Gotchas entry on this). `client-2/.env`
(gitignored, already present locally) holds `CONSOLE_PASSWORD` and
`OPERATOR_TOKEN`; to actually enforce the latter, the backend nodes
above need the matching `OPERATOR_TOKEN` env var set too (optional —
`/chaos/*` fails open without it). A `.claude/launch.json` entry
(`swarmlens-client-2`) is set up for `preview_start`.

Tests (all the cluster-spinning ones call `testutil.ensure_safe_to_run()`
first, which refuses to start if ports 8001-8003 are busy or `node*.db`
already exists — they delete those files on the way out, and they are the
same paths the demo cluster uses):
- `python test_raft.py` — spins up 3 nodes itself, confirms leader
  election, `kill -9`s the leader, confirms re-election + exactly-once
  recap. Self-contained, cleans up its own processes and `.db` files.
- `python test_hashing.py` — pure unit test of `hashing.py`'s ring, no
  running nodes needed. Confirms the mapping is deterministic and that
  adding a 4th node to a 3-node ring remaps ~1/4 of zones, not all of
  them.
- `python test_quorum.py` — spins up 3 nodes, fully (bidirectionally)
  partitions one, confirms `R=1` quorum reads sometimes return stale
  data from the partitioned node while `R=2` never does, then heals and
  confirms `R=1` goes back to reliably fresh. Self-contained like
  `test_raft.py`.
- `python test_ai_engine.py` — spins up 3 nodes, posts synthetic images
  crafted to have an unambiguous right answer (an off-center circle for
  the AR guide, a sunset gradient vs. flat gray for filter suggestion),
  confirms the AR guide direction and that suggested_filter actually
  differentiates, then confirms the resulting `aesthetic_score` event
  count matches on all three nodes' own `.db` files after a gossip
  round. First run downloads ~154MB of models into `./models/`
  (gitignored) — cached after that, budget extra time for a cold run.
- `python test_ai_preview.py` — spins up one node and exercises `POST
  /analyze/preview`: subjects at six known positions must produce the
  direction computed independently from the truth (including 0.28 and
  0.72, the modestly-off-centre cases a centre-biased detector flips),
  `move_subject_*` and `pan_camera_*` must stay exact opposites, the
  endpoint must persist **no** events, and the input guards must return
  413/400. Written after both of this endpoint's real bugs reached a
  phone.
- `python test_vclock.py` — spins up 3 nodes, simulates a couple of
  guest "devices" attaching `{device_id: counter}` clocks directly to
  `POST /photos` (no real guest client exists to generate these yet),
  confirms `concurrent_with` matches the actual causal structure (mutual
  concurrency for independent devices, no false concurrency once one
  clock causally dominates another, never concurrent for a bare photo
  with no vclock), and confirms it all survives gossip replication.
- `python test_cloud_sync.py` — spins up 3 nodes plus a tiny in-process
  fake-cloud HTTP server (no real Supabase project exists for this repo)
  that dedups on `(origin, seq)` the way a real unique constraint would.
  Confirms the cluster keeps working while the fake cloud isn't
  listening ("no internet"), `/cloud_sync/trigger` fails softly instead
  of 500ing, the full backlog syncs in one push once it starts listening
  ("reconnect"), a no-op re-trigger creates no duplicates, a new event
  afterward syncs incrementally, and only the Raft leader ever pushes.
- `python test_events.py` — spins up 3 nodes, creates two hosted events
  (on two *different* nodes, deliberately, so the create-and-gossip path
  gets exercised, not just create-and-read-locally) that both declare a
  zone named `"main"`, and confirms: the catalog replicates to a node
  that created neither; a duplicate slug is rejected even from a node
  that only learned it by gossip; `GET /events/{slug}?k=` resolves with
  the right token, 404s on a wrong or missing one, and never echoes the
  token back; `GET /photos`/`GET /zones`/`GET /zones/quorum` (at R=1, 2,
  and 3) never mix the two events' data despite the shared zone name;
  `ring_key`'s namespacing actually spreads that shared zone name across
  multiple ring owners instead of one; the per-guest public-gallery cap
  fires within one event and is untouched in the other; and a photo
  logged with no `event_id` at all (simulating pre-hosted-events data)
  stays reachable under `"default"` throughout. `PUBLIC_LIMIT_PER_GUEST`
  is env-overridable specifically so this test can drive the cap to its
  edge in 3 requests instead of 26.
- `python test_recap.py` — spins up 3 nodes and proves the end-of-event
  recap is genuinely *frozen*, not a live query wearing a snapshot's
  name: posts 5 photos with distinct like counts, triggers, then piles 6
  more likes onto the lowest-ranked photo (enough to make it the most
  liked overall) and confirms `GET /recap` is byte-identical afterward.
  Also covers ranking by likes, the `RECAP_TOP_N` cap (driven to 3 via
  the env var, same trick `test_events.py` uses for the public cap),
  not-ready-before-trigger returning an empty list rather than a 404,
  replication to a node that read it nowhere else, an idempotent
  re-trigger, two events' recaps staying isolated, that the recap pins
  its blobs (the check that caught the local-vs-replicated pinning bug),
  and that a photo deleted after the freeze leaves the reel while a spare
  backfills in rank order — including that its bytes stop serving too.
- `python test_blobs.py` — spins up 3 nodes and proves photo bytes are
  really out of the log and really replicate without it: the photo event
  is asserted to be a few hundred bytes of metadata with a `blob_hash`
  matching the sha256 of the uploaded bytes and **no** `image_base64`
  anywhere in any node's log; a node that lacks the blob reads through to
  a peer instead of 404ing; the blob reaches all 3 nodes on `blob_sync`'s
  own path within 25s; identical bytes dedup to one blob; and a
  legacy inline-base64 row written straight into the DB still serves.
- `python demo_preflight.py` — not a test of the code, a check of the
  *machine* before presenting: model cache present, exactly one OpenCV
  distribution with a working `cv2.saliency`, the dev cert unexpired and
  covering this machine's current LAN IP (the one thing that changes by
  itself when you connect to a venue's Wi-Fi), `client-2/.env` populated,
  all 3 nodes answering with identical digests and one agreed Raft leader,
  no leftover chaos partitions, and every guest/console route rendering.
  Read-only — safe against the live demo cluster, unlike the `test_*.py`
  scripts, which delete `node*.db`.
- `python load_test.py [--quick]` — not a pass/fail test, a measurement
  script. Spins up and tears down its own real clusters, fires real
  concurrent traffic, reports p50/p95/p99 latency, convergence time,
  node-kill recovery time, 20-trial election latency, throughput at
  N=1..4, and gossip bandwidth. `--quick` uses reduced counts to
  validate the script fast; full mode (the spec'd 200 uploads/500
  likes/20 trials) takes a few minutes. See ROADMAP.md's Phase 8 section
  for numbers from a real run and two real bugs this caught (one in
  `store.py`, one in the load test's own recovery-measurement logic).
- No test file yet for gossip/worker phases — those were verified
  manually per the curl sequences in README.md. Same for the live
  `/zones` ownership/proxy/stale-fallback behavior — verified manually
  (see the Phase 3 writeup in ROADMAP.md for what was checked).

## Current status

All of Phases 0-8 are done (gossip replication, worker leases, Raft
election, consistent-hash zone ownership, quorum reads, vector clocks —
backend *and* a working guest client in `client/` — cloud archive sync,
chaos/metrics dashboard, load test), plus the AI analysis engine
(`ai_engine.py`, `POST /analyze`) that sits outside the phase numbering.
See ROADMAP.md for the full phase-by-phase writeup, including two real
bugs Phase 8's load test found (one in `store.py`, described in the
Gotchas section below), the actual measured numbers, and what was
verified live in a browser for the guest client.

Also done, and also outside the phase numbering: the *actual* branded
guest app + operator console now live in this working directory
(`client-2/`, added mid-project) and are fully wired to the real
backend — real camera capture, real gallery/likes/heatmap, a real
operator console (Raft/gossip state, chaos actions, quorum reads), and
a real password gate on `/console` plus an optional backend
`OPERATOR_TOKEN`. See the "Branded guest app + operator console"
writeup in ROADMAP.md for what was built, the real bugs found wiring
it up, and what's still a known simplification (a localStorage outbox
instead of `client/`'s Dexie/service-worker one).

Also done: **multi-event hosting** — the single-"room" simplification
above no longer applies. One cluster now hosts several events at once
(`POST`/`GET /events`, `GET /events/{slug}?k=`), every derived read that
touches photos is event-scoped, the consistent-hash ring is namespaced
per event so identically-named zones on two events never collide, a
guest joins by scanning a QR (`client-2`'s `/join/$slug` route) rather
than picking from a directory the app deliberately can't show them, and
the operator console has a **Hosted events** panel to create events and
print their QR cards. See the "Multi-event hosting" section in
[README.md](README.md) for the endpoint shapes and demo commands, and
`python test_events.py` for the automated isolation proof.

Also done: **the end-of-event recap** — what happens after an event
finishes, which until now was a bare `recap_sent` flag no client read.
An operator ends an event from the console and the cluster freezes that
event's `RECAP_TOP_N` most-liked photos into the `recap_sent` payload;
guests replay it anytime afterward as a slideshow at `/recap`. Frozen
deliberately, not recomputed live — see the `main.py` entry above for
why, and `python test_recap.py` for the proof that later likes don't
move it.

## Gotchas hit so far (don't reintroduce these)

- **Raft heartbeat must be well under the election timeout, not over
  it.** The original spec numbers (150-300ms election timeout, 1s
  heartbeat) were backwards — a follower would time out before the
  leader's next heartbeat ever arrived. Heartbeat is 50ms in `raft.py`.
- **Per-RPC timeout in `raft.py` must also be well under the election
  timeout.** `asyncio.gather` waits for every peer including dead ones;
  if a single dead-peer connection attempt takes close to (or longer
  than) the election timeout to fail, every election round stalls long
  enough for a competing candidate to win the race first — a permanent
  two-node livelock, not just a slow election. Keep `RPC_TIMEOUT` short
  (currently 50ms).
- **Exactly-once actions gated on `raft.role == "leader"` must not
  double-fire across a leader crash.** Don't tie the action to the
  moment of *becoming* leader (that fires on every election, including
  ones after the action already happened). Instead, gate an explicit
  one-time trigger and make the action itself idempotent by checking the
  replicated event log (see `store.recap_for` / `send_event_recap` in
  `main.py`), not local in-memory state — local state doesn't survive
  the crash and isn't shared across nodes.
- **...but a repeated, ongoing sync (not a one-time trigger) can safely
  use a local, non-replicated checkpoint, IF the destination is itself
  idempotent.** `cloud_sync.py`'s "what has the cloud already got"
  checkpoint lives in `local_meta` (`store.get_meta`/`set_meta`) —
  node-local, never gossiped, gone if that node dies. That's fine here,
  unlike the recap case above: if Raft leadership moves to a different
  node, the new leader's checkpoint doesn't know what the old leader
  already pushed, so it just resends that overlap — and the Supabase
  table's `UNIQUE(origin, seq)` constraint (`Prefer:
  resolution=ignore-duplicates`) silently drops it. Correct, if wasteful
  once. The dividing line: gate a *single, one-time* action on the
  replicated log (recap); a *repeated, resumable* push can trust local
  state as long as the far end dedups on the same key gossip already
  uses.
- **A node's ring identity must match how its peers already address it,
  not `NODE_ID`.** Peers only know each other by the URLs in `PEERS` —
  they never learn each other's `NODE_ID`. If a node computed its own
  ring membership using `NODE_ID` while every peer's entry was a URL,
  each node ends up hashing a *different* set of member strings for the
  same physical cluster, so `owner_of(zone, ring)` disagreed node to
  node — confirmed live, `bar`'s owner differed between node1 and node2.
  Fixed with `SELF_URL` (`main.py`'s `SELF_ID`), which must be set to the
  address this node's peers reach it at. If you add another feature that
  builds a member list from `gossip.alive_peers()` plus self, use
  `SELF_ID`, not `NODE_ID`.
- **`POST /chaos/partition/{i}` only stops *this* node from initiating
  gossip toward `PEERS[i]` — it does not block the receiving end.** A
  partitioned peer can still successfully call *your* `/gossip/sync` and
  `/gossip/push` and pull/push data that way, so a one-sided partition
  self-heals within a gossip round or two instead of holding. To
  actually isolate a node for a test (see `test_quorum.py`), partition
  it in both directions from every other node: each of the other nodes
  must stop initiating toward it, *and* it must stop initiating toward
  each of them — 4 calls total to isolate one node in a 3-node cluster,
  not 1.
- **Any synchronous, CPU-bound call (ONNX inference, OpenCV, ...) in a
  route handler must be offloaded with `asyncio.to_thread`, never
  awaited directly.** This process has exactly one asyncio event loop,
  and gossip's anti-entropy round and raft's 50ms heartbeat/election
  timers both run as tasks on it. A multi-second synchronous call inside
  a request handler (e.g. `POST /analyze`, see `ai_engine.py`) blocks
  that whole loop for its duration — on any node still holding
  leadership, that's long enough to miss heartbeats and get voted out by
  a follower that never actually lost contact.
- **Aesthetic-predictor checkpoints are keyed to a specific CLIP
  backbone's embedding dimension, and the commonly-cited repo only
  covers one of them.** LAION's "improved-aesthetic-predictor" ships
  ViT-L/14 (768-dim) heads only; using it with ViT-B/32 (512-dim)
  embeddings is a shape mismatch, not a "close enough" approximation.
  The *original* `LAION-AI/aesthetic-predictor` repo has both `vit_b_32`
  and `vit_l_14` linear heads — `ai_engine.py` uses the B/32 one to
  match the B/32 CLIP backbone used for filter suggestion (so the
  aesthetic head can reuse that embedding instead of re-running a second,
  larger CLIP model just for one score).
- **`store.append_local`'s "read the seq counter, +1, write it back" is
  a race unless it's a single critical section.** It spans an `await`
  (`SELECT` ... compute ... `UPDATE`), so two concurrent calls can both
  read the same counter value before either writes back, both assign the
  same `seq`, and collide on `events`' `(origin, seq)` UNIQUE constraint.
  Every test/demo in this repo only ever awaited one write at a time
  until `load_test.py` fired genuinely concurrent requests — 200 uploads
  at one node threw `sqlite3.IntegrityError` reliably. Fixed with
  `Store._write_lock` (`asyncio.Lock`) around the whole "assign next seq
  + insert" section in `append_local`. If you add another code path that
  writes local events, it must go through `append_local`, not reimplement
  its own seq assignment.
- **A system-wide loopback-intercepting proxy breaks Raft's 50ms
  heartbeat/150-300ms election timeout outright, and `trust_env=False`
  can't fix it.** Confirmed on a dev machine with Windows' system proxy
  enabled (`HKCU:\...\Internet Settings`, `ProxyEnable=1`) pointing at
  `127.0.0.1:<port>` — even a bare `GET /health` on a single node measured
  ~500-900ms median round-trip on loopback, vs. the sub-millisecond
  latency Raft's timers assume. `trust_env=False` (see the note above)
  only stops httpx from *choosing* to route through a configured proxy;
  it can't defeat something intercepting sockets below the application
  layer. Symptom: `test_raft.py`/`test_quorum.py`/`test_cloud_sync.py`
  see leadership flip continuously, not just at boot, and
  `test_cloud_sync.py`'s leader-targeted calls land on a stale leader.
  No code fix applied for this — the two real options are disabling the
  intercepting proxy for the test run, or raising `raft.py`'s timing
  constants (which would also slow down every number in ROADMAP.md's
  Phase 8 section, so don't do that silently). If you hit flaky
  leader-dependent tests, check for this before assuming a code
  regression.
- **A load-test measurement that detects state via one "observer" node
  is measuring gossip lag, not the thing it's trying to measure.** The
  first version of `load_test.py`'s recovery measurement polled a single
  node to detect when a job got claimed, then killed the claimant. A
  node's own writes are visible to *itself* instantly; to an observer,
  only after the next gossip round. That gap was large enough that the
  claimant sometimes finished its whole 5-second fake-work window before
  the kill signal landed — silently measuring "did the worker finish
  before I noticed and killed it" (suspiciously exactly 5.0s) instead of
  a genuine kill-mid-work scenario. Fixed by polling all nodes directly
  and in parallel, catching the claim via the claimant's own zero-lag
  self-report. If you write another measurement that needs to catch a
  node in a specific state fast, poll every node, not one.
- **`pydantic==2.10.4` (the old pin) has no Python 3.14 Windows wheel,
  and every internal `httpx` client defaults to trusting a system
  proxy.** Two separate environment gotchas that both surfaced only once
  someone actually tried running this on a real Windows machine (not
  this dev sandbox): (1) `pydantic-core` only ships a `cp314-win_amd64`
  wheel from 2.40.0 onward -- older pins force pip to compile from
  source via Rust + the MSVC linker, which fails without Visual Studio
  Build Tools installed. Fixed in `requirements.txt` with an explicit
  `pydantic-core>=2.40` floor (pydantic's own version number doesn't
  track pydantic-core's, so constraining only `pydantic` isn't enough).
  (2) `httpx`'s default `trust_env=True` means any client honors
  `HTTP_PROXY`/system proxy settings -- on a machine with one configured
  that doesn't exempt loopback traffic, every 127.0.0.1-only call in
  this codebase (gossip, raft, the `/zones` proxy calls, every test
  script, `load_test.py`) intermittently 502s / connection-resets /
  returns empty bodies. Every client that *only* ever talks to
  127.0.0.1 now hardcodes `trust_env=False`. The two exceptions that
  must NOT get this: `ai_engine.py`'s model downloader and the `/analyze`
  endpoint's photo-`url` fetch (both may need to reach the real
  internet), and `cloud_sync.py`'s client (must honor a real proxy to
  reach a real Supabase in production) -- its trust setting is
  controlled by `CLOUD_SYNC_TRUST_ENV` instead, which `test_cloud_sync.py`
  flips to `false` only because its "cloud" is a local fake server.
- **Two OpenCV distributions in one environment silently disable
  `cv2.saliency`, and `import cv2` still succeeds.** `opencv-python` and
  `opencv-contrib-python*` unpack into the *same* `cv2` package directory,
  so installing both leaves whichever resolves first in charge — here a
  stray `opencv-python 4.14` (pulled in as a dependency of an unrelated
  package in the same interpreter, `ultralytics`, which this project does
  not use) shadowed the pinned `opencv-contrib-python-headless 5.0.0.93`.
  `cv2.saliency` still *exists* as an attribute, so nothing fails at
  import; `StaticSaliencySpectralResidual_create` is simply absent, and
  `POST /analyze/preview` 400s. Crucially it only 400s for frames where
  YuNet finds **no face** and `find_subject` falls back to saliency — so
  a phone pointed at a person works and the same phone pointed at the
  room doesn't, which reads as a flaky AI rather than a missing module.
  Fix is a clean swap, not an add: uninstall *every* `opencv-*` variant
  (uninstalling just one corrupts the shared directory and leaves the
  survivor unimportable — confirmed: `module 'cv2' has no attribute
  '__version__'`), then install the pinned one alone. Note `mediapipe`
  declares a dependency on non-headless `opencv-contrib-python`, so a
  later `pip install -r requirements.txt` can reintroduce a second
  distribution; `demo_preflight.py` asserts exactly one is installed.
- **A test script that spins up its own nodes will silently attach to
  already-running ones on the same ports instead of erroring.**
  `test_vclock.py` (and likely the other `test_*.py` scripts) hardcode
  ports 8001-8003 — running one while the demo cluster is already up on
  those same ports doesn't fail to bind, it just posts the test's
  synthetic events (guest `g1`, devices `deviceA`/`deviceB`) straight
  into the live demo's real databases, polluting them. Confirmed live:
  a test run bumped the live cluster's event count and left a fake
  guest sitting in the real gallery. Don't run these test scripts
  against a cluster you care about the data in — check `netstat`/`lsof`
  for 8001-8003 first, or only run them when nothing else is up.
- **Zero-shot CLIP with one hand-written prompt per class has a class
  prior that can swamp the actual signal.** The film-stock suggester
  originally used one long prompt per stock. Measured against 18 real
  reference frames — a night motorcycle, a dappled-sun truck, a sunflower
  field, and near-black end cards — **one stock won all 18**, because a
  long prompt full of generic photographic words picks up a constant
  offset (`gold_200` sat at a mean +0.034 while the rest were near zero)
  larger than the per-image variation (0.02–0.056). Two fixes together:
  mean-center the text embeddings to remove the component every prompt
  shares, and ensemble several *short* prompts per class (CLIP's own
  zero-shot recipe). After both, the same 18 frames split across 4
  different stocks. If you add a stock, keep its prompts short and
  comparable in specificity, and re-measure the winner distribution
  rather than eyeballing one image. Because the resulting margins are
  genuinely small, `preview()` also reports `confident`
  (`CONFIDENT_MARGIN`) so a coin-flip is never rendered in the same voice
  as a clear win.
- **Excluding "blown highlights" with `V > 250` throws away every pixel
  of a fully saturated image.** `describe_scene`'s first version masked
  out both very dark and very bright pixels before its hue histogram.
  A vivid orange is `V=255` with plenty of hue, so a bright sunset came
  back as *"dim, near-colorless light"* with mean S and V both exactly
  0.0 — the mask had emptied the array. The correct test for "this pixel
  has no usable hue" is the saturation gate, not brightness; only the
  dark floor is a legitimate exclusion.
- **Locating a subject in a saliency map: two obvious approaches are
  both wrong, and the second is wrong in a way that inverts the
  guidance.** Worth reading before "improving" `_saliency_subject`,
  because both were tried and measured.
  (1) *Whole-image statistics over every above-Otsu pixel* (min/max, or
  a 6th/94th percentile) collapse to ~90% of the frame on any real
  photograph — foliage, gravel and fabric speckle saliency everywhere —
  which silently makes the reframe a permanent no-op, since a crop that
  size is never tighter than what's already framed.
  (2) *The strongest connected component* fixes that and breaks
  differently: spectral residual responds to **edges, not filled
  regions**, so one object answers as several fragments (a uniform
  square splits into separate left-edge and right-edge blobs) and the
  winning fragment's centroid sits off to one side. Worse, the dimly-lit
  background that survives thresholding drags the centroid toward the
  frame centre — measured on synthetic subjects at x=0.22 and x=0.72,
  the reported positions were 0.40 and 0.53, both close enough to centre
  to cross the nearest rule-of-thirds line and **tell the user to move
  the camera the wrong way**. Correct arithmetic, backwards advice,
  which is the exact failure this feature is supposed to avoid.
  The fix that holds: keep only the top `SUBJECT_TOP_PCT` of the blurred
  map's saliency mass (drops the background doing the centre-pulling),
  weight by height *above* that threshold, and take the weighted
  centroid — an object's several edge responses then average back onto
  the object. Extent comes from the weighted standard deviation, and
  `found` is false when that spread exceeds `SUBJECT_DIFFUSE_MAX`.
  Centroid error against four synthetic subjects at known positions is
  ≤1px per axis; if you change any of this, re-run that check rather
  than eyeballing one photo, since the failure mode is a *plausible*
  box in the wrong place.
- **`test_ai_engine.py` (and its siblings) `os.remove()` `./node1.db`
  through `./node3.db` on cleanup — the same files the demo cluster
  uses.** This is the sharper edge of the port-collision gotcha below: it
  isn't only that a test run pollutes live data, it's that the run
  *deletes those databases when it finishes*. And because the test also
  attaches to whatever DBs already exist, running it against a populated
  demo cluster fails in a confusing way first (`expected 3
  aesthetic_score events` counting 109 pre-existing ones) before wiping
  them. Back the `.db` files up, or only run these with nothing else set
  up on 8001-8003.
- **`useSyncExternalStore`'s snapshot function must return a stable
  reference when nothing changed, or it loops forever.**
  `client-2/src/lib/outbox.ts`'s first version re-parsed the
  localStorage JSON blob on every call to `getSnapshot` — a *new* array
  every time, even when the underlying data hadn't changed, which React
  reads as "changed" on every render and re-renders forever ("Maximum
  update depth exceeded"). Fixed by caching against the raw string and
  only re-parsing when it actually differs. If you add another
  `useSyncExternalStore`-backed store anywhere, the snapshot function
  needs the same caching, not just "return the current value."
- **In TanStack Start, `src/start.ts` is isomorphic (bundled for both
  client and server); `src/server.ts` is not.** Importing a Node
  built-in (`node:fs`, `node:path`) at the top of `start.ts` breaks
  client-side hydration with a cryptic "Module has been externalized
  for browser compatibility" error, because Vite has to stub those
  modules out for the browser bundle. `client-2/src/server.ts` (the
  actual Nitro server entry, see `vite.config.ts`'s `server: { entry:
  "server" }`) is the safe place for Node-only bootstrap code like
  `client-2`'s own `.env` loader — never `start.ts`.
- **Vite's own `.env` loading treats `$` as variable-interpolation
  syntax (`dotenv-expand`), even for non-`VITE_`-prefixed keys your own
  code never asked it to touch.** A `client-2/.env` value of the shape
  `CONSOLE_PASSWORD=s3cret$val` silently became `"s3cret"` server-side —
  `$val` was read as a reference to an undefined env var `val` and
  expanded to nothing — before `client-2/src/server.ts`'s own loader
  (which does zero interpolation) ever ran. A guarded "only set if not
  already present" write kept that mangled value; the fix was making
  the custom loader unconditional so the literal file value always
  wins. If a secret contains `$`, don't trust any `.env` value you
  haven't verified end-to-end.
- **Testing the camera on a real phone needs three separate things, and
  each fails silently on its own.** `client-2`'s capture route uses
  `getUserMedia`, which requires a *secure context*; only `localhost` is
  exempt. So on a phone at `http://192.168.x.x:8080` the app loads
  perfectly and simply has no camera — the route's own error copy
  ("NEEDS HTTPS OR LOCALHOST") is the only clue. Enabling HTTPS then
  breaks the backend calls two more ways: an HTTPS page may not fetch
  `http://` URLs (mixed content), and `127.0.0.1:8001` means *the phone*
  when the page is running on a phone. `vite.config.ts` handles all
  three: a dev cert from `certs/` (gitignored; the LAN IPs must be in
  `subjectAltName` — browsers stopped honouring CN for host matching
  years ago), plus a `/n1,/n2,/n3` same-origin proxy to the nodes that
  the guest app is pointed at with `VITE_NODE_URLS`. The operator
  console is deliberately unaffected: it reads `api.ts`'s `CLUSTER`
  (absolute URLs) rather than `NODES`, because `/chaos/partition`
  indexes positionally into a specific node's own `PEERS` list. Missing
  cert files fall back to HTTP rather than failing to boot.
- **A row-count batch cap is not a size cap, and large payloads in the
  log break gossip in a way that looks like a flaky peer.**
  `events_missing_from(limit=500)` reads as a sensible bound until a
  payload can be 200KB — then the body outgrows the client timeout, and a
  node that falls behind can *never* catch up because every attempt to
  catch up times out. Bytes now live in `blobs` (`blob_sync.py` has the
  measurements); `events_missing_from` also takes `MAX_SYNC_BYTES`. If
  you add another event kind with a large payload, it belongs in a blob.
- **Read amplification in a route handler is a latency bug on the *event
  loop*, not just wasted I/O.** `store.photos()` did `SELECT *` and
  popped the unwanted field in Python, reading ~1800× more than it
  returned — synchronous work on the one asyncio loop raft's 50ms
  heartbeat and gossip both live on, polled every 4s by every guest. Same
  class of failure as the `to_thread` gotcha above, reached from a
  different direction. Strip unwanted JSON fields in **SQL**
  (`json_remove`); don't `SELECT *` when you want four columns.
  The same rule applies to what you hang off `GET /health`: it's polled
  every second by the dashboard and console, so `blob_stats()` keeps its
  recap-replay behind an opt-in flag rather than paying it on every poll.
- **Deriving a flag locally when the thing it describes is replicated
  gives every node a different answer.** The recap's blob "pinning" was
  first written as `UPDATE blobs SET pinned=1` at freeze time. That only
  ran on whichever node happened to be Raft leader at that moment, and
  only for blobs that node had already pulled — so the other two nodes
  had no idea those bytes were protected, and `blob_stats` reported 0
  pinned on the node the test happened to ask. Caught by `test_recap.py`
  asserting the pinned count. Fixed by deriving the pinned set from the
  `recap_sent` events themselves (`store.pinned_hashes`). This is the
  Conventions rule at the bottom of this file, and pinning is not a good
  place to make an exception to it.
- **`--host ::` is IPv6-ONLY under uvicorn, not dual-stack, whatever
  `bindv6only` says.** Fly.io's private network between machines (6PN) is
  IPv6-only, so the app must bind `::` there or every peer's gossip and
  raft RPC is refused while the *public* health check still passes —
  three healthy-looking nodes that never form a cluster. But the fix has
  a second edge: the container reports `bindv6only=0`, which implies a
  `::` socket accepts IPv4 too, and it does not. Uvicorn creates the
  socket with `IPV6_V6ONLY` set, so from inside a `HOST=::` container
  `::1` connects and `127.0.0.1` is refused. That makes such a container
  unreachable through docker's IPv4 port mapping — don't set `HOST=::`
  for a local run and conclude the image is broken. Verified working on
  an IPv6-only docker network (peers reachable, leader elected, events
  gossiped, blob bytes replicated). `Dockerfile` defaults `HOST` to
  `0.0.0.0`; only `fly/*.toml` sets `::`.
- **Raft's timers are tuned for loopback, and deploying the cluster across
  a network breaks it in a way that looks like flapping nodes.** 50ms
  heartbeat / 150-300ms election timeout / 50ms per-RPC timeout are
  unmeetable by a *healthy* peer once an RPC costs 20-200ms (three Render
  services, separate hosts, anything crossing a real network): every RPC
  times out, every election round stalls, leaders churn forever. Same
  livelock `raft.py`'s RPC_TIMEOUT comment describes, reached through
  latency rather than a dead peer. The timers are env-overridable
  (`RAFT_HEARTBEAT`, `RAFT_ELECTION_MIN`/`MAX`, `RAFT_RPC_TIMEOUT`,
  `GOSSIP_RPC_TIMEOUT`) — keep the ratios, don't just raise one. Never
  apply the slow values to a local run: ROADMAP.md's Phase 8 numbers were
  measured with the defaults and stop describing the system otherwise.
- **A client-side timeout tuned for loopback turns a proxy into "the
  backend is down".** `pickNode()` used a 1500ms budget; a *cold*
  connection through a loopback-intercepting proxy measured ~2.1s against
  ~12ms once warm. So the first poll after an idle gap failed all three
  nodes at once and rendered "NO NODE REACHABLE", the next poll succeeded
  instantly, and it read as the backend flapping — with containers that
  had never restarted and a raft term that never moved. Raised to 4000ms;
  `Promise.any` still settles on the first answer, so a healthy cluster is
  unaffected. A phone waking its radio has the same cold-connect profile,
  which is exactly when a guest opens the app. When diagnosing this class
  of bug, check `docker inspect --format '{{.RestartCount}}'` and whether
  the raft term is actually moving *before* suspecting the backend.
- **A dev server bound with `--host` on a port that's already taken
  silently moves to the next one, and the old process on the old port
  doesn't stop just because you meant to replace it.** Running
  `client-2`'s dev server twice (e.g. once from a previous session,
  once fresh) leaves two live processes — one on :8080, one on :8081 —
  both serving the app, but only the newer one has the latest code.
  Hitting the stale one looks exactly like a real bug (e.g. a correct
  password being rejected) until you check `netstat`/`lsof` for extra
  listeners and close the old terminal.

## Conventions

- Every derived read (photo list, zone scores, job status, like counts)
  is computed by replaying `events`, never stored redundantly. If you add
  a new feature, follow this pattern rather than adding a second source
  of truth.
- No new distributed-systems mechanism beyond what ROADMAP.md lists.
  Every extra protocol is extra failure-mode surface — see "What NOT to
  add" at the bottom of ROADMAP.md.
