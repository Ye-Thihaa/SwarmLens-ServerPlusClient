import { useEffect, useRef, useState } from "react";
import { CLUSTER, URL_TO_ID, type NodeHealth } from "@/lib/api";

/** A live node graph for the operator console: three nodes, edges between
 * every pair, and a pulse animation fired for each REAL event this
 * console can observe -- not a scripted animation loop.
 *
 * Two kinds of pulse, each backed by an actual field in GET /health:
 *
 * - Gossip pulse (green, `--converged`): fires when a peer's
 *   `gossip.peers[url].last_ok` timestamp advances between polls. That
 *   timestamp is only ever updated by gossip.py's `_mark_ok`, right after
 *   a real POST /gossip/sync + (maybe) POST /gossip/push round actually
 *   succeeded against that specific peer -- so a pulse here means a
 *   round-trip really happened, not that 1s of wall-clock time passed.
 * - Heartbeat pulse (amber, `--drifting`): fires once per poll, from
 *   whichever node currently reports `raft.role === "leader"`, toward
 *   the other two. Raft's real heartbeat is every 50ms -- far faster
 *   than this console's 1s poll can resolve -- so this is deliberately
 *   NOT "one dot per heartbeat". It's "this node is actively heartbeating
 *   right now", sampled once per poll; the label says so rather than
 *   implying a precision this can't back up.
 *
 * Both are found by diffing the CURRENT health snapshot against the
 * PREVIOUS one, so this component needs no polling of its own -- it
 * reads whatever the console's existing 1s health loop already fetched.
 *
 * Rendering is capped at MAX_WIDTH_PX rather than stretched to fill its
 * container (h-full/w-full made 3 sparse nodes look like an empty,
 * oversized diagram in a wide console column -- measured live, it made
 * the graph feel broken rather than minimal). A pulse is drawn as a
 * moving dot PLUS a "comet" beam -- a copy of the edge whose
 * stroke-dashoffset animates in lockstep with the dot's motion, so the
 * beam visibly grows from source to destination instead of the dot just
 * blinking in and out. */

type Pulse = {
  id: string;
  fromId: string;
  toId: string;
  color: string;
  kind: "gossip" | "heartbeat";
  startedAt: number;
};

const PULSE_MS = 1100;
const PRUNE_INTERVAL_MS = 120;
const MAX_WIDTH_PX = 300;

// Fixed triangular layout, viewBox-relative -- three nodes never need a
// force layout, and a static one means the graph doesn't jitter every
// render the way a live physics sim would. Tighter than the first pass
// (was 400x260) to match the denser, smaller feel this was asked for.
const LAYOUT: Record<string, { x: number; y: number }> = {
  node1: { x: 150, y: 30 },
  node2: { x: 30, y: 165 },
  node3: { x: 270, y: 165 },
};
const VB_W = 300, VB_H = 200;

function edgeKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Resolves a peer URL (as reported by that node's own GET /health) back
 * to a CLUSTER id. URL_TO_ID alone isn't enough: it's built from
 * CLUSTER's configured URLs (127.0.0.1:800x locally, or whatever
 * VITE_CLUSTER_URLS names), but a node's PEERS env var can use a
 * completely different shape for the exact same cluster -- confirmed
 * live against docker-compose.yml, whose nodes address each other as
 * http://node2:8000 (Docker service hostnames), which never appears in
 * URL_TO_ID at all. Under that shape every gossip pulse was silently
 * dropped -- heartbeat pulses (which never look up a peer URL) kept
 * firing normally, which is what made this look like "gossip just isn't
 * happening" rather than a lookup bug when it was first measured live.
 * Falling back to "does this cluster's own id appear in the URL" handles
 * both shapes without hardcoding either one. */
function resolvePeerId(url: string): string | undefined {
  return URL_TO_ID[url] ?? CLUSTER.find((n) => url.includes(n.id))?.id;
}

