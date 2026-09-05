import asyncio
import base64
import os
import random
import re
import secrets
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import ai_engine
from store import DEFAULT_EVENT_ID, Store
from blob_archive import BlobArchive
from blob_sync import BlobSync
from gossip import Gossip
from worker import Worker
from raft import Raft
from hashing import ring_for, owner_of
from cloud_sync import CloudSync, TRUST_ENV as CLOUD_SYNC_TRUST_ENV

QUORUM_EVENT_KINDS = ("photo", "like", "aesthetic_score", "photo_delete")
# How many of a single guest's own photos can sit in the cross-guest public
# gallery (GET /photos/public) at once -- a deliberate curation cap, not a
# technical one. Enforced server-side in POST /photos/public so it holds
# regardless of which node a guest's toggle happens to land on.
# Env-overridable so test_events.py can drive the cap to its edge in a few
# requests instead of uploading 26 photos twice. The default is the real
# number and is mirrored by hand in client-2/src/lib/api.ts.
PUBLIC_LIMIT_PER_GUEST = int(os.getenv("PUBLIC_LIMIT_PER_GUEST", "25"))
# How many of an event's most-liked photos the end-of-event recap freezes
# into its slideshow. Env-overridable for the same reason
# PUBLIC_LIMIT_PER_GUEST is: a test can drive it to its edge with a
# handful of photos instead of uploading dozens twice.
RECAP_TOP_N = int(os.getenv("RECAP_TOP_N", "10"))
# Extra photos frozen beyond the visible N, held in reserve so GET /recap
# can backfill when a guest deletes one of their own frozen photos after
# the event. Without these the reel would simply shrink -- see
# send_event_recap for why deletion has to win over the snapshot.
RECAP_SPARES = int(os.getenv("RECAP_SPARES", "10"))
# Largest single photo accepted, decoded. Guards the blob store against
# one client (or one bug) writing an unbounded row; 12MB comfortably fits
# a full-resolution phone JPEG.
MAX_PHOTO_BYTES = int(os.getenv("MAX_PHOTO_BYTES", str(12 * 1024 * 1024)))

NODE_ID = os.getenv("NODE_ID", "node1")
DB_PATH = os.getenv("DB_PATH", f"./{NODE_ID}.db")
PEERS = [p for p in os.getenv("PEERS", "").split(",") if p]
INTERVAL = float(os.getenv("GOSSIP_INTERVAL", "1.0"))
# Ring identity: peers only ever know this node by its URL (that's what's
# in their PEERS list), never by NODE_ID. If self were keyed by NODE_ID
# while peers are keyed by URL, every node would compute a different
# member set for the same cluster and the ring would disagree with itself
# node to node. SELF_URL must be the address peers reach this node at.
SELF_URL = os.getenv("SELF_URL", "")
SELF_ID = SELF_URL or NODE_ID
N = len(PEERS) + 1   # fixed cluster size (this node + its configured peers)
# Gates the chaos endpoints (see require_operator_token below). Fails
# open -- same as always -- when unset, so test_quorum.py, load_test.py
# and dashboard.html, none of which ever set this, keep working exactly
# as before. Set it to actually protect a real running cluster; the
# operator console (client-2) sends it as X-Operator-Token once its own
# password gate (a separate secret, see client-2/.env) has been passed.
OPERATOR_TOKEN = os.getenv("OPERATOR_TOKEN", "")

store = Store(DB_PATH, NODE_ID)
gossip = Gossip(NODE_ID, PEERS, store, INTERVAL)
# Photo bytes replicate here, NOT through gossip -- see blob_sync.py's
# module docstring for the failure that split them apart.
blob_sync = BlobSync(NODE_ID, PEERS, store, gossip)
worker = Worker(NODE_ID, store)


async def send_event_recap(event_id: str):
    """Fires once per hosted event, no matter how many times it's
    triggered or how many leaders come and go -- store.recap_for(event_id)
    is the replicated-log check that makes that survive a leader crash
    (see CLAUDE.md's exactly-once gotcha), not local memory. Only the
    leader ever calls this.

    Snapshots the RECAP_TOP_N most-liked photos into the recap event's own
    payload at trigger time -- a frozen "most memorable" list, not
    something recomputed live every time a guest opens the slideshow
    afterward. A like that lands after the operator has called the event
    over shouldn't quietly reshuffle what "memorable" meant at that
    moment. Sorted by likes then photo_id so the snapshot is deterministic
    even in the rare case two would-be leaders both pass the exists-check
    in the same race window and compute it independently.

    Two things make the freeze survive real life rather than just a demo:

    - It stores RECAP_SPARES extra photos beyond the visible N. A guest
      can delete their own photo after the event (POST /photos/delete),
      and a frozen reel that referenced it would render a broken tile. The
      spares let GET /recap drop the deleted one and backfill, so a
      withdrawn photo costs the reel nothing rather than leaving a hole.
      Deletion has to win over the snapshot -- a guest who retracts a
      photo has withdrawn consent, and "the recap froze it first" is not
      an answer to that.
    - It records each photo's blob_hash. That's what pins those blobs:
      store.pinned_hashes() derives the protected set from these very
      events, so every node agrees on what must never be evicted and what
      blob_archive should upload first. A recap is meant to outlive its
      event, and recording the hash is what makes that true of the pixels
      and not just the metadata."""
    if await store.recap_for(event_id) is not None:
        return
    photos = await store.photos(event_id)
    ranked = sorted(photos, key=lambda p: (-p["likes"], p["photo_id"]))
    frozen = ranked[: RECAP_TOP_N + RECAP_SPARES]

    snapshot = []
    for p in frozen:
        # ensure_blob_for_photo, not p["blob_hash"]: a photo predating the
        # blob split has its bytes inline and no hash, so it could never be
        # pinned and therefore never archived -- and since cloud_sync stopped
        # shipping base64, that left pre-split photos with no off-cluster
        # copy at all. Materialising a blob here gives the recap a durable
        # handle on those pixels without rewriting the original event.
        snapshot.append({
            "photo_id": p["photo_id"],
            "guest_id": p["guest_id"],
            "zone": p["zone"],
            "likes": p["likes"],
            "blob_hash": await store.ensure_blob_for_photo(p["photo_id"]),
        })

    await store.append_local("recap_sent", {
        "event_id": event_id,
        "sent_by": NODE_ID,
        # How many of `photos` are meant to be shown; the rest are spares
        # held in reserve for deletions. Stored rather than assumed so a
        # reel frozen under one RECAP_TOP_N still renders at its original
        # length if the env var later changes.
        "visible": RECAP_TOP_N,
        "photos": snapshot,
    })


