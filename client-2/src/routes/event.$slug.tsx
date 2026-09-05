import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { GuestTabs, PerfRail } from "@/guest/ui";
import {
  BOOTH_ZONE,
  CLUSTER_SIZE,
  getPhotos,
  getZones,
  photoImageUrl,
  pickNode,
  prettyZone,
  type RemotePhoto,
  type ZoneScore,
} from "@/lib/api";
import { useCurrentEvent } from "@/lib/event";
import { currentGuestId, tick } from "@/lib/guest";
import { addLike, hasLiked, syncOutbox, useOutbox } from "@/lib/outbox";

export const Route = createFileRoute("/event/$slug")({
  // No loader lookup any more: the room a guest is in comes from the event
  // they joined by scanning a QR (lib/event.ts), not from a bundled
  // directory of rooms this app ships with. The slug in the URL is a
  // human-readable label for the same thing -- throwing notFound() for an
  // unrecognised one would 404 every real hosted event, since the client
  // has no list of them and, by design, isn't allowed one (see main.py's
  // gated GET /events).
  head: () => ({
    meta: [
      { title: "The room — SwarmLens" },
      {
        name: "description",
        content:
          "Everyone's frames from this room: each guest's own small gallery, the crowd's favourites, and which corners the room has decided are beautiful.",
      },
      { property: "og:title", content: "The room — SwarmLens" },
      {
        property: "og:description",
        content: "One picture of the night, assembled from every phone in the room.",
      },
    ],
  }),
  component: EventGallery,
});

type Tab = "people" | "sheet" | "popular" | "map" | "booth";

/** Photobooth strip trims — each guest's roll gets its own printed strip. */
const trims = [
  { edge: "border-drifting/70", ink: "text-drifting", plate: "bg-emulsion" },
  { edge: "border-fixer/40", ink: "text-fixer", plate: "bg-emulsion-lift" },
  { edge: "border-converged/60", ink: "text-converged", plate: "bg-emulsion" },
  { edge: "border-safelight/60", ink: "text-safelight", plate: "bg-emulsion-lift" },
] as const;

/** Scrapbook template: 12-col mosaic, deliberately uneven like a pasted page. */
const mosaic = [
  "col-span-7 row-span-2 aspect-[4/5]",
  "col-span-5 aspect-square",
  "col-span-5 aspect-square",
  "col-span-4 aspect-[3/4]",
  "col-span-8 aspect-[16/10]",
  "col-span-12 aspect-[16/7]",
];

