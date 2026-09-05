/**
 * APP B — the split-brain panel: two nodes' answers to the same question,
 * side by side.
 *
 * Every other panel in this console shows a merged or single-node view,
 * which quietly implies the cluster has one answer. It doesn't. Each node
 * derives its own state by replaying whatever events have reached it, so
 * during a partition two replicas genuinely disagree about what happened
 * in the room -- and that disagreement is the thing this project is about,
 * not a bug to hide behind a spinner.
 *
 * Deliberately adds no mechanism (see ROADMAP's "What NOT to add"): it
 * asks two nodes the ordinary GET /photos each already serves and diffs
 * the answers here. Nothing new is replicated, elected or stored.
 *
 * Two kinds of disagreement, and they resolve differently:
 *   - a photo one replica has and the other doesn't -- gossip closes this
 *     by handing over the missing events;
 *   - a like count that differs -- likes are a set union, so healing
 *     converges *upward* to the union rather than one side winning. A
 *     like cast during a partition is never lost, which is the whole
 *     argument for a CRDT over a counter column.
 */
import { useEffect, useState } from "react";
import { CLUSTER, getPhotos, prettyZone, type RemotePhoto } from "@/lib/api";

type Side = { photos: RemotePhoto[] | null; reachable: boolean };
const EMPTY: Side = { photos: null, reachable: false };

type Disagreement =
  | { kind: "only"; photo: RemotePhoto; side: "a" | "b" }
  | { kind: "likes"; photo: RemotePhoto; a: number; b: number };

function diff(a: RemotePhoto[], b: RemotePhoto[]): Disagreement[] {
  const byId = (ps: RemotePhoto[]) => new Map(ps.map((p) => [p.photo_id, p]));
  const A = byId(a);
  const B = byId(b);
  const out: Disagreement[] = [];

  for (const [id, photo] of A) {
    const other = B.get(id);
    if (!other) out.push({ kind: "only", photo, side: "a" });
    else if (other.likes !== photo.likes)
      out.push({ kind: "likes", photo, a: photo.likes, b: other.likes });
  }
  for (const [id, photo] of B) if (!A.has(id)) out.push({ kind: "only", photo, side: "b" });

  // Newest first: during a live partition the interesting divergence is
  // whatever just happened, not the backlog that already converged.
  return out.sort((x, y) => y.photo.taken_at - x.photo.taken_at);
}

export function SplitBrain({ eventId }: { eventId: string | undefined }) {
  const [aId, setAId] = useState(CLUSTER[0]?.id ?? "");
  const [bId, setBId] = useState(CLUSTER[CLUSTER.length - 1]?.id ?? "");
  const [a, setA] = useState<Side>(EMPTY);
  const [b, setB] = useState<Side>(EMPTY);

  useEffect(() => {
    let live = true;
    async function readOne(id: string): Promise<Side> {
      const node = CLUSTER.find((n) => n.id === id);
      if (!node) return EMPTY;
      try {
        return { photos: await getPhotos(node.url, eventId), reachable: true };
      } catch {
        return EMPTY;
      }
    }
    async function poll() {
      // Both reads fire together: staggering them would show a difference
      // that is really just the gap between two requests, which is exactly
      // the false positive this panel must never produce.
      const [sa, sb] = await Promise.all([readOne(aId), readOne(bId)]);
      if (!live) return;
      setA(sa);
      setB(sb);
    }
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [aId, bId, eventId]);

  const comparable = a.photos !== null && b.photos !== null;
  const rows = comparable ? diff(a.photos!, b.photos!) : [];
  const agreed = comparable && rows.length === 0;

  return (
    <section className="border-b border-border py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="label-mono">Split brain · two replicas, one question</p>
        <p className="font-mono text-[0.6rem] tracking-widest text-stale">
          GET /photos ON EACH NODE · EVERY 2s
        </p>
      </div>

      <p
        className={`mt-4 font-display text-3xl leading-tight font-extrabold xl:text-4xl ${
          !comparable ? "text-stale" : agreed ? "text-converged" : "text-safelight"
        }`}
      >
        {!comparable
          ? "CAN'T COMPARE"
          : agreed
            ? "SAME PICTURE"
            : `${rows.length} DISAGREEMENT${rows.length === 1 ? "" : "S"}`}
      </p>
      <p className="mt-2 max-w-2xl font-mono text-[0.65rem] tracking-widest text-fixer-dim">
        {!comparable
          ? "A NODE ISN'T ANSWERING · NOTHING TO DIFF UNTIL IT DOES"
          : agreed
            ? "BOTH REPLICAS DERIVED AN IDENTICAL ROOM FROM THEIR OWN LOG"
            : "THESE TWO REPLICAS DISAGREE ABOUT WHAT HAPPENED IN THE ROOM"}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-px border-y border-border bg-border">
        {(
          [
            [aId, setAId, a, "A"],
            [bId, setBId, b, "B"],
          ] as const
        ).map(([id, setId, side, label]) => (
          <div key={label} className="bg-emulsion px-4 py-4">
            <div className="flex items-baseline justify-between gap-2">
              <select
                value={id}
                onChange={(e) => setId(e.target.value)}
                className="border border-input bg-emulsion px-2 py-1 font-mono text-xs"
              >
                {CLUSTER.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                  </option>
                ))}
              </select>
              <span
                className={`font-mono text-[0.6rem] tracking-widest ${
                  side.reachable ? "text-stale" : "text-safelight"
                }`}
              >
                {side.reachable ? "ANSWERING" : "NO CONTACT"}
              </span>
            </div>
            <p className="mt-3 font-display text-2xl font-extrabold tabular-nums">
              {side.photos ? side.photos.length : "—"}
            </p>
            <p className="label-mono mt-1">frames this replica can see</p>
          </div>
        ))}
      </div>

      {comparable && rows.length > 0 && (
        <ul className="mt-5 divide-y divide-border border-t border-border">
          {rows.slice(0, 8).map((d) => (
            <li
              key={`${d.kind}-${d.photo.photo_id}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-[0.68rem] tracking-widest text-fixer">
                  {d.photo.photo_id.toUpperCase()}
                </p>
                <p className="truncate font-mono text-[0.58rem] tracking-widest text-stale">
                  {prettyZone(d.photo.zone)} · {d.photo.guest_id}
                </p>
              </div>
              {d.kind === "only" ? (
                <p className="shrink-0 text-right font-mono text-[0.62rem] tracking-widest text-safelight">
                  ONLY ON {(d.side === "a" ? aId : bId).toUpperCase()}
                  <span className="block text-stale">
                    {(d.side === "a" ? bId : aId).toUpperCase()} HASN'T GOSSIPED IT IN
                  </span>
                </p>
              ) : (
                <p className="shrink-0 text-right font-mono text-[0.62rem] tracking-widest text-drifting">
                  {d.a} vs {d.b} LIKES
                  <span className="block text-stale">SET UNION · HEALS UPWARD, NONE LOST</span>
                </p>
              )}
            </li>
          ))}
          {rows.length > 8 && (
            <li className="py-2.5 font-mono text-[0.6rem] tracking-widest text-stale">
              +{rows.length - 8} MORE
            </li>
          )}
        </ul>
      )}

      {agreed && (
        <p className="mt-5 max-w-2xl text-sm text-fixer-dim">
          Cut one of these two below, then shoot or like from a phone — the frame reaches whichever
          node the phone can still talk to, and this panel shows the other one missing it until you
          heal.
        </p>
      )}
    </section>
  );
}