raft = Raft(NODE_ID, PEERS)
cloud_sync = CloudSync(NODE_ID, store, raft)
# Pushes recap-pinned photo bytes to object storage so a frozen recap
# outlives the cluster, not just the event. Disabled unless configured.
blob_archive = BlobArchive(NODE_ID, store, raft)


def cluster_members() -> list[str]:
    """Currently alive nodes (self + whatever gossip's failure detector
    still considers reachable). Recomputed fresh on every call, so the
    ring always reflects current membership -- nothing cached to go stale.
    Self is identified by SELF_ID (its URL) to match how peers list it,
    not NODE_ID -- see the SELF_URL comment above."""
    return sorted({SELF_ID, *gossip.alive_peers()})


def ring_key(zone: str, event_id: str | None) -> str:
    """What the consistent-hash ring actually hashes for a zone.

    Two events hosted on the same cluster will both have a zone called
    "main" (or "entrance", or "dance_floor") -- distinct corners of
    distinct rooms that happen to share a label. Hashing the bare zone
    name maps both to one owning node and, worse, makes /zones proxy the
    wedding's "main" score from a node computing the donation's "main",
    so the two events silently share one number. Namespacing by event is
    what keeps them separate on the ring.

    event_id=None keeps the pre-multi-event key exactly as it was, so a
    single-event cluster's ring assignment doesn't move (and neither do
    test_hashing.py's expectations)."""
    return zone if event_id is None else f"{event_id}/{zone}"


async def _zone_scores_local(event_id: str | None = None) -> dict[str, dict]:
    """Derived read: photos + CRDT like counts (store.photos()) plus the
    average aesthetic_score per zone (store.aesthetic_scores()) for
    whichever photos have been through /analyze so far -- None for a zone
    with no scored photos yet, not 0, so it's distinguishable from 'scored
    and bad'. Scoped to one event when event_id is given; None merges
    every event, which is what callers predating multi-event hosting
    still ask for."""
    aesthetic = await store.aesthetic_scores()
    zones: dict[str, dict] = {}
    scored: dict[str, list] = {}
    shooters: dict[str, dict] = {}
    for p in await store.photos(event_id):
        z = zones.setdefault(p["zone"], {"zone": p["zone"], "photos": 0, "likes": 0})
        z["photos"] += 1
        z["likes"] += p["likes"]
        tally = shooters.setdefault(p["zone"], {})
        tally[p["guest_id"]] = tally.get(p["guest_id"], 0) + 1
        s = aesthetic.get(p["photo_id"])
        if s is not None:
            scored.setdefault(p["zone"], []).append(s)
    for zone, z in zones.items():
        vals = scored.get(zone)
        z["avg_aesthetic"] = round(sum(vals) / len(vals), 2) if vals else None
        _finish_popularity(z, shooters.get(zone, {}))
    return zones


# "How many *people* shot here", not "how many frames were shot here".
# `guests` is the size of a set union over the photo events' own guest_id,
# which is the same CRDT shape as likes and merges the same way: two nodes
# that each saw a different guest during a partition converge on both, and
# a re-delivered event (gossip's normal behaviour) adds nothing the second
# time. A counter column could do neither -- merging 1 and 1 can't recover
# 2 without double-counting every retry.
POPULAR_GUEST_WEIGHT = 3
POPULAR_LIKE_WEIGHT = 2
# How many frames of one guest's burst still count toward the room thinking
# a spot is busy. Without a cap the frame term is unbounded and entirely
# attributable to one person, so a single enthusiast outranks an actual
# crowd: measured at 3 people with a frame each (score 12) losing to 1
# person with ten (13). That is precisely the claim this feature makes and
# precisely the claim that would then be false. Capping per guest keeps the
# busy-zone signal -- three people shooting ten frames each still outscores
# three people shooting one -- while denying any one of them the ability to
# manufacture a crowd alone.
POPULAR_FRAMES_PER_GUEST = 3


def _finish_popularity(z: dict, guest_frames: dict) -> None:
    """Attach `guests` + `popular_score` to a zone row already carrying
    `photos` and `likes`, given that zone's {guest_id: frames} tally.
    Called by both derivations below so the two can't drift apart --
    /zones and /zones/quorum answering different numbers for the same zone
    would be indistinguishable from a real replication bug.

    Still a pure function of the event set: the cap is applied to per-guest
    counts derived from the merged events, so merging first and scoring
    second gives the same answer as scoring per node. That is what keeps
    two converged replicas in agreement.

    Deliberately excludes avg_aesthetic: popular and good-looking are
    different claims (a plain corner everyone crowds into is genuinely
    popular), and mixing them produces a number nobody can explain.

    Deliberately has no time decay either. Without it the score depends
    only on which events exist, so any two converged replicas compute the
    same value -- the property this whole system exists to demonstrate.
    Decay would make it depend on each node's own wall clock, so two nodes
    holding identical logs would disagree. If "popular right now" is ever
    wanted, add it as a separate field and leave this one alone."""
    z["guests"] = len(guest_frames)
    counted_frames = sum(min(n, POPULAR_FRAMES_PER_GUEST) for n in guest_frames.values())
    z["popular_score"] = (
        z["guests"] * POPULAR_GUEST_WEIGHT + z["likes"] * POPULAR_LIKE_WEIGHT + counted_frames
    )


def _rank(zones) -> list[dict]:
    # Ranked by the same number the clients display, so the ordering and the
    # badge can never contradict each other. Zone name breaks ties, so a
    # scoreboard of equal scores is stable rather than dependent on dict
    # ordering (which differs between the local and merged derivations).
    #
    # The .get fallback is for one real case, not defensiveness: /zones
    # proxies each zone to its ring owner, so a row here can come from a
    # peer still running an older build during a restart. Reading the old
    # formula off that row keeps the endpoint answering instead of 500ing
    # on a KeyError while the cluster is mid-upgrade.
    def score(z):
        return z.get("popular_score", z["likes"] * 2 + z["photos"])

    return sorted(zones, key=lambda z: (-score(z), z["zone"]))