function timeOf(p: RemotePhoto): string {
  return new Date(p.taken_at * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

/** This device's own outbox blob if it has one (its own capture),
 * otherwise a node-served URL -- see Photo.tsx's onError fallback. */
function PhotoImg({
  photo,
  node,
  localSrc,
  className,
}: {
  photo: RemotePhoto;
  node: string | null;
  localSrc: string | undefined;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = localSrc ?? (node && !failed ? photoImageUrl(node, photo.photo_id) : null);
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-emulsion-lift text-center ${className}`}>
        <span className="px-2 font-mono text-[0.55rem] tracking-widest text-stale">
          {prettyZone(photo.zone).toUpperCase()}
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${prettyZone(photo.zone)} by ${photo.guest_id}`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

function EventGallery() {
  const event = useCurrentEvent();
  const [tab, setTab] = useState<Tab>("people");
  const [open, setOpen] = useState<RemotePhoto | null>(null);
  const [node, setNode] = useState<string | null>(null);
  const [photos, setPhotos] = useState<RemotePhoto[]>([]);
  const [zones, setZones] = useState<ZoneScore[]>([]);
  const outbox = useOutbox();
  const [, forceLikeRerender] = useState(0);

  const localSrcByPhotoId = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of outbox) {
      // The empty check is load-bearing: a synced row has had its bytes
      // released (outbox.ts's syncOne), and "data:image/jpeg;base64," with
      // no payload is still a *truthy* string, so it would win the
      // `localSrc ?? remote` race in PhotoImg below and render as a broken
      // image -- with no way back, since onError only nulls the remote
      // branch. Skipping the entry lets the node-served URL take over.
      if (o.kind === "photo" && o.photo_id && o.image_base64)
        m.set(o.photo_id, `data:image/jpeg;base64,${o.image_base64}`);
    }
    return m;
  }, [outbox]);

  // Real photos + real zones, polled -- both change as gossip converges,
  // so a late frame or a shifting heatmap is a real, live event here,
  // never a scripted one.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const n = await pickNode();
      if (cancelled) return;
      setNode(n);
      if (!n) return;
      try {
        const [ps, zs] = await Promise.all([
          getPhotos(n, event.event_id),
          getZones(n, event.event_id),
        ]);
        if (!cancelled) {
          setPhotos(ps);
          setZones(zs);
        }
      } catch {
        // stay on the last known-good read -- a blip shouldn't blank the gallery
      }
    }
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [event.event_id]);

  const guestCount = useMemo(() => new Set(photos.map((p) => p.guest_id)).size, [photos]);

  const byPerson = useMemo(() => {
    const m = new Map<string, RemotePhoto[]>();
    for (const p of photos) m.set(p.guest_id, [...(m.get(p.guest_id) ?? []), p]);
    return [...m.entries()];
  }, [photos]);

  const ranked = useMemo(() => [...photos].sort((a, b) => b.likes - a.likes), [photos]);

  // Posted strips (routes/album.tsx's "POST TO PUBLIC ALBUM") are ordinary
  // photo events tagged zone "photo_booth" -- one of the five zones this
  // backend already knows about -- so no new endpoint or event kind exists
  // for them; this tab is just that zone filtered back out of the same
  // GET /photos every other tab already reads.
  const boothPhotos = useMemo(
    () => [...photos.filter((p) => p.zone === BOOTH_ZONE)].sort((a, b) => b.taken_at - a.taken_at),
    [photos],
  );

  const maxEngagement = Math.max(1, ...zones.map((z) => z.likes * 2 + z.photos));

  async function like(photoId: string) {
    addLike({
      local_id: crypto.randomUUID(),
      guest_id: currentGuestId(event.event_id),
      photo_id: photoId,
      vclock: tick(),
    });
    void syncOutbox();
    forceLikeRerender((n) => n + 1);
  }

  return (
    <main className="grain min-h-screen pb-24">
      <header className="border-b border-border px-5 pt-8 pb-5">
        <Link to="/" className="label-mono">
          ← all rooms
        </Link>
        <h1 className="mt-3 text-3xl leading-tight font-extrabold">{event.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {event.venue} · {guestCount} {guestCount === 1 ? "person" : "people"} shooting ·{" "}
          {node ? (
            <span className="text-converged">live</span>
          ) : (
            <span className="text-safelight">no node reachable</span>
          )}
        </p>
      </header>

      <div className="sticky top-0 z-30 flex border-b border-border bg-emulsion/95 backdrop-blur">
        {(
          [
            ["people", "Strips"],
            ["booth", "Photo booth"],
            ["sheet", "Contact sheet"],
            ["popular", "Most liked"],
            ["map", "The room"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 py-3 text-[0.78rem] font-semibold ${
              tab === k ? "text-fixer [box-shadow:inset_0_-2px_0_0_var(--drifting)]" : "text-stale"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {photos.length === 0 && (
        <section className="px-5 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {node
              ? "Nobody's shot a frame yet — this page fills in the moment they do."
              : "Waiting for a node to answer…"}
          </p>
        </section>
      )}

      {/* (a) STRIPS — each guest's roll printed as its own photobooth strip */}
      {tab === "people" && photos.length > 0 && (
        <section className="px-5 py-6">
          <p className="text-sm text-muted-foreground">
            One printed strip per phone. A strip is only ever as long as that phone has managed to
            hand around — a half-printed strip is still a real strip.
          </p>

          <div className="mt-6 flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none]">
            {byPerson.map(([guestId, ps], si) => {
              const trim = trims[si % trims.length]!;
              return (
                <article
                  key={guestId}
                  className={`w-[10.5rem] shrink-0 border-2 ${trim.edge} ${trim.plate} p-2 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.8)]`}
                >
                  <div className="space-y-1.5">
                    {ps.slice(0, 3).map((p) => (
                      <button
                        key={p.photo_id}
                        onClick={() => setOpen(p)}
                        className="block w-full border border-fixer/15"
                      >
                        <PhotoImg
                          photo={p}
                          node={node}
                          localSrc={localSrcByPhotoId.get(p.photo_id)}
                          className={`aspect-[4/3] w-full object-cover ${p.concurrent_with.length > 0 ? "settling" : ""}`}
                        />
                      </button>
                    ))}
                    {ps.length < 3 &&
                      Array.from({ length: 3 - ps.length }).map((_, i) => (
                        <div
                          key={i}
                          className="flex aspect-[4/3] w-full items-center justify-center border border-dashed border-fixer/20"
                        >
                          <span className="font-mono text-[0.5rem] tracking-[0.16em] text-stale">
                            NOT PRINTED YET
                          </span>
                        </div>
                      ))}
                  </div>

                  <footer className="mt-2.5 border-t border-fixer/15 pt-2 text-center">
                    <p
                      className={`font-display text-[0.95rem] leading-tight font-bold ${trim.ink}`}
                    >
                      {guestId}
                    </p>
                    <p className="mt-0.5 font-mono text-[0.5rem] tracking-[0.16em] text-fixer-dim">
                      {ps.length} frame{ps.length === 1 ? "" : "s"} · {ps[0]!.stored_on}
                    </p>
                    <p className="mt-1 font-mono text-[0.48rem] tracking-[0.16em] text-stale">
                      {event.name.toUpperCase()}
                    </p>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* (a2) PHOTO BOOTH — strips guests composited in Make a Strip and
          chose to post, not the raw contact-sheet feed. Rendered at each
          strip's own aspect via object-contain, never cropped to the fixed
          4:3 the other tabs assume -- a strip's proportions are part of
          what its creator actually designed. */}
      {tab === "booth" && (
        <section className="px-5 py-6">
          <h2 className="text-lg font-bold">The public album</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Strips guests composed themselves — a layout, a frame, a filter, their own words — and
            chose to post here for the whole room to see.
          </p>

          {boothPhotos.length === 0 ? (
            <p className="mt-5 font-mono text-[0.62rem] tracking-widest text-stale">
              NOBODY HAS POSTED A STRIP YET. MAKE ONE FROM YOUR ROLL.
            </p>
          ) : (
            <div className="mt-5 grid grid-cols-2 gap-3">
              {boothPhotos.map((p) => (
                <button
                  key={p.photo_id}
                  onClick={() => setOpen(p)}
                  className="overflow-hidden rounded-sm border border-border bg-card p-1.5 text-left"
                >
                  <PhotoImg
                    photo={p}
                    node={node}
                    localSrc={localSrcByPhotoId.get(p.photo_id)}
                    className={`w-full object-contain ${p.concurrent_with.length > 0 ? "settling" : ""}`}
                  />
                  <p className="mt-1.5 truncate font-mono text-[0.55rem] tracking-widest text-fixer-dim">
                    {p.guest_id} · {timeOf(p)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* (b) CONTACT SHEET — a pasted scrapbook page, deliberately uneven */}
      {tab === "sheet" && photos.length > 0 && (
        <section className="px-5 py-6">
          <h2 className="text-lg font-bold">Tonight, pasted down</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every phone's frames laid onto one page. Frames still spreading through the mesh pulse
            gently until every node agrees they're here to stay.
          </p>

          <div className="mt-5 grid grid-cols-12 gap-2 border border-border bg-card p-2">
            {photos.map((p, i) => (
              <button
                key={p.photo_id}
                onClick={() => setOpen(p)}
                className={`relative overflow-hidden border border-fixer/15 ${
                  mosaic[i % mosaic.length]
                }`}
              >
                <PhotoImg
                  photo={p}
                  node={node}
                  localSrc={localSrcByPhotoId.get(p.photo_id)}
                  className={`h-full w-full object-cover ${p.concurrent_with.length > 0 ? "settling" : ""}`}
                />
                <span className="absolute inset-x-0 bottom-0 bg-emulsion/75 px-1.5 py-1 text-left font-mono text-[0.5rem] tracking-[0.14em] text-fixer-dim">
                  {p.guest_id} · {timeOf(p)}
                </span>
              </button>
            ))}
          </div>

          <p className="mt-3 font-mono text-[0.58rem] tracking-widest text-stale">
            THE PAGE RE-PASTES ITSELF AS LATE FRAMES ARRIVE. NOTHING IS EVER PUSHED OFF IT.
          </p>
        </section>
      )}

      {/* (c) MOST LIKED — a ranked strip whose order can visibly change */}
      {tab === "popular" && photos.length > 0 && (
        <section className="px-5 py-6">
          <p className="text-sm text-muted-foreground">
            Likes given with no signal still count once reconciled — a set-union CRDT, never lost,
            never double-counted. When they land, the order moves — you'll see it move.
          </p>
          <ol className="mt-5 space-y-3">
            {ranked.map((p, i) => (
              <li
                key={p.photo_id}
                className="flex items-center gap-3 rounded-sm border border-border bg-card p-2"
              >
                <span className="w-6 font-mono text-lg font-bold text-drifting">{i + 1}</span>
                <button onClick={() => setOpen(p)} className="shrink-0">
                  <PhotoImg
                    photo={p}
                    node={node}
                    localSrc={localSrcByPhotoId.get(p.photo_id)}
                    className="h-16 w-16 object-cover"
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold capitalize">{prettyZone(p.zone)}</p>
                  <p className="font-mono text-[0.62rem] tracking-widest text-fixer-dim">
                    {p.guest_id} · {timeOf(p)}
                  </p>
                  {p.concurrent_with.length > 0 && (
                    <p className="mt-0.5 font-mono text-[0.58rem] tracking-widest text-drifting">
                      SHOT AT THE SAME MOMENT AS {p.concurrent_with.length} OTHER
                      {p.concurrent_with.length === 1 ? "" : "S"} — NEITHER IS FIRST
                    </p>
                  )}
                </div>
                <button
                  onClick={() => like(p.photo_id)}
                  disabled={hasLiked(p.photo_id)}
                  className="rounded-sm border border-fixer/25 px-3 py-2 text-right disabled:opacity-50"
                >
                  <span className="block font-mono text-sm font-bold">{p.likes}</span>
                  <span className="block font-mono text-[0.55rem] tracking-widest text-fixer-dim">
                    {hasLiked(p.photo_id) ? "LIKED" : "LIKE"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* (d) THE ROOM — merged aesthetic scores + real crowd engagement, corner by corner */}
      {tab === "map" && (
        <section className="px-5 py-6">
          <h2 className="text-lg font-bold">Where the room is looking</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Built from what everyone has shot and liked. Corners with only a frame or two don't get
            an opinion yet — they say so.
          </p>

          {zones.length === 0 ? (
            <p className="mt-5 font-mono text-[0.62rem] tracking-widest text-stale">
              NO OPINION YET. NOBODY'S SHOT A FRAME.
            </p>
          ) : (
            <ul className="mt-5 space-y-2.5">
              {zones.map((z) => {
                const settling = z.photos <= 1;
                const engagement = z.likes * 2 + z.photos;
                return (
                  <li
                    key={z.zone}
                    className={`rounded-sm border border-border bg-card p-3 ${settling ? "settling" : ""} ${z.stale ? "border-safelight/50" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-sm font-semibold capitalize">
                        {prettyZone(z.zone)}
                      </p>
                      <PerfRail acks={z.photos > 6 ? 5 : z.photos > 2 ? 3 : 1} />
                    </div>
                    {z.photos === 0 ? (
                      <p className="mt-2 font-mono text-[0.62rem] tracking-widest text-stale">
                        NO FRAMES. NOT ENOUGH TO SAY ANYTHING YET.
                      </p>
                    ) : (
                      <div className="mt-2">
                        <div className="h-1.5 w-full bg-muted">
                          <div
                            className="h-full transition-[width] duration-700"
                            style={{
                              width: `${Math.round((engagement / maxEngagement) * 100)}%`,
                              background: z.stale ? "var(--safelight)" : "var(--converged)",
                            }}
                          />
                        </div>
                        <p className="mt-1.5 font-mono text-[0.6rem] tracking-widest text-fixer-dim">
                          {z.photos} FRAME{z.photos === 1 ? "" : "S"} · {z.likes} LIKE
                          {z.likes === 1 ? "" : "S"} ·{" "}
                          {z.avg_aesthetic != null
                            ? `AESTHETIC ${z.avg_aesthetic.toFixed(1)}`
                            : "NOT ANALYSED YET"}
                          {z.stale ? " · STALE READ" : ""}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-emulsion/95 backdrop-blur"
          onClick={() => setOpen(null)}
        >
          <div className="film-edge bg-card px-5 py-8" onClick={(e) => e.stopPropagation()}>
            <PhotoImg
              photo={open}
              node={node}
              localSrc={localSrcByPhotoId.get(open.photo_id)}
              className="mx-auto max-h-[52svh] w-auto object-contain"
            />
            <h2 className="mt-5 text-2xl font-bold capitalize">{prettyZone(open.zone)}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {open.guest_id} · stored on {open.stored_on}
            </p>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
              <p className="font-mono text-[0.65rem] tracking-widest text-fixer-dim">
                {open.photo_id.toUpperCase()} · {timeOf(open)}
              </p>
              <PerfRail acks={CLUSTER_SIZE} />
            </div>
            <button
              onClick={() => setOpen(null)}
              className="mt-6 w-full rounded-sm bg-fixer py-3 text-sm font-semibold text-emulsion"
            >
              Back to the room
            </button>
          </div>
        </div>
      )}

      <GuestTabs active="room" />
    </main>
  );
}
