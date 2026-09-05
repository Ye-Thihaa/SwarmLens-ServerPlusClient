import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { GuestTabs, PerfRail } from "@/guest/ui";
import {
  CLUSTER_SIZE,
  deletePhoto,
  getPublicPhotos,
  photoImageUrl,
  pickNode,
  prettyZone,
  PUBLIC_LIMIT_PER_GUEST,
  replicaAcks,
  setPhotoPublic,
} from "@/lib/api";
import { useCurrentEvent } from "@/lib/event";
import { currentDeviceId, currentGuestId, tick } from "@/lib/guest";
import { photosForEvent, removePhoto, syncOutbox, useOutbox, type OutboxPhoto } from "@/lib/outbox";

export const Route = createFileRoute("/mine")({
  head: () => ({
    meta: [
      { title: "My roll — SwarmLens" },
      {
        name: "description",
        content:
          "Your own frames from tonight, and exactly how far each one has travelled into the room's shared picture.",
      },
      { property: "og:title", content: "My roll — SwarmLens" },
      {
        property: "og:description",
        content: "Frames waiting on the roll, frames now part of the room.",
      },
    ],
  }),
  component: Mine,
});

function Mine() {
  const [who, setWho] = useState<{ guest: string; device: string } | null>(null);
  const [acks, setAcks] = useState<Record<string, number>>({});
  const [syncing, setSyncing] = useState(false);
  const [node, setNode] = useState<string | null>(null);
  // photo_ids of THIS guest's own photos currently in the public gallery --
  // polled from the cluster (the source of truth) rather than kept purely
  // optimistic, so a toggle made from a second device shows up here too.
  const [publicIds, setPublicIds] = useState<Set<string>>(new Set());
  const [publicBusyId, setPublicBusyId] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  // Two-tap delete: first tap arms it, second tap (within the same card)
  // confirms -- a destructive action that can retract a photo everywhere
  // shouldn't fire on a single mis-tap.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const event = useCurrentEvent();
  const outbox = useOutbox();
  // "Your roll" means your roll AT THIS EVENT. The same phone at two events
  // is two guests with two rolls -- see guest.ts's currentGuestId -- so
  // mixing them here would show frames this guest_id doesn't even own and
  // couldn't publish or delete.
  const roll = useMemo(
    () => photosForEvent(outbox, event.event_id).sort((a, b) => b.created_at - a.created_at),
    [outbox, event.event_id],
  );

  useEffect(() => {
    setWho({ guest: currentGuestId(event.event_id), device: currentDeviceId() });
  }, [event.event_id]);

  // Real replica counts: how many of the N configured nodes have already
  // gossiped each of this device's synced photos in. Polled, not
  // computed once, so convergence is visible happening live.
  useEffect(() => {
    const photoIds = roll.filter((p) => p.synced && p.photo_id).map((p) => p.photo_id!);
    if (photoIds.length === 0) return;
    let cancelled = false;
    async function poll() {
      const result = await replicaAcks(photoIds, event.event_id);
      if (!cancelled) setAcks(result);
    }
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.map((p) => p.photo_id).join(","), event.event_id]);

  // This guest's own slice of GET /photos/public, polled the same way
  // everything else on this page is -- so a device that goes public from
  // a second phone, or gets bumped by a room-wide toggle, still converges
  // here without a manual refresh.
  useEffect(() => {
    if (!who) return;
    let cancelled = false;
    async function poll() {
      const n = await pickNode();
      if (cancelled) return;
      setNode(n);
      if (!n) return;
      try {
        const pub = await getPublicPhotos(n, event.event_id);
        if (!cancelled) {
          setPublicIds(new Set(pub.filter((p) => p.guest_id === who!.guest).map((p) => p.photo_id)));
        }
      } catch {
        // stay on the last known-good read
      }
    }
    void poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [who, event.event_id]);

  async function togglePublic(p: OutboxPhoto) {
    if (!node || !p.photo_id || !who) return;
    const makePublic = !publicIds.has(p.photo_id);
    setPublicBusyId(p.local_id);
    const res = await setPhotoPublic(node, {
      guest_id: who.guest,
      photo_id: p.photo_id,
      public: makePublic,
      vclock: tick(),
    });
    if (res.ok) {
      setLimitHit(false);
      setPublicIds((s) => {
        const next = new Set(s);
        if (makePublic) next.add(p.photo_id!);
        else next.delete(p.photo_id!);
        return next;
      });
    } else if (res.reason === "limit") {
      setLimitHit(true);
    }
    setPublicBusyId(null);
  }

  /** A photo that was never made public was never shared beyond this
   * device -- deleting it is purely local, no network call at all. A
   * photo currently in the public gallery needs the real tombstone
   * first (see api.ts's deletePhoto docstring), and only comes out of
   * the roll once that's actually confirmed -- if the cluster is
   * unreachable, the photo stays put rather than vanishing locally
   * while the room still has it. */
  async function deleteRollPhoto(p: OutboxPhoto) {
    const isPublic = Boolean(p.photo_id && publicIds.has(p.photo_id));
    if (isPublic && p.photo_id && who) {
      const n = node ?? (await pickNode());
      if (!n) {
        setDeleteError("Can't reach the room to remove this everywhere — try again in a moment.");
        return;
      }
      setDeletingId(p.local_id);
      const res = await deletePhoto(n, { guest_id: who.guest, photo_id: p.photo_id, vclock: tick() });
      setDeletingId(null);
      if (!res.ok) {
        setDeleteError("Couldn't delete it from the room — try again.");
        return;
      }
      setPublicIds((s) => {
        const next = new Set(s);
        next.delete(p.photo_id!);
        return next;
      });
    }
    setDeleteError(null);
    setConfirmDeleteId(null);
    removePhoto(p.local_id);
  }

  const heldCount = roll.filter(
    (p) => p.synced && p.photo_id && (acks[p.photo_id] ?? 0) === CLUSTER_SIZE,
  ).length;

  return (
    <main className="grain min-h-screen pb-24">
      <header className="border-b border-border px-5 pt-8 pb-5">
        <p className="label-mono">{who ? `${who.guest} · ${who.device}` : " "}</p>
        <h1 className="mt-2 text-3xl font-extrabold">Your roll</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {roll.length} frames tonight. {heldCount} {heldCount === 1 ? "has" : "have"} joined the
          room's picture.
        </p>
        <div className="mt-3 flex items-center justify-between rounded-sm border border-border bg-card px-3 py-2.5">
          <div>
            <p className="font-mono text-[0.55rem] tracking-widest text-fixer-dim">PUBLIC GALLERY</p>
            <p className="mt-0.5 text-sm">
              <span className={publicIds.size >= PUBLIC_LIMIT_PER_GUEST ? "text-drifting" : ""}>
                {publicIds.size} / {PUBLIC_LIMIT_PER_GUEST}
              </span>{" "}
              of your shots picked
            </p>
          </div>
          <Link
            to="/public"
            className="rounded-sm border border-converged/50 bg-converged/10 px-3 py-2 font-mono text-[0.6rem] font-bold tracking-widest text-converged active:scale-95"
          >
            VIEW →
          </Link>
        </div>
        {limitHit && (
          <p className="mt-2 rounded-sm border border-drifting/40 bg-drifting/10 px-3 py-2 text-sm text-drifting">
            You've picked {PUBLIC_LIMIT_PER_GUEST} already — take one off the public gallery before
            adding another.
          </p>
        )}
        {deleteError && (
          <p className="mt-2 rounded-sm border border-safelight/40 bg-safelight/10 px-3 py-2 text-sm text-safelight">
            {deleteError}
          </p>
        )}
      </header>

      {roll.length === 0 ? (
        <section className="px-5 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing shot yet — the camera tab is one tap away.
          </p>
        </section>
      ) : (
        <>
          <div className="px-5 pt-5 pb-2">
            <Link
              to="/album"
              className="block rounded-sm border border-drifting/50 bg-drifting/10 px-4 py-3 text-center font-mono text-[0.7rem] font-bold tracking-widest text-drifting active:scale-[0.98]"
            >
              MAKE A PRINTABLE STRIP →
            </Link>
          </div>

          {/* Profile-grid arrangement, newest first (roll is already sorted
              that way) -- scroll down for earlier frames instead of the old
              horizontal swipe strip that only ever showed one row at a time.
              Two columns, not three: each tile keeps the full card (frame ID,
              time, zone, perf rail, status) the strip version always had --
              a bare thumbnail loses exactly the information that makes "on
              the roll" legible, so the grid had to earn its width back
              rather than trade detail for density. */}
          <section className="grid grid-cols-2 gap-3 px-4">
            {roll.map((p) => {
              const ackCount = p.synced && p.photo_id ? (acks[p.photo_id] ?? 0) : 0;
              const held = p.synced && ackCount === CLUSTER_SIZE;
              const url = rollImageUrl(p, node);
              return (
                <figure
                  key={p.local_id}
                  className={`rounded-sm border bg-card p-2 ${
                    held ? "border-converged/50" : "border-drifting/40"
                  }`}
                >
                  {url ? (
                    <img
                      src={url}
                      alt={prettyZone(p.zone)}
                      className={`aspect-[3/4] w-full rounded-[2px] object-cover ${held ? "" : "settling"}`}
                    />
                  ) : (
                    // Synced, so its bytes were released to the cluster, but
                    // no node is reachable to fetch them back right now. Say
                    // that plainly rather than rendering a broken image --
                    // the frame is safe, this device just can't see it.
                    <div className="flex aspect-[3/4] w-full items-center justify-center rounded-[2px] border border-border px-2 text-center">
                      <p className="font-mono text-[0.55rem] leading-relaxed tracking-widest text-stale">
                        SAFE IN THE ROOM
                        <br />
                        OFFLINE RIGHT NOW
                      </p>
                    </div>
                  )}
                  <figcaption className="mt-2">
                    <p className="truncate font-mono text-[0.58rem] tracking-widest text-fixer-dim">
                      {(p.photo_id ?? p.local_id.slice(0, 8)).toUpperCase()} ·{" "}
                      {new Date(p.created_at).toLocaleTimeString("en-GB", { hour12: false })}
                    </p>
                    <p className="mt-0.5 truncate text-[0.78rem] leading-tight font-semibold capitalize">
                      {prettyZone(p.zone)}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <PerfRail acks={p.synced ? Math.max(ackCount, 1) : 0} total={CLUSTER_SIZE} />
                      <span
                        className={`font-mono text-[0.52rem] tracking-widest ${
                          held ? "text-converged" : "text-drifting"
                        }`}
                      >
                        {!p.synced ? "ROLL" : held ? "ROOM" : "…"}
                      </span>
                    </div>
                    {p.error && (
                      <p className="mt-1 font-mono text-[0.5rem] tracking-widest text-safelight">
                        RETRY PENDING
                      </p>
                    )}
                    {/* Only a synced photo has a real photo_id to publish --
                        a still-queued shot has nothing on the cluster yet
                        for a public_mark event to point at. */}
                    {p.synced && p.photo_id && (
                      <button
                        onClick={() => togglePublic(p)}
                        disabled={publicBusyId === p.local_id}
                        aria-pressed={publicIds.has(p.photo_id)}
                        className={`mt-2 w-full rounded-sm border py-1.5 font-mono text-[0.52rem] font-bold tracking-widest disabled:opacity-50 ${
                          publicIds.has(p.photo_id)
                            ? "border-converged bg-converged/15 text-converged"
                            : "border-fixer/25 text-fixer-dim"
                        }`}
                      >
                        {publicBusyId === p.local_id
                          ? "…"
                          : publicIds.has(p.photo_id)
                            ? "★ PUBLIC"
                            : "MAKE PUBLIC"}
                      </button>
                    )}
                    {confirmDeleteId === p.local_id ? (
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          onClick={() => deleteRollPhoto(p)}
                          disabled={deletingId === p.local_id}
                          className="flex-1 rounded-sm border border-safelight bg-safelight/20 py-1.5 font-mono text-[0.48rem] font-bold tracking-widest text-safelight disabled:opacity-50"
                        >
                          {deletingId === p.local_id
                            ? "…"
                            : p.synced && p.photo_id && publicIds.has(p.photo_id)
                              ? "DELETE EVERYWHERE?"
                              : "CONFIRM DELETE"}
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-sm border border-fixer/25 px-2.5 py-1.5 font-mono text-[0.48rem] tracking-widest text-fixer-dim"
                        >
                          CANCEL
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(p.local_id)}
                        className="mt-1.5 w-full rounded-sm border border-safelight/25 py-1.5 font-mono text-[0.5rem] tracking-widest text-safelight/70"
                      >
                        DELETE
                      </button>
                    )}
                  </figcaption>
                </figure>
              );
            })}
          </section>
        </>
      )}

      <section className="px-5 py-7">
        <h2 className="text-lg font-bold">What "on the roll" means</h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          A frame on the roll is safe — it's queued on your phone and isn't going anywhere. When
          your phone next reaches one of the three nodes, the frame joins the room's picture; the
          perf rail fills in as each node gossips it further. Nothing you shoot is ever dropped for
          being late.
        </p>
        <button
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            await syncOutbox();
            setSyncing(false);
          }}
          className="mt-4 rounded-sm border border-drifting/50 px-4 py-2 font-mono text-[0.6rem] tracking-widest text-drifting disabled:opacity-40"
        >
          {syncing ? "TRYING THE ROOM…" : "TRY THE ROOM NOW"}
        </button>
      </section>

      <GuestTabs active="mine" />
    </main>
  );
}

function rollImageUrl(p: OutboxPhoto, node: string | null): string | null {
  // Before it syncs, this device holds the only copy, so decode straight
  // from the outbox row. After it syncs the bytes are released (see
  // outbox.ts's syncOne) and the cluster is the copy that matters --
  // same fallback shape as event.$slug.tsx's local-then-remote resolve.
  if (p.image_base64) return `data:image/jpeg;base64,${p.image_base64}`;
  if (p.photo_id && node) return photoImageUrl(node, p.photo_id);
  return null;
}