def _zone_scores_from_events(events, event_id: str | None = None) -> dict[str, dict]:
    """Same derivation as _zone_scores_local, but over an arbitrary merged
    event set instead of this node's own DB -- what /zones/quorum uses to
    recompute from the union of several nodes' partial views.

    Event filtering happens here, after the merge, rather than on the wire
    in /zones/events. A node can hold a like whose photo it hasn't
    received yet; dropping that like at the source because the sending
    node can't tell which event it belongs to would lose a count the
    merged view could have resolved. Only the photo carries an event_id,
    so restricting photo_zone below is enough -- likes, scores and
    tombstones for photos outside this event are simply never looked
    up."""
    photo_zone: dict[str, str] = {}
    photo_guest: dict[str, str] = {}
    like_guests: dict[str, set] = {}
    aesthetic: dict[str, float] = {}
    deleted: set[str] = set()
    for e in sorted(events, key=lambda e: e["created_at"]):
        p = e["payload"]
        if e["kind"] == "photo":
            if event_id is not None and p.get("event_id", DEFAULT_EVENT_ID) != event_id:
                continue
            photo_zone[p["photo_id"]] = p["zone"]
            photo_guest[p["photo_id"]] = p["guest_id"]
        elif e["kind"] == "like":
            like_guests.setdefault(p["photo_id"], set()).add(p["guest_id"])
        elif e["kind"] == "aesthetic_score":
            aesthetic[p["photo_id"]] = p["score"]  # last write wins -- sorted by created_at above
        elif e["kind"] == "photo_delete":
            deleted.add(p["photo_id"])

    zones: dict[str, dict] = {}
    scored: dict[str, list] = {}
    shooters: dict[str, dict] = {}
    for photo_id, zone in photo_zone.items():
        if photo_id in deleted:
            continue
        z = zones.setdefault(zone, {"zone": zone, "photos": 0, "likes": 0})
        z["photos"] += 1
        z["likes"] += len(like_guests.get(photo_id, ()))
        # After the tombstone check, so a guest whose only frame here was
        # retracted stops counting toward this zone being popular.
        tally = shooters.setdefault(zone, {})
        tally[photo_guest[photo_id]] = tally.get(photo_guest[photo_id], 0) + 1
        if photo_id in aesthetic:
            scored.setdefault(zone, []).append(aesthetic[photo_id])
    for zone, z in zones.items():
        vals = scored.get(zone)
        z["avg_aesthetic"] = round(sum(vals) / len(vals), 2) if vals else None
        _finish_popularity(z, shooters.get(zone, {}))
    return zones


@asynccontextmanager
async def lifespan(app: FastAPI):
    await store.open()
    await gossip.start()
    await blob_sync.start()
    await worker.start()
    await raft.start()
    await cloud_sync.start()
    await blob_archive.start()
    yield
    await blob_archive.stop()
    await cloud_sync.stop()
    await raft.stop()
    await worker.stop()
    await blob_sync.stop()
    await gossip.stop()
    await store.close()