export function NetworkGraph({ health }: { health: Record<string, NodeHealth | null> }) {
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const prevRef = useRef<Record<string, NodeHealth | null>>({});
  const seq = useRef(0);

  // Detect real events by diffing this poll's health against last poll's.
  useEffect(() => {
    const prev = prevRef.current;
    const fresh: Pulse[] = [];

    for (const n of CLUSTER) {
      const h = health[n.id];
      const p = prev[n.id];
      if (!h) continue;

      if (p) {
        for (const [peerUrl, cur] of Object.entries(h.gossip.peers)) {
          const before = p.gossip.peers[peerUrl];
          if (cur.last_ok != null && cur.last_ok !== before?.last_ok) {
            const peerId = resolvePeerId(peerUrl);
            if (peerId && LAYOUT[peerId]) {
              seq.current += 1;
              fresh.push({
                id: `p${seq.current}`,
                fromId: n.id,
                toId: peerId,
                color: "var(--converged)",
                kind: "gossip",
                startedAt: Date.now(),
              });
            }
          }
        }
      }

      if (h.raft.role === "leader") {
        for (const other of CLUSTER) {
          if (other.id === n.id) continue;
          seq.current += 1;
          fresh.push({
            id: `p${seq.current}`,
            fromId: n.id,
            toId: other.id,
            color: "var(--drifting)",
            kind: "heartbeat",
            startedAt: Date.now(),
          });
        }
      }
    }

    if (fresh.length) setPulses((old) => [...old, ...fresh]);
    prevRef.current = health;
  }, [health]);

  // One prune tick instead of a setTimeout per pulse -- animateMotion
  // handles the actual movement natively; this just clears finished ones
  // out of React state so the SVG doesn't accumulate dead elements.
  useEffect(() => {
    const id = setInterval(() => {
      setPulses((old) => old.filter((p) => Date.now() - p.startedAt < PULSE_MS));
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const nodeOf = (id: string) => health[id] ?? null;
  const roleOf = (id: string): "leader" | "candidate" | "follower" | "dead" => {
    const h = nodeOf(id);
    if (!h) return "dead";
    return h.raft.role;
  };

  // De-duplicate the 3 possible pairs so each edge (line) is drawn once,
  // regardless of which direction gossip most recently ran.
  const pairs: [string, string][] = [];
  for (let i = 0; i < CLUSTER.length; i++) {
    for (let j = i + 1; j < CLUSTER.length; j++) {
      pairs.push([CLUSTER[i]!.id, CLUSTER[j]!.id]);
    }
  }
  const recentGossipEdges = new Set(
    pulses.filter((p) => p.kind === "gossip").map((p) => edgeKey(p.fromId, p.toId)),
  );

  return (
    <div style={{ maxWidth: MAX_WIDTH_PX, margin: "0 auto" }}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-auto w-full">
        <defs>
          <filter id="ng-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="ng-bg" cx="50%" cy="30%" r="75%">
            <stop offset="0%" stopColor="var(--card)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--card)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* soft depth wash, purely decorative -- makes the dark panel
            feel like a canvas rather than a flat rectangle */}
        <rect x={0} y={0} width={VB_W} height={VB_H} fill="url(#ng-bg)" />

        {/* base edges -- one gray line per pair, brightened while a
            gossip round is actively pulsing across it */}
        {pairs.map(([a, b]) => {
          const pa = LAYOUT[a]!, pb = LAYOUT[b]!;
          const hot = recentGossipEdges.has(edgeKey(a, b));
          return (
            <line
              key={`${a}-${b}`}
              x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
              stroke={hot ? "var(--converged)" : "var(--border)"}
              strokeWidth={hot ? 1.4 : 0.75}
              strokeOpacity={hot ? 0.6 : 0.55}
            />
          );
        })}

        {/* pulses: a comet beam (edge segment revealing itself via
            stroke-dashoffset) plus a bright dot riding its leading edge --
            native SVG animation, no per-frame React re-render */}
        {pulses.map((p) => {
          const from = LAYOUT[p.fromId], to = LAYOUT[p.toId];
          if (!from || !to) return null;
          const len = dist(from, to);
          return (
            <g key={p.id}>
              <line
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={p.color}
                strokeWidth={p.kind === "gossip" ? 2.2 : 1.6}
                strokeLinecap="round"
                strokeDasharray={len}
                strokeDashoffset={len}
                opacity={0.85}
              >
                <animate
                  attributeName="stroke-dashoffset"
                  from={len} to={0}
                  dur={`${PULSE_MS}ms`}
                  fill="freeze"
                  calcMode="spline"
                  keySplines="0.3 0 0.7 1"
                />
                <animate
                  attributeName="opacity"
                  values="0.85;0.85;0" keyTimes="0;0.7;1"
                  dur={`${PULSE_MS}ms`} fill="freeze"
                />
              </line>
              <circle r={p.kind === "gossip" ? 4.5 : 3.5} fill={p.color} filter="url(#ng-glow)">
                <animateMotion
                  dur={`${PULSE_MS}ms`}
                  repeatCount="1"
                  fill="freeze"
                  calcMode="spline"
                  keySplines="0.3 0 0.7 1"
                  keyPoints="0;1"
                  keyTimes="0;1"
                  path={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
                />
                <animate
                  attributeName="opacity"
                  values="1;1;0" keyTimes="0;0.85;1"
                  dur={`${PULSE_MS}ms`} fill="freeze"
                />
              </circle>
            </g>
          );
        })}

        {/* nodes drawn last, on top of every line/pulse */}
        {CLUSTER.map((n) => {
          const pos = LAYOUT[n.id]!;
          const role = roleOf(n.id);
          const color =
            role === "leader" ? "var(--converged)" :
            role === "dead" ? "var(--safelight)" :
            role === "candidate" ? "var(--drifting)" :
            "var(--fixer-dim)";
          return (
            <g key={n.id}>
              <circle
                cx={pos.x} cy={pos.y} r={role === "leader" ? 11 : 8.5}
                fill="var(--card)" stroke={color} strokeWidth={role === "leader" ? 2.2 : 1.3}
                filter={role === "leader" ? "url(#ng-glow)" : undefined}
              />
              <text
                x={pos.x} y={pos.y + (role === "leader" ? 22 : 19)}
                textAnchor="middle" fontSize="8.5" fontFamily="ui-monospace, monospace"
                fill={color}
                style={{ letterSpacing: "0.05em" }}
              >
                {n.id.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
