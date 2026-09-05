# SwarmLens — three-node gossip backend

Three identical FastAPI nodes, each owning its own SQLite file. No shared
database. State converges by gossip, not by a central authority.

## Run

    docker compose up --build

Nodes land on http://localhost:8001, :8002, :8003

Local (no Docker), three terminals:

    NODE_ID=node1 DB_PATH=./node1.db SELF_URL=http://127.0.0.1:8001 PEERS=http://127.0.0.1:8002,http://127.0.0.1:8003 uvicorn main:app --port 8001
    NODE_ID=node2 DB_PATH=./node2.db SELF_URL=http://127.0.0.1:8002 PEERS=http://127.0.0.1:8001,http://127.0.0.1:8003 uvicorn main:app --port 8002
    NODE_ID=node3 DB_PATH=./node3.db SELF_URL=http://127.0.0.1:8003 PEERS=http://127.0.0.1:8001,http://127.0.0.1:8002 uvicorn main:app --port 8003

`SELF_URL` must be the address the *other* nodes reach this one at (i.e.
it appears in their `PEERS` list) — it's how every node's own identity on
the consistent-hashing ring matches how peers already refer to it.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/events` | register or edit a hosted event (slug, name, venue, zones) — gated by `OPERATOR_TOKEN` |
| GET  | `/events?status=&limit=&offset=` | operator's directory, paginated, newest first, with a derived `active`/`ended` status. No join tokens — gated |
| GET  | `/events/{slug}/token` | one event's join token, for printing its QR — gated |
| GET  | `/events/{slug}?k=` | resolve a scanned QR: slug + join token → `{event_id, name, venue, zones, ...}` (no token echoed back) |
| POST | `/photos` | upload (guest_id, zone, composition_score, optional event_id, optional vclock) |
| GET  | `/photos?event_id=` | gallery as this node currently sees it, scoped to one hosted event when given; each photo carries `vclock` + `concurrent_with` |
| POST | `/likes`  | like a photo (guest_id, photo_id, optional vclock) |
| GET  | `/zones?event_id=` | emergent aesthetic map, ranked, scoped to one event when given; each zone's score comes from its owning node on the hash ring (`stale: true` if that node is unreachable) |
| GET  | `/zones/local?event_id=` | this node's own replica of every zone, no ownership filtering — what peers proxy to |
| GET  | `/zones/ring?event_id=` | debug: current ring membership and the zone → owner mapping |
| GET  | `/zones/quorum?R=&W=&event_id=` | quorum read: union raw events from R of N random nodes and recompute; W is echoed back for the CAP narrative only |
| GET  | `/zones/events` | this node's raw photo/like/aesthetic_score events, undigested — what quorum reads fetch from each sampled peer |
| POST | `/analyze` | photo_id + image_base64 -> {ar_guide, suggested_filter, aesthetic_score}; writes an aesthetic_score event |
| POST | `/analyze/preview` | live viewfinder: image_base64 + aspect -> subject box, crop rect + zoom, camera-move guide, film-stock picks, reason sentence. Writes **nothing**; sheds with 503 when busy |
| GET  | `/health` | event count, version vector, gossip stats |
| POST | `/gossip/sync` | peer-to-peer: exchange digest, return missing events |
| POST | `/gossip/push` | peer-to-peer: deliver events the peer lacks |
| POST | `/chaos/partition/{i}` | stop gossiping with PEERS[i] |
| POST | `/chaos/heal` | resume all gossip |
| POST | `/raft/request_vote` | peer-to-peer: cast a vote for a candidate |
| POST | `/raft/heartbeat` | peer-to-peer: leader keepalive |
| GET  | `/raft/status` | this node's Raft role, term, current leader |
| POST | `/recap/trigger?event_id=` | end an event: freeze its top-`RECAP_TOP_N` most-liked photos into a one-time `recap_sent` event. No-ops unless this node is leader, or if that event's recap already fired — gated by `OPERATOR_TOKEN` |
| GET  | `/recap?event_id=` | that frozen snapshot, for the guest slideshow; `{ready: false, photos: []}` until it's been triggered |
| POST | `/cloud_sync/trigger` | force a cloud archive sync tick now; no-ops unless leader + SUPABASE_URL configured |
| GET  | `/cloud_sync/status` | enabled/role/last sync count/last error |
| GET  | `/blobs/digest` | peer-to-peer: which photo blobs this node holds (hashes only) |
| GET  | `/blobs/{hash}` | peer-to-peer: one blob's raw bytes. 404 = "not here", a routine answer mid-replication |
| POST | `/blob_archive/trigger` | upload recap-pinned blobs to Supabase Storage now; no-ops unless leader + configured — gated by `OPERATOR_TOKEN`, since it spends money |
| GET  | `/blob_archive/status` | archive enabled/role/uploaded/last error, plus local blob counts |
| GET  | `/dashboard` | static chaos + metrics dashboard (dashboard.html), served identically by every node |

## Verified demo

    # write to node1, read from node3 a second later
    curl -X POST localhost:8001/photos -H 'content-type: application/json' \
      -d '{"guest_id":"g1","zone":"flower_arch","composition_score":93}'
    curl localhost:8003/photos

    # partition, like from both sides, watch counts diverge
    curl -X POST localhost:8003/chaos/partition/0
    curl -X POST localhost:8003/chaos/partition/1
    curl -X POST localhost:8001/likes -H 'content-type: application/json' \
      -d '{"guest_id":"g2","photo_id":"ph_xxx"}'
    curl -X POST localhost:8003/likes -H 'content-type: application/json' \
      -d '{"guest_id":"g5","photo_id":"ph_xxx"}'
    curl localhost:8001/photos ; curl localhost:8003/photos   # different

    # heal, watch them converge with nothing lost
    curl -X POST localhost:8001/chaos/heal
    curl -X POST localhost:8003/chaos/heal

Observed run: node1=3, node3=2 while split; all three = 5 after healing.
A guest who liked twice was counted once.

## Raft leader election

Election-only Raft in `raft.py` (no log replication -- the event log +
gossip already handle that). Run `python test_raft.py` for an automated
demo: starts three nodes, confirms a single leader, `kill -9`s it,
confirms re-election within ~1s, and confirms `recap_sent` fires exactly
once cluster-wide even across the crash.

## Consistent hashing (zone ownership)

Each venue zone is owned by exactly one node, picked from a consistent
hash ring (`hashing.py`, 100 virtual nodes per member) over the currently
alive cluster (self + `gossip.alive_peers()`). `GET /zones` proxies each
zone to its owner; if the owner doesn't answer it falls back to this
node's own replica with `stale: true` rather than failing. `python
test_hashing.py` is a pure unit test confirming the ring's remap
property: adding a 4th node to a 3-node ring remaps roughly 1/4 of zones,
not all of them.

## Quorum reads (the CAP knob)

`GET /zones/quorum?R=2&W=2` samples `R` of `N` nodes at random each call
(`N = len(PEERS) + 1`, fixed), unions their raw photo/like events deduped
on `(origin, seq)`, and recomputes zone scores from the merge -- more
honest than trusting one node's already-aggregated counts. `W` is
accepted and echoed back for the CAP-tradeoff narrative only; this
system's writes are always local + eventually gossiped, so there's no
synchronous write-quorum for `W` to gate.

Demo the tradeoff live:

    # fully isolate node3 (both directions, from both other nodes)
    curl -X POST localhost:8001/chaos/partition/1
    curl -X POST localhost:8002/chaos/partition/1
    curl -X POST localhost:8003/chaos/partition/0
    curl -X POST localhost:8003/chaos/partition/1

    # write after the partition -- reaches node1 + node2, never node3
    curl -X POST localhost:8001/photos -H 'content-type: application/json' \
      -d '{"guest_id":"g1","zone":"new_zone","composition_score":93}'

    curl 'localhost:8001/zones/quorum?R=1'   # sometimes lands on node3, undercounts
    curl 'localhost:8001/zones/quorum?R=2'   # always fresh -- majority excludes node3

    curl -X POST localhost:8001/chaos/heal
    curl -X POST localhost:8002/chaos/heal
    curl -X POST localhost:8003/chaos/heal   # R=1 becomes reliably fresh again

`python test_quorum.py` runs this exact scenario automatically: R=1 over
30 tries came back fresh 21 and stale 9 times, R=2 was fresh 20/20, and
R=1 was fresh 10/10 again after healing.

## Multi-event hosting (QR join)

One cluster, several events at once — a wedding and a donation ceremony
booked the same weekend, both on the same three nodes and the same
append-only log, kept apart everywhere a guest or the ring can see:
`GET /photos`, `GET /photos/public`, `GET /zones`, and `GET
/zones/quorum` all take `event_id` and never merge across it, and the
consistent-hash ring keys on `f"{event_id}/{zone}"` (`main.py`'s
`ring_key`) so two events both naming a zone "main" land on different
owners rather than sharing one node's score. Photos logged before this
existed have no `event_id` at all; every derived read treats that as the
`"default"` event (`store.DEFAULT_EVENT_ID`), so they stay reachable
under that name rather than becoming orphaned.

An event is registered with `POST /events` (gated by `OPERATOR_TOKEN`,
same as `/chaos/*`) and appends an ordinary `event_created` event — no
new table, gossiped and replayed exactly like a photo:

    curl -X POST localhost:8001/events -H 'content-type: application/json' \
      -d '{"slug":"hollis-marchetti","name":"Hollis x Marchetti","venue":"Cordwainers Hall","zones":["ceremony","reception"]}'
    # -> {"ok":true,"event_id":"ev_xxxx","join_token":"...", ...}

A guest's phone never enumerates events (`GET /events` is gated for
exactly that reason — a wedding's guests have no business listing the
funeral booked the same weekend). It resolves exactly one, by slug plus
the join token printed on that event's own QR:

    curl 'localhost:8001/events/hollis-marchetti?k=<join_token>'
    # -> {"event": {"event_id":"ev_xxxx","zones":["ceremony","reception"],...}}
    curl 'localhost:8001/events/hollis-marchetti'          # no token -> 404
    curl 'localhost:8001/events/hollis-marchetti?k=wrong'  # wrong token -> 404

`k` is not authentication, the same way `GET /photos/public` needs no
guest identity to view — it only stops a guest who mistypes or guesses a
slug from wandering into someone else's event. `client-2`'s
`/join/$slug?k=` route (`routes/join.$slug.tsx`) is what a scanned QR
actually opens: it calls this endpoint once, stores the result in
`lib/event.ts`, and sends the guest on into `/capture`. Every other guest
screen reads the joined event from there — never from a URL param again
— including which zones (if more than one) show a picker on the capture
screen at all; a single-zone event shows none.

The operator console's **Hosted events** panel (`routes/console.tsx`) is
where an operator actually creates events day-to-day: a form posting
through `lib/operatorGateway.ts`'s `serverCreateEvent` (so
`OPERATOR_TOKEN` never reaches the browser, same pattern as the chaos
actions), a per-event QR rendered client-side with the `qrcode` package,
and a **PUBLIC URL FOR PRINTED QR CODES** field that warns when it's
still pointed at `localhost`/`127.0.0.1` — a real phone scanning that QR
has no idea what "localhost" means on its own network. Selecting an
event in the console scopes the room stats, aesthetic map, and quorum
panel to it; the default is every event merged, the same view that
existed before hosted events did.

`python test_events.py` runs the isolation guarantees above against 3
live, gossiping nodes: two events created on two different nodes with
matching zone names, confirmed to replicate, resolve, and stay separate
in `/photos`, `/zones`, `/zones/quorum` (at R=1/2/3), and the per-guest
public-gallery cap (which is per guest *per event* — the same phone at
two events is two separate guests, see `client-2/src/lib/guest.ts`) —
plus a legacy no-`event_id` photo staying reachable throughout.

## End-of-event recap (the frozen slideshow)

When an event finishes, the host ends it and the cluster freezes that
event's `RECAP_TOP_N` (default 10) most-liked photos into a single
`recap_sent` event. Guests replay it as a slideshow at `client-2`'s
`/recap` route, anytime afterward:

    # end the event -- broadcast to all three, only the leader acts
    for p in 8001 8002 8003; do
      curl -X POST "localhost:$p/recap/trigger?event_id=ev_xxxx" \
        -H "X-Operator-Token: $OPERATOR_TOKEN"
    done
    # -> {"triggered":true,"by":"node2","event_id":"ev_xxxx"}  (leader)
    # -> {"triggered":false,...}                               (followers)

    curl 'localhost:8003/recap?event_id=ev_xxxx'
    # -> {"ready":true,"photos":[{"photo_id":"ph_...","guest_id":"...",
    #                             "zone":"ceremony","likes":7}, ...]}

The snapshot is **frozen at trigger time, not recomputed on read**. That
is the whole point rather than an optimization: a like arriving after the
host called it a wrap must not quietly reshuffle what "most memorable"
meant at that moment, and a guest opening the slideshow a week later
should see the same reel everyone else did. The ranking is
`(-likes, photo_id)`, deterministic even in the unlikely case two nodes
ever computed it independently.

Exactly-once works the same way the original recap did — only the Raft
leader appends, and idempotence is re-checked against the *replicated
log* (`store.recap_for`), not local memory, so it survives a leader
crash and re-election. It's per event now: ending the wedding doesn't
touch the donation ceremony booked the same weekend. `POST
/recap/trigger` is gated by `OPERATOR_TOKEN` (ending an event is an
operator decision); `GET /recap` deliberately is not — a guest coming
back to relive the night is exactly who it's for.

Deletion, however, outranks the freeze. A guest can retract one of their
own photos after the event, and a withdrawn photo has to leave the reel
even though the snapshot named it — "the recap froze it first" is not an
answer to someone withdrawing consent. So the snapshot also freezes
`RECAP_SPARES` extra photos beyond the visible `RECAP_TOP_N`: a deleted
photo is dropped and the next-ranked spare backfills, and the reel stays
full length instead of developing a hole. `GET /recap` reports
`backfilled` and `exhausted` rather than quietly serving a short reel.

Each frozen photo also records its `blob_hash`, and that is what **pins**
those bytes: pinned blobs replicate first, are never evicted by
retention, and are the ones uploaded to object storage (below). A recap
is meant to outlive its event, and pinning is what makes that true of the
pixels rather than just the metadata.

`python test_recap.py` proves the freeze is real: it triggers, then piles
enough new likes onto the lowest-ranked photo to make it the most-liked
overall, and confirms `GET /recap` is unchanged — then deletes a frozen
photo and confirms it leaves the reel, a spare backfills in rank order,
and its bytes stop serving.

## Photo storage at production scale

Photo **bytes** do not live in the event log. They used to — inline
base64 on the photo event — and that broke three things once an event
meant thousands of frames rather than a demo's fifty. All measured, not
predicted:

| 500 photos @ 150KB | bytes inline | blob split |
|---|---|---|
| event log size, per node | 95.7 MB | **0.2 MB** |
| `GET /photos` | 221 ms | **4 ms** |

- **`GET /photos` was blocking the asyncio loop.** It read every photo's
  bytes off disk and discarded 99.9% of them in Python — and that's
  synchronous work on the same single event loop raft's 50ms heartbeat
  and gossip both run on. At 3,000 photos it's seconds per call, polled
  every 4s by every guest, which is enough to vote out a leader that
  never lost contact.
- **Gossip could not converge.** A 500-row batch of 203KB events is a
  ~100MB JSON body against a 3-second timeout, so a node that fell behind
  could never catch up.
- **`cloud_sync` was pushing 200KB blobs into Postgres `jsonb`**, which
  is the wrong storage class for an image by a wide margin.

So bytes moved to a content-addressed `blobs` table (keyed by sha256, so
a retry or a second device uploading an identical frame stores once), and
replicate on their own byte-budgeted path (`blob_sync.py`) instead of
inside a gossip round that had to finish in one timeout. Durability is
unchanged — every node still ends up with every blob, surviving two node
losses — only *how the bytes get there* changed. `GET /photos/{id}/image`
reads through to a peer when this node has the metadata but not yet the
pixels, so a guest never sees a broken image mid-replication.

Photos written before the split still work, indefinitely: real databases
have them and rewriting history to migrate is a worse trade than one
branch in `store.photo_image()`.

### Archiving to Supabase Storage

Three nodes surviving node loss is not the same as a recap surviving the
*fleet* — these are processes on hardware that gets reimaged and laptops
that go back in cupboards, and a wedding recap is expected to still play
a year later. `blob_archive.py` uploads recap-pinned blobs to a Supabase
Storage bucket, leader-gated and disabled entirely unless configured:

    SUPABASE_URL=https://xxxx.supabase.co SUPABASE_KEY=... SUPABASE_BUCKET=recap-photos

    curl -X POST localhost:8001/blob_archive/trigger
    # -> {"uploaded": 10, "enabled": true, "role": "leader", ...}

The object key **is** the blob's content hash, which is what makes a
re-upload after a leadership change idempotent — the same "let the
destination be the dedup authority" reasoning as `cloud_sync`'s
`UNIQUE(origin, seq)`. Only pinned (recap) blobs are uploaded, not every
frame every guest shot: archiving the whole roll is a cost decision
nobody has made, and doing it by default would quietly turn a demo
cluster into a storage bill.

The archive is **readable**, not write-only: `GET /photos/{id}/image`
falls back local → peer → archive, re-caching what it pulls back. That
last hop is the case the archive exists for — a recap replayed after the
cluster that produced it is gone or has lost the blob.

Photos predating the split have their bytes inline and no hash, so they
could never be pinned or archived. When a recap freezes one,
`store.ensure_blob_for_photo` materialises a blob and records the hash on
the **recap** event — the photo event is never rewritten, because it has
already been gossiped under its `(origin, seq)` and two nodes disagreeing
about one event's content is the one thing the merge model can't
survive.

`python test_blobs.py` proves the split holds: the photo event is a few
hundred bytes of metadata with no `image_base64` in *any* node's log, the
bytes still reach all three nodes, a node lacking a blob reads through
instead of 404ing, identical bytes dedup, and legacy inline photos still
serve.

## AI analysis engine

`POST /analyze` (`ai_engine.py`) runs three pretrained, non-training
models on a photo and returns the results, no training or fine-tuning
anywhere:

1. **AR reframe guide** -- OpenCV saliency
   (`cv2.saliency.StaticSaliencySpectralResidual`) finds the subject,
   compared against the nearest rule-of-thirds intersection.
2. **Film-stock suggestion** -- CLIP ViT-B/32 (ONNX, int8-quantized),
   cosine similarity against a fixed set of text prompts, one per film
   stock (see `FILM_STOCKS` in `ai_engine.py`).
3. **Aesthetic score (0-10)** -- reuses the same CLIP embedding from
   step 2 with LAION's `aesthetic-predictor` v1 linear head (ViT-B/32
   variant). See `ai_engine.py`'s module docstring for exact model
   sources/versions.

Models download on first use into `./models/` (~154MB, gitignored,
cached after that) -- pre-warm before a demo with:

    python -c "import ai_engine; ai_engine.warmup()"

The resulting `aesthetic_score` is written to the event log exactly like
a photo or like event (`store.append_local`) -- it gossips, merges, and
feeds `/zones`/`/zones/quorum`'s new `avg_aesthetic` field the same way
everything else already does, no second replication path.

    curl -X POST localhost:8001/photos -H 'content-type: application/json' \
      -d '{"guest_id":"g1","zone":"flower_arch","composition_score":93}'
    # (grab the returned photo_id, then:)
    curl -X POST localhost:8001/analyze -H 'content-type: application/json' \
      -d '{"photo_id":"ph_xxx","image_base64":"<base64 png/jpeg>"}'
    curl localhost:8001/zones   # avg_aesthetic now populated for that zone

`python test_ai_engine.py` runs this end to end against 3 live nodes:
confirms the AR guide direction is sane for an intentionally off-center
subject, confirms suggested_filter differs between a sunset-gradient and
a flat-gray image, and confirms the aesthetic_score event count matches
across all three nodes' `.db` files after a gossip round. **It deletes
`./node1.db`-`./node3.db` when it finishes** — back them up first if the
demo cluster has data you care about.

### Live guidance before the shutter (`POST /analyze/preview`)

Same models, run on the viewfinder instead of on a saved photo, so the
guest gets composition help *while* framing rather than a verdict after.
It returns a subject box, a rule-of-thirds crop rectangle with its zoom
factor, a camera-move instruction, ranked film-stock picks, and a
one-line reason built from the scene's measured dominant colours.

It writes **nothing** — that is the whole distinction from `/analyze`.
A camera calls it every 1.5s against a frame with no `photo_id` that was
never shot; appending those would flood the replicated log and skew
`avg_aesthetic` with frames no guest kept. It is also semaphore-bounded
and sheds with 503 rather than queueing, since guidance computed for a
frame the guest already panned away from is worse than none.

    curl -X POST localhost:8001/analyze/preview -H 'content-type: application/json' \
      -d '{"image_base64":"<base64 jpeg>","aspect":0.75}'

Two directions come back and they are inverses: `move_subject_*` is
which way the subject should shift *in the frame*, `pan_camera_*` is
which way to turn the camera to achieve that. Anything phrased as an
instruction must read `pan_camera_*` — rendering the other one gives a
confidently backwards arrow. `strength` buckets the real dx/dy
magnitude, and `confident` is false when the top two film stocks are
within `CONFIDENT_MARGIN`, so a tie is never presented as a preference.
`client-2`'s camera consumes all of this (see its AI compose overlay).

## Vector clocks (concurrent events)

`events.vclock` (JSON, envelope metadata like origin/seq) lets a guest
device attach its own `{device_id: counter}` causal clock to a photo or
like. `GET /photos` uses it to compute `concurrent_with` per photo:
other photo_ids whose clock neither dominates nor is dominated by this
one, so the gallery can render them side by side instead of implying a
false total order from network arrival timing. A photo posted with no
vclock is never flagged concurrent with anything -- true of everything
posted by curl, but not of photos from the guest client in `client/`
(Phase 5's other half), which attaches a real one to every capture.

    curl -X POST localhost:8001/photos -H 'content-type: application/json' \
      -d '{"guest_id":"a","zone":"bar","vclock":{"deviceA":1}}'
    curl -X POST localhost:8001/photos -H 'content-type: application/json' \
      -d '{"guest_id":"b","zone":"bar","vclock":{"deviceB":1}}'
    curl localhost:8001/photos   # each lists the other in concurrent_with

`python test_vclock.py` simulates a couple of devices this way against 3
live nodes and confirms the concurrency relationships are correct and
survive gossip replication unchanged.

## Cloud archive sync

`cloud_sync.py` pushes the event log to a Supabase/PostgREST-style
endpoint, one-way and append-only, on a leader-gated background loop
(`CLOUD_SYNC_INTERVAL`, default 15s). Disabled entirely unless
`SUPABASE_URL` is set -- zero effect on a node that doesn't configure it.
It's config-driven, not hardcoded to a real project (none exists for
this repo yet):

    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_KEY=<service-role or scoped key>
    SUPABASE_EVENTS_TABLE=events   # optional, this is the default

The destination table needs columns matching the event shape (`origin
text, seq int8, kind text, payload jsonb, created_at float8, vclock
jsonb`) and a `UNIQUE(origin, seq)` constraint -- that's what makes
repeated/overlapping pushes safe to dedup via `Prefer:
resolution=ignore-duplicates`. See `cloud_sync.py`'s module docstring for
the full reasoning, including why a *local, non-replicated* sync
checkpoint is still correct even across a Raft leadership change.

    curl -X POST localhost:8001/cloud_sync/trigger   # force a tick now
    curl localhost:8001/cloud_sync/status

`python test_cloud_sync.py` stands up a tiny in-process fake-cloud HTTP
server (no real Supabase project needed) and confirms: the cluster keeps
working while the fake cloud isn't listening ("no internet"); a trigger
against it fails softly instead of 500ing; the full backlog syncs in one
push once it starts listening ("reconnect"); re-triggering with nothing
new is a true no-op with no duplicates; a new event afterward syncs
incrementally; and only the Raft leader ever pushes.

## Chaos + metrics dashboard

    curl -X POST localhost:8001/photos ...   # cluster running
    # open in a browser:
    http://localhost:8001/dashboard

Self-contained static HTML/CSS/vanilla JS (`dashboard.html`), served
identically by every node -- open it on any one of the three, it polls
`GET /health` on all three via `fetch` (CORS is already wide open) every
1s. Shows role/term/leader/event count/gossip stats/cloud-sync status per
node, and buttons for `/chaos/partition/{i}` and `/chaos/heal`, plus an
"Isolate this node" convenience button that fires all 4 directional
partition calls a *real* bidirectional isolation needs in one click (a
single-direction partition alone self-heals within a round or two --
see CLAUDE.md).

This is the lighter alternative to a full Prometheus/Grafana setup --
see the Phase 7 writeup in ROADMAP.md for why, and for a real bug this
caught by actually clicking through the UI in a browser rather than only
curling the endpoints it drives. No real `kill -9` button: see
ROADMAP.md's Phase 7 writeup for why that's a genuinely different risk
(an HTTP endpoint that kills an OS process, on a backend with no auth at
all) rather than scope creep.

## Load test + numbers

    python load_test.py --quick   # fast, reduced-scale, validates the script
    python load_test.py           # full spec'd numbers (200 uploads, 500
                                   # likes, 20 election trials) -- a few
                                   # minutes end to end

Plain `asyncio` + `httpx` (no locust), spins up and tears down its own
real clusters, never mocks. Measures upload/like latency percentiles,
convergence time, node-kill recovery time, leader re-election latency
(20 trials), throughput at N=1,2,3,4, and gossip bandwidth per round.
Outputs `results.json` + `summary.csv` + 6 PNGs into
`load_test_results/` (gitignored -- results from one run on one
machine, not committed source).

**Numbers from a full run on this machine** (one run -- see
`load_test_results/summary.csv` after your own run for current numbers):

| Metric | Value |
|---|---|
| Photo upload latency (200 concurrent) | p50 1.39s / p95 1.59s / p99 1.60s |
| Like latency (500 concurrent) | p50 1.53s / p95 2.54s / p99 2.71s |
| Convergence time after the burst | 1.89s |
| Recovery (kill -> reclaim -> done) | 13.25s |
| Leader re-election (20 trials) | min 0.19s / mean 0.29s / max 0.85s |
| Throughput, N=1 / 2 / 3 / 4 | 81 / 132 / 164 / 220 uploads/sec |
| Gossip `/sync` payload | cold (full backlog) 112KB / warm (steady state) 509B |

The latency numbers under full concurrent load are notably higher than
under light load, and that's the honest cost of a real bug this script
found and fixed: `store.py`'s sequence-number assignment wasn't atomic
across concurrent writers (see ROADMAP.md's Phase 8 writeup and
CLAUDE.md's Gotchas section for the full story). The fix correctly
serializes every write through one SQLite connection per node, so a
genuine 200-way concurrent burst queues -- a real architectural ceiling,
not a bug. Throughput scaling with N (81 -> 220 uploads/sec) is the
direct upside of the same fact: each additional node is another fully
independent writer.

## Deploying (Render + Vercel)

Three nodes on Render (Docker), the client on Vercel, photos archived to
Supabase Storage. `render.yaml` is a working blueprint; read its header
before deploying, because two things differ from every local run.

### The part that actually breaks: raft timing

`raft.py`'s defaults (50ms heartbeat, 150–300ms election timeout, 50ms
per-RPC timeout) assume loopback, where an RPC is sub-millisecond. Between
three Render services an RPC is 20–200ms, so **a perfectly healthy peer
cannot meet those budgets** — every RPC times out, every election round
stalls, and the cluster churns leaders forever. This is the livelock
`raft.py`'s own RPC_TIMEOUT comment describes, triggered by latency rather
than a dead peer.

The timers are env-overridable for exactly this. Keep the *ratios*
(heartbeat ≪ election timeout; RPC timeout well under election timeout):

    RAFT_HEARTBEAT=1.0  RAFT_ELECTION_MIN=3.0  RAFT_ELECTION_MAX=6.0
    RAFT_RPC_TIMEOUT=1.0  GOSSIP_INTERVAL=2.0  GOSSIP_RPC_TIMEOUT=10.0

Failover becomes ~3–6s instead of ~250ms. That is the honest price of
running a LAN-tuned protocol across a network. **Don't apply these
locally** — ROADMAP.md's Phase 8 numbers stop describing the system.

### Deploying to Fly.io (recommended for the 3-node cluster)

Fly suits this system better than a public-URL PaaS for one concrete
reason: machines in the same region talk over a private network (6PN) at
~1ms, so raft's timers barely need relaxing. Render forces every heartbeat
out through the edge and back, which is why `render.yaml` has to detune
failover to 3–6s; on Fly it's ~1s. Volumes are also available without
jumping to a paid instance tier.

`fly/node1.toml`, `fly/node2.toml`, `fly/node3.toml` — one app per node, so
each gets its own volume and its own stable `.internal` address.

    fly auth login

    for n in node1 node2 node3; do
      fly apps create swarmlens-$n
      fly volumes create data --size 1 --app swarmlens-$n --region sin
      fly secrets set OPERATOR_TOKEN=<same value on all three> --app swarmlens-$n
      fly deploy -c fly/$n.toml --app swarmlens-$n
    done

Set `primary_region` and the volume region to the same place, and keep all
three there. Spread across regions and the private network stops being
~1ms, at which point these timers no longer hold and you need Render's
slower set.

Unlike Render, **the peer URLs need no second pass** — `.internal` names
are known before the apps exist, so `SELF_URL`/`PEERS` are already correct
in the toml files.

Three things in those files are load-bearing:

- **`HOST=::`** — 6PN is IPv6-only. Bound to `0.0.0.0` the process listens
  on IPv4 only, so its *public* health check passes while every peer's
  gossip and raft RPC is refused. That presents as three healthy nodes that
  never form a cluster.
- **Peers use `.internal`, not `.fly.dev`** — public addressing would push
  every heartbeat through the edge proxy, paying TLS and internet latency
  for traffic that never needed to leave the region. `SELF_URL` must match
  how peers address the node (it's the ring identity), so it's internal too.
- **`auto_stop_machines = false`** — a sleeping node is a partitioned node.

For the guest app and console, use the public hostnames
(`https://swarmlens-node1.fly.dev`, …) in `VITE_CLUSTER_URLS`. Only
node-to-node traffic uses `.internal`.

### Option A — deploy a prebuilt image (recommended)

`.github/workflows/docker-publish.yml` builds the node image on every push
and publishes it to GitHub Container Registry. Three identical services
then *pull* one image rather than each rebuilding the same Dockerfile,
which is faster and — more usefully — guarantees all three nodes run
identical bytes. A version skew between nodes in this system looks like a
distributed-systems fault, not a stale build, so removing that possibility
is worth more than the build minutes.

After the first successful workflow run, make the package public
(**GitHub → Packages → swarmlens-… → Package settings → Change
visibility**). Otherwise Render needs registry credentials to pull it.

Then in `render.yaml`, replace the two build lines on each service:

```yaml
    runtime: image
    image:
      url: ghcr.io/ye-thihaa/swarmlens-serverplusclient:latest
```

...in place of:

```yaml
    runtime: docker
    dockerfilePath: ./Dockerfile
```

Everything else (env vars, disks, health check) is unchanged. Pin to
`:sha-<commit>` instead of `:latest` when you want a deploy you can roll
back to exactly.

### Option B — let Render build from the Dockerfile

Leave `render.yaml` as committed. Simpler to start, but Render builds the
same image once per service.

### Backend on Render

1. Push the repo, then **New → Blueprint** and point it at `render.yaml`.
2. Render assigns hostnames only after the services exist, so the first
   deploy runs with placeholder peers and the nodes won't find each other.
   Once all three are up, replace `<n1>`/`<n2>`/`<n3>` in every service's
   `SELF_URL` and `PEERS` with the real `*.onrender.com` hostnames, then
   redeploy all three.
3. `PEERS` order must match the order used in `VITE_CLUSTER_URLS` below —
   `/chaos/partition/{i}` indexes into `PEERS` positionally.
4. Set `OPERATOR_TOKEN` to the same value on all three (marked
   `sync: false`, so Render prompts rather than storing it in git).
5. Set `SUPABASE_URL` / `SUPABASE_KEY` to enable the photo archive.

**Do not use the free plan.** Free instances sleep when idle, and a
sleeping node is a partitioned node: gossip stalls and raft re-elects
around it every time it drops.

Each node gets its own 1GB disk at `/data`, because SQLite holds the event
log *and* photo blobs and Render's filesystem is otherwise wiped on every
deploy. The cluster is partly self-healing here — a node that returns
empty refills from its peers by gossip, so a **rolling** deploy survives —
but losing all three at once does not, which is what the disks and the
Supabase archive are for.

### Frontend on Vercel

The client is TanStack Start (SSR + server functions), so it needs a Node
runtime — not a static host. `@lovable.dev/vite-tanstack-config` targets
**Cloudflare** by default, so Vercel needs the preset switched:

| Setting | Value |
|---|---|
| Root directory | `client-2` |
| Build command | `NITRO_PRESET=vercel npm run build` |
| Output directory | `.vercel/output` (Build Output API — auto-detected) |

Environment variables:

    NITRO_PRESET=vercel
    VITE_CLUSTER_URLS=https://<n1>.onrender.com,https://<n2>.onrender.com,https://<n3>.onrender.com
    CONSOLE_PASSWORD=<the console gate>
    OPERATOR_TOKEN=<same value as the three nodes>

`VITE_CLUSTER_URLS` replaces the hardcoded `127.0.0.1` cluster and feeds
**both** the operator console and the guest app (`configuredNodeUrls`
falls back to it), so it's the only URL setting to get right. It is baked
into the client bundle at build time — fine, since these are the same URLs
the guest app calls anyway. `OPERATOR_TOKEN` is *not* `VITE_`-prefixed and
never reaches the browser; it stays in the server functions.

**Leave `VITE_NODE_URLS` unset in production.** It exists only for the
local `/n1,/n2,/n3` dev proxy (`vite.config.ts`), which does not exist in
a built app — setting it would point the guest app at paths Vercel can't
route.

The nodes must be reachable over **HTTPS**: a Vercel page cannot call
`http://` URLs (mixed content). Render terminates TLS for you, so this is
automatic — but it's the reason `render.yaml` uses `https://` in `PEERS`
and `SELF_URL` too. CORS is already open (`allow_origins=["*"]` in
`main.py`).

## Guest client (client/)

Phase 5's other half: a React + TypeScript PWA with an offline Dexie.js
outbox and a `localStorage` vector clock, so guests can capture photos
with no connectivity and have them sync -- in original causal order --
once a node is reachable again.

    cd client
    npm install
    npm run dev

Defaults to talking to `localhost:8001,8002,8003`; override with
`VITE_NODE_URLS` if your cluster runs elsewhere. See
[`client/README.md`](client/README.md) for the full stack breakdown and
how it fits together with the backend -- it's a functional reference
implementation proving the offline+vclock mechanism, not the polished
branded guest UI.

## Branded guest app + operator console (client-2)

The actual branded frontend -- two separate apps (guest app, operator
console) sharing one design system -- wired to this backend in full:
real camera capture (zone picker only when an event actually has more
than one zone), a real QR join flow into whichever event was scanned,
real offline outbox, real gallery/likes/heatmap, and an operator console
with real Raft/gossip state, a hosted-events manager with printable QR
codes, a real event tape, and real chaos actions.

    npm --prefix client-2 run dev -- --host

Defaults to `:8080` (Vite auto-increments if that's taken -- check the
terminal output). Needs `client-2/.env` (gitignored; see
`client-2/.env.example`) with `CONSOLE_PASSWORD` and `OPERATOR_TOKEN` --
the latter also needs setting as an env var on the backend nodes above
to actually be enforced (`/chaos/*` fails open without it). See the
"Branded guest app + operator console" writeup in
[ROADMAP.md](ROADMAP.md) for what was built and the real bugs found
wiring it up, and CLAUDE.md's Files section for the file-by-file
breakdown.