app = FastAPI(title=f"SwarmLens {NODE_ID}", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


async def require_operator_token(x_operator_token: str = Header(default="")):
    """Gate for the chaos and event-management endpoints.
    secrets.compare_digest avoids a timing side-channel that would
    otherwise let an attacker guess the token one byte at a time. No-op
    (open) when OPERATOR_TOKEN isn't configured on this node -- see the
    constant's own comment for why."""
    if not OPERATOR_TOKEN:
        return
    if not secrets.compare_digest(x_operator_token, OPERATOR_TOKEN):
        raise HTTPException(401, "invalid or missing X-Operator-Token")


# ---------------------------- hosted events ----------------------------

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")


class EventIn(BaseModel):
    slug: str
    name: str
    venue: str = ""
    when: str = ""
    # The corners of this room a guest may tag a frame with. One zone (or
    # none, which becomes ["main"]) means the guest app shows no zone
    # picker at all -- most events are a single location and asking
    # someone to declare where they're standing is a question they
    # shouldn't have to answer. Several means the host has genuinely
    # divided the day (ceremony / reception), and the picker returns.
    zones: list[str] = []
    # Blank on create -> the server mints both. Passing an existing
    # event_id back is how an edit works: another event_created append,
    # last write wins (store.events_catalog).
    event_id: str = ""
    join_token: str = ""


@app.post("/events")
async def create_event(body: EventIn, _: None = Depends(require_operator_token)):
    """Register (or edit) a hosted event. Appends an event_created event
    -- gossiped, merged and replayed exactly like a photo, no new table
    and no new distributed mechanism.

    Slug uniqueness is checked against this node's replica only, and that
    is genuinely all it can be: two operators creating the same slug on
    two nodes during a partition will both succeed, and no amount of
    checking here changes that. What makes it safe is that resolution is
    deterministic -- GET /events/{slug} below picks the earliest-created
    match, which every node computes identically once gossip converges,
    so the losing event keeps its own event_id and its photos rather than
    being silently merged into the winner's."""
    slug = body.slug.strip().lower()
    if not SLUG_RE.match(slug):
        raise HTTPException(400, "slug must be lowercase letters, digits and dashes")
    if not body.name.strip():
        raise HTTPException(400, "an event needs a name")

    catalog = await store.events_catalog()
    event_id = body.event_id or f"ev_{uuid.uuid4().hex[:8]}"
    clash = next(
        (e for e in catalog.values() if e["slug"] == slug and e["event_id"] != event_id), None
    )
    if clash:
        raise HTTPException(409, f"slug '{slug}' already belongs to {clash['event_id']}")

    existing = catalog.get(event_id)
    payload = {
        "event_id": event_id,
        "slug": slug,
        "name": body.name.strip(),
        "venue": body.venue.strip(),
        "when": body.when.strip(),
        "zones": [z.strip() for z in body.zones if z.strip()] or ["main"],
        # Kept across edits: rotating it on every rename would silently
        # invalidate every QR already printed and sitting on the tables.
        "join_token": body.join_token
        or (existing or {}).get("join_token")
        or secrets.token_urlsafe(8),
        "created_by": NODE_ID,
    }
    await store.append_local("event_created", payload)
    return {"ok": True, **payload}


@app.get("/events")
async def list_events(
    status: str = "",
    limit: int = 50,
    offset: int = 0,
    _: None = Depends(require_operator_token),
):
    """The operator console's directory. Gated because a public list of
    every event on the cluster is the thing multi-tenant hosting exists to
    prevent: a wedding's guests have no business enumerating the funeral
    booked the same weekend. Guests resolve exactly one event, by slug plus
    token, through the endpoint below.

    Paginated, newest first, and **without join tokens**. Both matter once
    a venue has run a season rather than a demo: the console polls this
    every 5s, and the unpaginated version shipped every event ever hosted
    -- each with the credential that opens it -- on every poll, forever.
    A token is only needed when actually printing one event's QR, so it's
    fetched per event (GET /events/{slug}/token) instead of broadcast to a
    browser fifty at a time.

    `status` filters active/ended -- an event is "ended" once its recap has
    been frozen (there is no separate ended flag to disagree with the log),
    which is what makes a season's worth of finished events collapsible
    out of the way instead of crowding the one running tonight."""
    catalog = await store.events_catalog()
    ended = await store.recapped_event_ids()

    rows = []
    for e in catalog.values():
        row = {k: v for k, v in e.items() if k != "join_token"}
        row["status"] = "ended" if e["event_id"] in ended else "active"
        rows.append(row)

    if status in ("active", "ended"):
        rows = [r for r in rows if r["status"] == status]

    rows.sort(key=lambda e: (-e["created_at"], e["slug"]))
    limit = max(1, min(limit, 200))
    return {
        "node": NODE_ID,
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "events": rows[offset: offset + limit],
    }


@app.get("/events/{slug}/token")
async def event_join_token(slug: str, _: None = Depends(require_operator_token)):
    """One event's join token, for printing its QR. Split out of the list
    above so a directory poll doesn't ship every event's credential to the
    browser on a timer -- an operator needs exactly one token at the moment
    they print exactly one card."""
    matches = [e for e in (await store.events_catalog()).values() if e["slug"] == slug.lower()]
    if not matches:
        raise HTTPException(404, "no such event")
    event = min(matches, key=lambda e: (e["created_at"], e["event_id"]))
    return {"event_id": event["event_id"], "slug": event["slug"],
            "join_token": event.get("join_token", "")}


@app.get("/events/{slug}")
async def resolve_event(slug: str, k: str = ""):
    """What a scanned QR lands on: slug -> the event_id every subsequent
    guest call carries.

    `k` is NOT authentication and isn't presented as any: anyone holding
    the URL is in, exactly like GET /photos/public. It stops a guest who
    guesses or mistypes a slug from wandering into someone else's event,
    which is a real failure mode at a venue hosting three parties in one
    weekend -- nothing more. The token is never echoed back, so a
    successful resolve doesn't hand out a shareable credential the
    scanner didn't already have.

    Earliest-created match wins when two events somehow share a slug --
    see POST /events for why that's the honest resolution rule."""
    matches = [e for e in (await store.events_catalog()).values() if e["slug"] == slug.lower()]
    if not matches:
        raise HTTPException(404, "no such event")
    # event_id breaks a created_at tie so every node picks the same winner
    # even when two clocks read identically.
    event = min(matches, key=lambda e: (e["created_at"], e["event_id"]))
    if event.get("join_token") and not secrets.compare_digest(k, event["join_token"]):
        raise HTTPException(404, "no such event")
    return {"node": NODE_ID, "event": {kk: v for kk, v in event.items() if kk != "join_token"}}


# ---------------------------- client API ----------------------------

class PhotoIn(BaseModel):
    guest_id: str
    zone: str
    url: str = ""
    composition_score: int = 0
    vclock: dict[str, int] = {}
    image_base64: str | None = None
    # Which hosted event this frame belongs to. Deliberately the ONLY
    # request model that carries one: a like, an aesthetic score, a public
    # mark and a delete tombstone all name a globally-unique photo_id and
    # inherit that photo's event, so event membership is recorded in
    # exactly one place. Putting it on all five would create four more
    # copies that can disagree with the photo -- and a client that got one
    # wrong could push a like into an event its photo isn't in.
    event_id: str = DEFAULT_EVENT_ID


class LikeIn(BaseModel):
    guest_id: str
    photo_id: str
    vclock: dict[str, int] = {}


class PublicMarkIn(BaseModel):
    guest_id: str
    photo_id: str
    public: bool
    vclock: dict[str, int] = {}


class PhotoDeleteIn(BaseModel):
    guest_id: str
    photo_id: str
    vclock: dict[str, int] = {}


@app.post("/photos")
async def upload_photo(body: PhotoIn):
    """Accepts any event_id without checking it exists. That looks lax and
    isn't: event_created reaches this node by gossip like everything else,
    so a guest who scans a QR and shoots within the first second can
    legitimately hit a node that hasn't learned the event yet. Rejecting
    would turn a normal replication lag into a lost photo -- exactly the
    failure this whole system is built to avoid. An unknown event_id costs
    nothing: the photo is simply invisible until a matching event exists,
    and visible the moment one does.

    Image bytes do NOT go into the event. They're hashed into the blobs
    table and the event carries only {blob_hash, size, mime} -- see
    store.py's blobs schema for the three things inline base64 broke at
    event scale. The event log stays pure metadata, gossips as before, and
    the pixels replicate on their own out-of-band path (blob_sync.py)."""
    payload = body.model_dump(exclude={"vclock", "image_base64"})
    payload["photo_id"] = f"ph_{uuid.uuid4().hex[:8]}"

    if body.image_base64:
        try:
            raw = base64.b64decode(body.image_base64, validate=True)
        except Exception:
            raise HTTPException(400, "image_base64 is not valid base64")
        if len(raw) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "photo too large")
        payload["blob_hash"] = await store.put_blob(raw)
        payload["size"] = len(raw)
        payload["mime"] = "image/jpeg"

    event = await store.append_local("photo", payload, vclock=body.vclock)
    return {"ok": True, "photo_id": payload["photo_id"], "seq": event["seq"]}


@app.post("/likes")
async def like_photo(body: LikeIn):
    await store.append_local("like", body.model_dump(exclude={"vclock"}), vclock=body.vclock)
    return {"ok": True, "likes": await store.like_count(body.photo_id)}


def _vclock_leq(a: dict, b: dict) -> bool:
    """True if a happened-before-or-equal b in the vector clock partial order."""
    return all(v <= b.get(k, 0) for k, v in a.items())


def _concurrent(a: dict, b: dict) -> bool:
    """True only when both clocks carry real causal info and neither
    dominates the other. An empty clock (no guest device attached one --
    true for every event until a real guest client exists) carries no
    causal info, so it's never flagged concurrent with anything; that
    would be asserting knowledge we don't have."""
    if not a or not b:
        return False
    return not _vclock_leq(a, b) and not _vclock_leq(b, a)


@app.get("/photos")
async def list_photos(event_id: str | None = None):
    """Gallery as this node currently sees it. Each photo carries its own
    vclock (empty if the guest client didn't attach one) plus
    concurrent_with: other photo_ids whose vclock is concurrent with this
    one -- neither happened before the other -- so a gallery UI can
    render them side by side instead of implying a false total order
    from arrival time. O(n^2) over this node's photos; fine at demo
    scale, same tradeoff /zones already makes.

    event_id scopes this to one hosted event. concurrent_with is computed
    *after* that filter on purpose: telling a wedding guest their frame
    was shot at the same moment as one from a donation ceremony they'll
    never see is noise, not causality they can act on."""
    photos = await store.photos(event_id)
    for p in photos:
        p["concurrent_with"] = [
            q["photo_id"] for q in photos
            if q["photo_id"] != p["photo_id"] and _concurrent(p["vclock"], q["vclock"])
        ]
    return {"node": NODE_ID, "photos": photos}


@app.get("/photos/{photo_id}/image")
async def photo_image(photo_id: str):
    """Serves one photo's actual image bytes. Split out from GET /photos so
    the list endpoint (polled every few seconds by every guest client)
    stays light instead of shipping every photo's bytes on every poll.

    Since the blob split, metadata and pixels replicate on separate paths:
    the photo event arrives by gossip in ~1s, its blob arrives by
    blob_sync's byte-budgeted loop, which is deliberately slower. So a node
    can legitimately know about a photo whose bytes it doesn't hold yet.
    Rather than 404 (which a client renders as a permanently broken image),
    this reads through to a peer that does have it, caches the result, and
    serves it -- the fetch also warms this node for the next request. Only
    a photo no node has, or one that was never uploaded with bytes at all
    (metadata-only test photos), actually 404s."""
    found = await store.photo_image(photo_id)
    if found is None and photo_id not in await store.deleted_photo_ids():
        blob_hash = await store.blob_hash_for_photo(photo_id)
        if blob_hash:
            found = await blob_sync.fetch_from_peer(blob_hash)
            if found is None:
                # Last resort: object storage. Without this the archive is
                # write-only -- bytes uploaded and never readable again,
                # which is not the durability the archive exists to give.
                # This is the case it was built for: a recap replayed after
                # the cluster that produced it is gone or has lost the blob.
                found = await _fetch_archived(blob_hash)
    if found is None:
        raise HTTPException(404, "no image stored for this photo")
    image_bytes, mime = found
    return Response(content=image_bytes, media_type=mime or "image/jpeg")


async def _fetch_archived(blob_hash: str) -> tuple[bytes, str] | None:
    """Pull a blob back from object storage and re-cache it locally, so the
    next read is served from disk. Returns None when this blob was never
    archived (the common case -- only recap-pinned blobs are) or the
    archive is unreachable; the caller then 404s as before."""
    url = await store.archived_url_for(blob_hash)
    if not url:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0, trust_env=CLOUD_SYNC_TRUST_ENV) as client:
            r = await client.get(url)
            r.raise_for_status()
    except Exception:
        return None
    mime = r.headers.get("content-type", "image/jpeg")
    await store.put_blob(r.content, mime)
    return r.content, mime


@app.post("/photos/public")
async def mark_photo_public(body: PublicMarkIn):
    """Opts one of THIS guest's own photos into (or out of) the
    cross-guest public gallery (GET /photos/public below) -- individual
    photos a guest hand-picks, not the composited strips routes/album.tsx
    already posts to zone "photo_booth". Ownership is checked against the
    photo event's own guest_id, not the caller-supplied one, so the
    per-guest cap below can't be bypassed by mislabeling whose photo it
    is. Appends a public_mark event -- gossips, replicates and converges
    exactly like every other event kind, no new distributed mechanism."""
    photo = await store.photo_by_id(body.photo_id)
    if not photo:
        raise HTTPException(404, "unknown photo")
    if photo["guest_id"] != body.guest_id:
        raise HTTPException(403, "only a photo's own guest can change its public status")
    if body.public:
        state = await store.public_state()
        already_public = state.get(body.photo_id, {}).get("public", False)
        if not already_public:
            # The cap is per guest PER EVENT, and the event comes from the
            # photo's own record, not from anything the caller sent. A
            # guest who shoots at three weddings gets 25 public frames at
            # each -- counting across all of them would silently spend
            # tonight's quota on last month's.
            event_id = photo.get("event_id", DEFAULT_EVENT_ID)
            in_event = {p["photo_id"] for p in await store.photos(event_id)}
            count = sum(
                1
                for pid, v in state.items()
                if v["public"] and v["guest_id"] == body.guest_id and pid in in_event
            )
            if count >= PUBLIC_LIMIT_PER_GUEST:
                raise HTTPException(
                    409, f"already at the {PUBLIC_LIMIT_PER_GUEST}-photo public limit for this event"
                )
    await store.append_local("public_mark", body.model_dump(exclude={"vclock"}), vclock=body.vclock)
    return {"ok": True, "public": body.public}


@app.get("/photos/public")
async def public_photos(event_id: str | None = None):
    """The cross-guest public gallery: every photo whose own guest has
    opted it in via POST /photos/public above, latest toggle wins --
    derived from the log the same way every other read here is, no
    second "is_public" column living outside the event stream. GET
    /photos already carries everything a gallery card needs (guest_id,
    likes, taken_at, zone); this just filters that down to the public
    subset instead of introducing a parallel shape."""
    state = await store.public_state()
    photos = await store.photos(event_id)
    public = [p for p in photos if state.get(p["photo_id"], {}).get("public")]
    return {"node": NODE_ID, "photos": public}


@app.post("/photos/delete")
async def delete_photo(body: PhotoDeleteIn):
    """Retracts one of THIS guest's own photos everywhere: the room feed
    (GET /photos), zone scores (local and quorum), likes, and the public
    gallery, on every node once gossip catches up. A photo that was never
    made public doesn't come through here at all -- client-2's mine.tsx
    only calls this endpoint for a photo currently in the public gallery;
    a private roll photo is deleted by the guest's own device splicing it
    out of localStorage, since the event log never replicated it anywhere
    that needs telling. Appends photo_delete, a tombstone every derived
    read filters on (store.deleted_photo_ids) -- one choke point, same
    pattern as public_mark, not a second flag column. Ownership is
    checked against the photo event's own guest_id, never the
    caller-supplied one. Idempotent: deleting an already-deleted photo_id
    just appends a second, harmless tombstone."""
    photo = await store.photo_by_id(body.photo_id)
    if not photo:
        raise HTTPException(404, "unknown photo")
    if photo["guest_id"] != body.guest_id:
        raise HTTPException(403, "only a photo's own guest can delete it")
    await store.append_local("photo_delete", body.model_dump(exclude={"vclock"}), vclock=body.vclock)
    return {"ok": True}


class AnalyzeIn(BaseModel):
    photo_id: str
    image_base64: str | None = None


@app.post("/analyze")
async def analyze_photo(body: AnalyzeIn):
    """Saliency -> AR guide, CLIP -> filter suggestion, CLIP + a linear
    head -> aesthetic score (ai_engine.py; all pretrained, nothing trained
    here). Runs on a thread (ai_engine.analyze is synchronous, CPU-bound
    ONNX/OpenCV work) so it never blocks this node's asyncio loop -- gossip
    and raft both depend on that loop staying responsive.

    image_base64 is the normal path: this backend has no photo-binary
    storage, only zone/composition_score metadata (see PhotoIn), so
    there's nowhere else to get pixels from a bare photo_id unless that
    photo was uploaded with a real, externally-fetchable `url`.

    The aesthetic_score is written with store.append_local exactly like a
    photo or like event -- no second replication path. It gossips, merges
    on (origin, seq), and feeds /zones and /zones/quorum the same way
    everything else in the log already does."""
    if body.image_base64:
        try:
            image_bytes = base64.b64decode(body.image_base64, validate=True)
        except Exception:
            raise HTTPException(400, "image_base64 is not valid base64")
    else:
        # Since the blob split there IS a local source of pixels for a bare
        # photo_id, which there wasn't when this endpoint was written --
        # try it before falling back to refetching an external url.
        stored = await store.photo_image(body.photo_id)
        if stored is not None:
            image_bytes = stored[0]
        else:
            photo = await store.photo_by_id(body.photo_id)
            if not photo or not photo.get("url"):
                raise HTTPException(
                    400, "no image_base64 given, no stored bytes, and no fetchable url"
                )
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                r = await client.get(photo["url"])
                r.raise_for_status()
                image_bytes = r.content

    result = await asyncio.to_thread(ai_engine.analyze, image_bytes)

    await store.append_local("aesthetic_score", {
        "photo_id": body.photo_id,
        "score": result["aesthetic_score"],
        "computed_by": NODE_ID,
    })

    return {
        "ar_guide": result["ar_guide"],
        "suggested_filter": result["suggested_filter"],
        "aesthetic_score": result["aesthetic_score"],
    }


class AnalyzePreviewIn(BaseModel):
    image_base64: str
    # The crop ratio the client is actually shooting (width/height), so the
    # rectangle it draws matches the frame it will get. Optional -- falls
    # back to the submitted frame's own aspect.
    aspect: float | None = None


# How many preview analyses may run at once on this node. Each one occupies
# a thread for ~0.05-1s of ONNX/OpenCV work; several guests pointing their
# viewfinders at the same node would otherwise saturate the default thread
# pool, which is shared with every other asyncio.to_thread caller here.
PREVIEW_CONCURRENCY = int(os.getenv("PREVIEW_CONCURRENCY", "2"))
MAX_PREVIEW_BYTES = 2 * 1024 * 1024
_preview_slots = asyncio.Semaphore(PREVIEW_CONCURRENCY)


@app.post("/analyze/preview")
async def analyze_preview(body: AnalyzePreviewIn):
    """Live-viewfinder guidance: subject box, a rule-of-thirds crop
    rectangle, a film-stock recommendation and why. Same models as
    /analyze (ai_engine.preview) and the same to_thread offload.

    The difference that matters is that this writes NOTHING. /analyze
    appends an aesthetic_score event, which is correct for a photo that
    exists; a viewfinder calls this every couple of seconds against a
    frame that was never shot and has no photo_id. Persisting those would
    flood the append-only log, gossip every one of them to all three
    nodes, and drag /zones' avg_aesthetic toward frames no guest ever
    kept. If you add a field here, resist the urge to record it.

    Fails fast with 503 when every preview slot is busy rather than
    queueing: guidance computed for a frame the guest has already panned
    away from is worse than no guidance, and a queue would keep serving
    staler and staler answers under load. The client simply asks again on
    its next tick."""
    if len(body.image_base64) > MAX_PREVIEW_BYTES:
        raise HTTPException(413, "preview frame too large -- downscale before sending")
    if body.aspect is not None and not (0.2 <= body.aspect <= 5.0):
        raise HTTPException(400, "aspect must be between 0.2 and 5.0")
    try:
        image_bytes = base64.b64decode(body.image_base64, validate=True)
    except Exception:
        raise HTTPException(400, "image_base64 is not valid base64")

    if _preview_slots.locked():
        raise HTTPException(503, "preview busy, try the next frame")

    async with _preview_slots:
        try:
            return await asyncio.to_thread(ai_engine.preview, image_bytes, body.aspect)
        except Exception as e:
            # A malformed/undecodable frame is a client problem, not a node
            # fault -- and this endpoint is called on a loop, so a 500 here
            # would spam the log a few times a second.
            raise HTTPException(400, f"could not analyze frame: {e}")


@app.get("/zones")
async def zone_scores(event_id: str | None = None):
    """The emergent aesthetic map. Each zone's authoritative score comes
    from whichever node owns it on the consistent-hash ring -- proxied
    live if that's a peer, computed directly if it's us. If the owner is
    unreachable, falls back to this node's own (possibly lagging) replica
    with stale: true rather than failing the request.

    Ownership is per (event, zone) -- see ring_key. The proxied call
    carries event_id through, so the owner recomputes the same event's
    score rather than answering with its merged view of every event it
    happens to hold."""
    local = await _zone_scores_local(event_id)
    ring = ring_for(cluster_members())

    out = []
    # trust_env=False: `owner` is always a peer from PEERS/SELF_ID, i.e.
    # always 127.0.0.1 -- see the same note in gossip.py for why a system
    # proxy would otherwise break this.
    async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
        for zone, mine in local.items():
            owner = owner_of(ring_key(zone, event_id), ring)
            if owner == SELF_ID:
                out.append({**mine, "owner": owner, "stale": False})
                continue
            try:
                params = {"event_id": event_id} if event_id is not None else None
                r = await client.get(f"{owner}/zones/local", params=params)
                r.raise_for_status()
                remote = {z["zone"]: z for z in r.json()["zones"]}
                if zone in remote:
                    out.append({**remote[zone], "owner": owner, "stale": False})
                    continue
            except Exception:
                pass
            out.append({**mine, "owner": owner, "stale": True})

    return {"node": NODE_ID, "zones": _rank(out)}


@app.get("/zones/local")
async def zones_local(event_id: str | None = None):
    """This node's own replica, every zone, no ownership filtering. Not
    for clients -- this is what peers call when proxying a zone they
    don't own, and what a node falls back to reading from itself when the
    owner is unreachable."""
    scores = await _zone_scores_local(event_id)
    return {"node": NODE_ID, "zones": _rank(list(scores.values()))}


@app.get("/zones/ring")
async def zones_ring(event_id: str | None = None):
    """Debug: current membership and the zone -> owner mapping it implies.
    Useful for demoing how few zones move when a node joins or leaves --
    and, with event_id, for showing that two events' identically-named
    zones land on different owners rather than colliding."""
    members = cluster_members()
    ring = ring_for(members)
    scores = await _zone_scores_local(event_id)
    owners = {zone: owner_of(ring_key(zone, event_id), ring) for zone in scores}
    return {"node": NODE_ID, "event_id": event_id, "members": members, "owners": owners}


@app.get("/zones/events")
async def zones_events():
    """Raw photo/like/aesthetic_score events from this node's own replica,
    undigested. Not for clients -- this is what /zones/quorum fetches from
    each node it samples, so it can union events across nodes and
    recompute rather than trust one node's already-aggregated counts."""
    return {"node": NODE_ID, "events": await store.raw_events(QUORUM_EVENT_KINDS)}


@app.get("/zones/quorum")
async def zones_quorum(R: int = 2, W: int = 2, event_id: str | None = None):
    """Quorum read: sample R of N nodes (this node is just one candidate
    among them, not privileged), union their raw photo/like events --
    deduped on (origin, seq), the same idempotence key gossip relies on
    -- and recompute scores from the merge. Which R members get sampled
    is random on every call, on purpose: that's what makes 'sometimes you
    land on the stale node' an observable, repeatable demo rather than a
    one-off.

    With R > N/2, any sample is guaranteed to include at least one node
    outside a single-node partition, so the union is always complete.
    With R=1 a sample can land entirely on a partitioned/lagging node and
    return an undercount until it's healed and gossip catches it up.

    W is accepted and echoed back for the CAP-tradeoff narrative only --
    this system's writes are always local + eventually gossiped, there's
    no synchronous quorum write path for W to gate."""
    R = max(1, min(R, N))
    W = max(1, min(W, N))

    members = [SELF_ID] + PEERS
    chosen = random.sample(members, R)

    merged: dict[tuple[str, int], dict] = {}
    queried, unreachable = [], []
    # trust_env=False: `member` is always PEERS/SELF_ID, always
    # 127.0.0.1 -- see the same note in gossip.py.
    async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
        for member in chosen:
            if member == SELF_ID:
                events = await store.raw_events(QUORUM_EVENT_KINDS)
                queried.append(member)
            else:
                try:
                    r = await client.get(f"{member}/zones/events")
                    r.raise_for_status()
                    events = r.json()["events"]
                    queried.append(member)
                except Exception:
                    unreachable.append(member)
                    continue
            for e in events:
                merged[(e["origin"], e["seq"])] = e

    scores = _zone_scores_from_events(merged.values(), event_id)
    return {
        "node": NODE_ID,
        "event_id": event_id,
        "N": N,
        "R": R,
        "W": W,
        "strongly_consistent": R + W > N,
        "queried": queried,
        "unreachable": unreachable,
        "zones": _rank(list(scores.values())),
    }


# ---------------------------- gossip API ----------------------------

class SyncIn(BaseModel):
    from_: str = ""
    digest: dict[str, int] = {}

    model_config = {"populate_by_name": True}


@app.post("/gossip/sync")
async def gossip_sync(body: dict):
    """Peer sends its digest; we return our digest plus everything it lacks."""
    peer_digest = body.get("digest", {})
    return {
        "node": NODE_ID,
        "digest": await store.digest(),
        "events": await store.events_missing_from(peer_digest),
    }


@app.post("/gossip/push")
async def gossip_push(body: dict):
    merged = await store.merge_remote(body.get("events", []))
    return {"node": NODE_ID, "merged": merged}


# ---------------------------- blobs (photo bytes) ----------------------------

@app.get("/blobs/digest")
async def blobs_digest():
    """Which blobs this node holds, hashes only. Peer-facing, cheap enough
    to call every round -- a hash is 64 bytes where the blob it names is
    ~150KB, which is the entire point of exchanging these instead of the
    bytes themselves."""
    return {"node": NODE_ID, "hashes": sorted(await store.blob_hashes())}


@app.get("/blobs/{blob_hash}")
async def get_blob(blob_hash: str):
    """Serve one blob's raw bytes to a peer (blob_sync.py's pull loop, or
    another node's read-through on behalf of a guest). 404 means "not
    here", which is a routine answer during replication, not an error --
    the caller just tries the next peer."""
    found = await store.get_blob(blob_hash)
    if found is None:
        raise HTTPException(404, "blob not held by this node")
    raw, mime = found
    return Response(content=raw, media_type=mime or "image/jpeg")


# ---------------------------- raft ----------------------------

class RequestVoteIn(BaseModel):
    term: int
    candidate_id: str


class HeartbeatIn(BaseModel):
    term: int
    leader_id: str


@app.post("/raft/request_vote")
async def raft_request_vote(body: RequestVoteIn):
    return await raft.handle_request_vote(body.term, body.candidate_id)


@app.post("/raft/heartbeat")
async def raft_heartbeat(body: HeartbeatIn):
    return await raft.handle_heartbeat(body.term, body.leader_id)


@app.get("/raft/status")
async def raft_status():
    return raft.status()


@app.post("/recap/trigger")
async def recap_trigger(event_id: str = DEFAULT_EVENT_ID, _: None = Depends(require_operator_token)):
    """Fire the one-time 'event recap ready' snapshot for one hosted
    event. Safe to call on every node (a client doesn't know who the
    leader is) or more than once (idempotent) -- only the leader acts, and
    only the first time. Same operator gate as /chaos/* and /events:
    calling an event over and freezing its highlight reel is an operator
    decision, not a guest one."""
    if raft.role == "leader":
        await send_event_recap(event_id)
        return {"triggered": True, "by": NODE_ID, "event_id": event_id}
    return {"triggered": False, "by": NODE_ID, "event_id": event_id}


@app.get("/recap")
async def get_recap(event_id: str = DEFAULT_EVENT_ID):
    """The frozen top-liked snapshot for one hosted event, if its recap
    has fired -- what client-2's slideshow route renders. No operator
    gate, same reasoning as GET /photos/public: a guest coming back after
    the event ended to relive it is exactly who this is for, and the
    snapshot carries nothing an unauthenticated guest couldn't already see
    on GET /photos.

    The ranking is frozen; the *membership* still honours deletion. A
    guest can retract one of their own photos after the event, and a
    withdrawn photo must disappear from the reel even though the snapshot
    named it -- consent outranks the freeze. Spares frozen alongside the
    visible N (see send_event_recap) backfill the gap, so a deletion
    shortens the reel only once the reserve is exhausted."""
    recap = await store.recap_for(event_id)
    if recap is None:
        return {"event_id": event_id, "ready": False, "photos": []}

    deleted = await store.deleted_photo_ids()
    visible = recap.get("visible", RECAP_TOP_N)
    kept = [p for p in recap["photos"] if p["photo_id"] not in deleted]
    served = kept[:visible]

    # Counted against the slots that were originally on screen, not against
    # how many photos were deleted -- those differ the moment the reserve
    # runs dry (6 deletions with 5 spares is 5 backfills, not 6), and
    # "short" has to mean the reel actually shrank, which happens whenever
    # fewer than `visible` survive however many were frozen. An earlier
    # version reported the deletion count and gated "short" on there having
    # been a reserve at all, so an event that froze exactly `visible`
    # photos lost one and reported everything fine.
    originally_visible = {p["photo_id"] for p in recap["photos"][:visible]}
    return {
        "event_id": event_id,
        "ready": True,
        "photos": served,
        "backfilled": sum(1 for p in served if p["photo_id"] not in originally_visible),
        "short": len(served) < visible,
    }


# ---------------------------- cloud archive sync ----------------------------

@app.post("/cloud_sync/trigger")
async def cloud_sync_trigger():
    """Force a sync tick now instead of waiting for CLOUD_SYNC_INTERVAL --
    mainly for tests/demos. Same no-op rules as the background loop: 0
    synced if this node isn't leader, or if SUPABASE_URL isn't configured
    (cloud_sync.enabled is False), or if the cloud is unreachable (check
    last_error, not an exception -- a network blip here should never 500
    the request)."""
    async with httpx.AsyncClient(timeout=10.0, trust_env=CLOUD_SYNC_TRUST_ENV) as client:
        n = await cloud_sync.sync_once(client)
    return {"synced": n, **cloud_sync.status()}


@app.get("/cloud_sync/status")
async def cloud_sync_status():
    return cloud_sync.status()


@app.post("/blob_archive/trigger")
async def blob_archive_trigger(_: None = Depends(require_operator_token)):
    """Force an archive tick now rather than waiting for
    BLOB_ARCHIVE_INTERVAL -- mainly for tests/demos, and for an operator
    who wants a recap's photos safely off-cluster before packing up.
    Same no-op rules as the loop: leader only, disabled without Supabase
    credentials, and an unreachable archive is reported in last_error
    rather than raised.

    Gated, unlike /cloud_sync/trigger: this one spends money. An
    unauthenticated caller could otherwise loop it and run up a storage
    bill on someone else's Supabase project."""
    async with httpx.AsyncClient(timeout=30.0, trust_env=CLOUD_SYNC_TRUST_ENV) as client:
        n = await blob_archive.archive_once(client)
    return {"uploaded": n, **blob_archive.status()}


@app.get("/blob_archive/status")
async def blob_archive_status():
    return {**blob_archive.status(), "blobs": await store.blob_stats(with_pinned=True)}


# ---------------------------- ops & chaos ----------------------------

@app.get("/jobs/{photo_id}")
async def job_status(photo_id: str):
    return await store.job_state(photo_id)


@app.get("/jobs")
async def all_jobs():
    photos = await store.photos()
    return {p["photo_id"]: await store.job_state(p["photo_id"]) for p in photos}


@app.get("/health")
async def health():
    return {
        "node": NODE_ID,
        "events": await store.event_count(),
        "digest": await store.digest(),
        "gossip": gossip.stats(),
        "blob_sync": blob_sync.stats(),
        "blobs": await store.blob_stats(),
        "raft": raft.status(),
        "cloud_sync": cloud_sync.status(),
    }


@app.post("/chaos/partition/{peer_index}")
async def partition(peer_index: int, _: None = Depends(require_operator_token)):
    """Simulate a network split without touching Docker or iptables."""
    peer = PEERS[peer_index]
    gossip.partitioned.add(peer)
    return {"partitioned_from": peer}


@app.post("/chaos/heal")
async def heal(_: None = Depends(require_operator_token)):
    gossip.partitioned.clear()
    return {"partitioned_from": []}


@app.get("/dashboard")
async def dashboard():
    """Static, dependency-free chaos + metrics dashboard (dashboard.html):
    polls GET /health + raft status on all 3 nodes every 1s, drives the
    existing /chaos/* endpoints. Served by every node identically -- open
    it on any one of the three, it talks to all three via CORS (already
    wide open, see the middleware above). No real kill -9 button: see
    CLAUDE.md/README.md for why that was deliberately left unbuilt."""
    return FileResponse(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html"))
