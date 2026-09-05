import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { NodeState } from "@/operator/cluster";
import { NetworkGraph } from "@/operator/NetworkGraph";
import { SplitBrain } from "@/operator/SplitBrain";
import {
  CLUSTER,
  URL_TO_ID,
  getHealth,
  getPhotos,
  getRecap,
  getZones,
  getZonesQuorum,
  prettyZone,
  RECAP_TOP_N,
  type HostedEventAdmin,
  type NodeHealth,
  type QuorumResult,
  type Recap,
  type ZoneScore,
} from "@/lib/api";
import { checkConsoleSession, loginToConsole, logoutOfConsole } from "@/lib/consoleAuth";
import {
  serverCreateEvent,
  serverHealAll,
  serverIsolateNode,
  serverEventToken,
  serverListEvents,
  serverTriggerRecap,
} from "@/lib/operatorGateway";
import { joinQrSvg, printJoinCard } from "@/lib/qr";

/** APP B — Operator Console. One operator, laptop → room display. No camera.
 * Real server-side gate (see lib/consoleAuth.ts): the loader checks the
 * session cookie on every request, including the first SSR render, so an
 * unauthenticated visitor never receives the console's data. */
export const Route = createFileRoute("/console")({
  head: () => ({
    meta: [
      { title: "SwarmLens Operator Console" },
      {
        name: "description",
        content:
          "Live cluster state behind SwarmLens: Raft leader and term, gossip convergence, W/R/N quorum, and a chaos panel for partitioning the mesh.",
      },
      { property: "og:title", content: "SwarmLens Operator Console" },
      {
        property: "og:description",
        content: "Raft term, gossip convergence and quorum state for the room, on one screen.",
      },
    ],
  }),
  loader: async () => {
    const { authorized } = await checkConsoleSession();
    return { authorized };
  },
  component: Console,
});

type Log = { t: string; text: string; kind: "ok" | "warn" | "bad" };
type HealthMap = Record<string, NodeHealth | null>;

function nodeState(h: NodeHealth | null): NodeState {
  if (!h) return "dead";
  if (h.raft.role === "leader") return "leader";
  if (h.raft.role === "candidate") return "candidate";
  if (h.gossip.partitioned.length > 0) return "partitioned";
  return "follower";
}

function secondsSinceLastSync(h: NodeHealth): number | null {
  const times = Object.values(h.gossip.peers)
    .map((p) => p.last_ok)
    .filter((t): t is number => t != null);
  if (times.length === 0) return null;
  return Math.max(0, Date.now() / 1000 - Math.max(...times));
}

function Console() {
  const { authorized } = Route.useLoaderData();
  const [unlocked, setUnlocked] = useState(authorized);
  const [key, setKey] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [health, setHealth] = useState<HealthMap>({});
  const [zones, setZones] = useState<ZoneScore[]>([]);
  const [frames, setFrames] = useState(0);
  const [guests, setGuests] = useState(0);

  const [w, setW] = useState(3);
  const [r, setR] = useState(3);
  const [quorum, setQuorum] = useState<QuorumResult | null>(null);
  const [quorumRunning, setQuorumRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [log, setLog] = useState<Log[]>([]);
  const [latched, setLatched] = useState(false);
  const prevRef = useRef<
    Record<string, { term: number; leader: string | null; partitioned: string[] }>
  >({});

  // ---- hosted events: the multi-tenant directory this console alone can see ----
  const [events, setEvents] = useState<HostedEventAdmin[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [tokenBySlug, setTokenBySlug] = useState<Record<string, string>>({});
  // undefined = every event merged -- the same cluster-wide view this
  // console always showed before multi-event hosting existed. Selecting a
  // real event scopes the room stats, the aesthetic map and the quorum
  // panel below to that one event, so "which room is this reading?" is
  // never ambiguous once more than one exists.
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(undefined);

  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newVenue, setNewVenue] = useState("");
  const [newZones, setNewZones] = useState("");
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [createEventError, setCreateEventError] = useState<string | null>(null);

  // Where a printed QR should actually point. Defaults to this page's own
  // origin, which is exactly wrong for a guest's phone whenever the
  // console itself was opened at localhost/127.0.0.1 -- see the warning
  // rendered below. Persisted so an operator only has to correct it once
  // per venue, not once per event card.
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  useEffect(() => {
    const saved = localStorage.getItem("swarmlens_public_base_url");
    setPublicBaseUrl(saved || window.location.origin);
  }, []);
  useEffect(() => {
    if (publicBaseUrl) localStorage.setItem("swarmlens_public_base_url", publicBaseUrl);
  }, [publicBaseUrl]);
  const baseUrlIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(publicBaseUrl);

  const [qrOpenId, setQrOpenId] = useState<string | null>(null);
  const [qrSvgById, setQrSvgById] = useState<Record<string, string>>({});

  // Two views, not one scroll. During a demo this screen is read from
  // across a room, and event administration -- a create form, a URL
  // field, a list of every event ever hosted -- is desk work that was
  // sitting above the live cluster state and pushing it off the
  // projector. Polling underneath is unaffected by which view is showing.
  const [view, setView] = useState<"live" | "events">("live");

  // Recap: an operator's "end this event" action, freezing the top-liked
  // slideshow guests see afterward on /recap. Fetched lazily per event
  // (a button, not a poll) -- there's no cluster-wide urgency to knowing
  // this the moment it changes, unlike the health/zone panels below.
  const [recapByEvent, setRecapByEvent] = useState<Record<string, Recap>>({});
  const [recapBusyId, setRecapBusyId] = useState<string | null>(null);

  async function loadEvents() {
    const page = await serverListEvents();
    setEvents(page.events);
    setEventsTotal(page.total);
    setEventsLoaded(true);
  }

  // Join tokens are no longer in the directory response (see api.ts's
  // HostedEventAdmin) -- fetched per event, only when an operator actually
  // reaches for that event's link or QR, and cached for the session.
  async function tokenFor(ev: HostedEventAdmin): Promise<string> {
    const cached = tokenBySlug[ev.slug];
    if (cached) return cached;
    const { join_token } = await serverEventToken({ data: { slug: ev.slug } });
    setTokenBySlug((m) => ({ ...m, [ev.slug]: join_token }));
    return join_token;
  }

  async function checkRecap(ev: HostedEventAdmin) {
    const n = CLUSTER.find((c) => health[c.id])?.url ?? CLUSTER[0]!.url;
    try {
      const r = await getRecap(n, ev.event_id);
      setRecapByEvent((m) => ({ ...m, [ev.event_id]: r }));
    } catch {
      // stay on the last known-good read
    }
  }

  async function freezeRecap(ev: HostedEventAdmin) {
    setRecapBusyId(ev.event_id);
    try {
      const res = await serverTriggerRecap({ data: { eventId: ev.event_id } });
      if (!res.ok) {
        push(`couldn't reach any node to freeze ${ev.name}'s recap`, "bad");
        return;
      }
      await checkRecap(ev);
      push(`recap frozen for ${ev.name} · top ${RECAP_TOP_N} most-liked`, "ok");
    } finally {
      setRecapBusyId(null);
    }
  }

  useEffect(() => {
    if (!unlocked) return;
    void loadEvents();
    const id = setInterval(() => void loadEvents(), 5000);
    return () => clearInterval(id);
  }, [unlocked]);

  async function createEvent(e: FormEvent) {
    e.preventDefault();
    setCreateEventError(null);
    setCreatingEvent(true);
    try {
      const zones = newZones
        .split(",")
        .map((z) => z.trim().toLowerCase().replace(/\s+/g, "_"))
        .filter(Boolean);
      const res = await serverCreateEvent({
        data: { slug: newSlug.trim().toLowerCase(), name: newName.trim(), venue: newVenue.trim(), when: "", zones },
      });
      if (!res.ok) {
        setCreateEventError(
          res.reason === "slug_taken"
            ? `The slug "${newSlug}" is already in use by another event.`
            : res.reason === "invalid"
              ? "Needs at least a slug (letters, digits, dashes) and a name."
              : "Couldn't reach the cluster to create the event.",
        );
        return;
      }
      setNewSlug("");
      setNewName("");
      setNewVenue("");
      setNewZones("");
      await loadEvents();
      setSelectedEventId(res.event.event_id);
      push(`event created: ${res.event.name} (${res.event.slug})`, "ok");
    } finally {
      setCreatingEvent(false);
    }
  }

  async function toggleQr(ev: HostedEventAdmin) {
    if (qrOpenId === ev.event_id) {
      setQrOpenId(null);
      return;
    }
    setQrOpenId(ev.event_id);
    if (!qrSvgById[ev.event_id]) {
      const url = await joinUrl(ev);
      const svg = await joinQrSvg(url);
      setQrSvgById((m) => ({ ...m, [ev.event_id]: svg }));
    }
  }

  async function joinUrl(ev: HostedEventAdmin): Promise<string> {
    const token = await tokenFor(ev);
    return `${publicBaseUrl || window.location.origin}/join/${ev.slug}?k=${token}`;
  }

  async function copyJoinUrl(ev: HostedEventAdmin) {
    await navigator.clipboard.writeText(await joinUrl(ev));
    push(`copied join link for ${ev.name}`, "ok");
  }

  const selectedEvent = useMemo(
    () => events.find((e) => e.event_id === selectedEventId),
    [events, selectedEventId],
  );

  function push(text: string, kind: Log["kind"]) {
    const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLog((l) => [{ t, text, kind }, ...l].slice(0, 8));
  }

  // Real state, polled at dashboard.html's cadence (1s). Diffs against
  // the previous snapshot to produce a real event tape -- term/leader
  // changes and partition set changes, not scripted lines.
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;

    async function poll() {
      const results = await Promise.all(
        CLUSTER.map(async (n) => {
          try {
            return [n.id, await getHealth(n.url)] as const;
          } catch {
            return [n.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: HealthMap = Object.fromEntries(results);
      diffAndLog(next);
      setHealth(next);

      const anyNode = CLUSTER.find((n) => next[n.id])?.url;
      if (anyNode) {
        try {
          const [ps, zs] = await Promise.all([
            getPhotos(anyNode, selectedEventId),
            getZones(anyNode, selectedEventId),
          ]);
          if (!cancelled) {
            setFrames(ps.length);
            setGuests(new Set(ps.map((p) => p.guest_id)).size);
            setZones(zs);
          }
        } catch {
          // stay on the last known-good snapshot
        }
      }
    }

    function diffAndLog(next: HealthMap) {
      const prev = prevRef.current;
      for (const n of CLUSTER) {
        const h = next[n.id];
        const p = prev[n.id];
        if (!h) {
          if (p) push(`${n.id} unreachable`, "bad");
          delete prev[n.id];
          continue;
        }
        if (
          p &&
          h.raft.role === "leader" &&
          (h.raft.term !== p.term || h.raft.leader_id !== p.leader)
        ) {
          push(`term ${h.raft.term} · ${n.id} elected leader`, "ok");
        }
        if (p) {
          for (const url of h.gossip.partitioned) {
            if (!p.partitioned.includes(url)) push(`${n.id} cut → ${URL_TO_ID[url] ?? url}`, "bad");
          }
          for (const url of p.partitioned) {
            if (!h.gossip.partitioned.includes(url))
              push(`${n.id} healed → ${URL_TO_ID[url] ?? url}`, "warn");
          }
        }
        prev[n.id] = {
          term: h.raft.term,
          leader: h.raft.leader_id,
          partitioned: h.gossip.partitioned,
        };
      }
    }

    void poll();
    const id = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [unlocked, selectedEventId]);

  const healthy = CLUSTER.map((n) => health[n.id]).filter((h): h is NodeHealth => !!h);
  const leaderIds = new Set(healthy.map((h) => h.raft.leader_id).filter((x): x is string => !!x));
  const anyPartitioned = healthy.some((h) => h.gossip.partitioned.length > 0);
  const anyCandidate = healthy.some((h) => h.raft.role === "candidate");
  const converged =
    healthy.length === CLUSTER.length && leaderIds.size === 1 && !anyPartitioned && !anyCandidate;
  const term = healthy.length > 0 ? Math.max(...healthy.map((h) => h.raft.term)) : 0;
  const leaderNode = CLUSTER.find((n) => health[n.id]?.raft.role === "leader");
  const topZone = zones[0];

  // agreement latch: re-arms whenever the cluster comes back into agreement
  useEffect(() => {
    if (converged) {
      setLatched(false);
      const id = setTimeout(() => setLatched(true), 40);
      return () => clearTimeout(id);
    }
    setLatched(false);
    return;
  }, [converged, term]);

  async function isolateLeader() {
    if (!leaderNode) return;
    setBusy("isolate-leader");
    push(`isolating ${leaderNode.id} from gossip…`, "warn");
    await serverIsolateNode({ data: { nodeId: leaderNode.id } });
    push(
      `${leaderNode.id} cut from every peer · raft heartbeats bypass this, no re-election`,
      "bad",
    );
    setBusy(null);
  }

  async function isolateOne(nodeId: string) {
    setBusy(`isolate-${nodeId}`);
    await serverIsolateNode({ data: { nodeId } });
    push(`${nodeId} cut from every peer`, "bad");
    setBusy(null);
  }

  async function healAll() {
    setBusy("heal");
    await serverHealAll();
    push("heal requested on every node · partitions clearing", "warn");
    setBusy(null);
  }

  async function runQuorumRead() {
    setQuorumRunning(true);
    try {
      const result = await getZonesQuorum(CLUSTER[0]!.url, r, w, selectedEventId);
      setQuorum(result);
      const unreachableNote =
        result.unreachable.length > 0
          ? ` · missed ${result.unreachable.map((u) => URL_TO_ID[u] ?? u).join(", ")}`
          : "";
      push(
        `quorum read R=${result.R} W=${result.W} · queried ${result.queried.length}/${result.N}${unreachableNote}`,
        result.strongly_consistent ? "ok" : "warn",
      );
    } catch (e) {
      push(`quorum read failed: ${String(e)}`, "bad");
    }
    setQuorumRunning(false);
  }

  async function reset() {
    setBusy("reset");
    await serverHealAll();
    setW(3);
    setR(3);
    setQuorum(null);
    push("cluster reset · every partition healed", "ok");
    setBusy(null);
  }

  if (!unlocked) {
    return (
      <main className="grain flex min-h-screen items-center justify-center px-6">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setAuthError(null);
            setChecking(true);
            try {
              await loginToConsole({ data: { password: key } });
              setUnlocked(true);
            } catch {
              setAuthError("Incorrect password.");
            }
            setChecking(false);
          }}
          className="w-full max-w-sm rounded-sm border border-border bg-card p-6"
        >
          <p className="label-mono">SwarmLens · operator</p>
          <h1 className="mt-2 text-2xl font-extrabold">Operator key</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This console is not the guest app. It can partition nodes from the cluster.
          </p>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            placeholder="operator key"
            autoFocus
            className="mt-5 w-full rounded-sm border border-input bg-emulsion px-3 py-2.5 font-mono text-sm"
          />
          {authError && <p className="mt-2 text-sm text-safelight">{authError}</p>}
          <button
            disabled={checking}
            className="mt-4 w-full rounded-sm bg-fixer py-2.5 text-sm font-semibold text-emulsion disabled:opacity-50"
          >
            {checking ? "Checking…" : "Open console"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="grain min-h-screen">
      {/* One hairline bar, no box: identity on the left, the three numbers
          that matter on the right, and the view switch between them. The
          old header carried the same data inside a bordered card competing
          with six more below it. */}
      <header className="sticky top-0 z-20 border-b border-border bg-emulsion/95 backdrop-blur">
        <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3 xl:px-10">
          <div className="mr-auto flex items-baseline gap-3">
            <span className="font-display text-base font-extrabold tracking-tight">SwarmLens</span>
            <span className="label-mono">operator</span>
          </div>

          <nav className="flex items-center gap-5">
            {(
              [
                ["live", "Live"],
                ["events", eventsTotal ? `Events · ${eventsTotal}` : "Events"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`-mb-3 border-b-2 pb-3 font-mono text-[0.65rem] tracking-widest uppercase transition-colors ${
                  view === v
                    ? "border-fixer text-fixer"
                    : "border-transparent text-stale hover:text-fixer-dim"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-6 font-mono text-[0.65rem] tracking-widest text-stale">
            <span>
              TERM <span className="text-fixer">{term}</span>
            </span>
            <span>
              N{CLUSTER.length} · R{r} · W{w}
            </span>
            <button
              onClick={async () => {
                await logoutOfConsole();
                setUnlocked(false);
                setKey("");
              }}
              className="text-stale uppercase hover:text-fixer"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      {view === "live" ? (
        <div className="mx-auto max-w-[110rem] px-6 pb-20 xl:px-10">
          {/* SIGNATURE: agreement stated as one word, set as large as the
              room needs. No border and no fill -- at this size the type is
              the indicator, and colour alone carries the state. */}
          <section className="py-10 xl:py-14">
            <p className="label-mono">
              {selectedEvent ? `Reading · ${selectedEvent.name}` : "Reading · every event, merged"}
            </p>
            <h1
              className={`mt-4 font-display text-5xl leading-[0.9] font-extrabold tracking-tight sm:text-7xl xl:text-8xl ${
                converged ? "text-converged" : "text-safelight"
              } ${converged && latched ? "latch" : ""}`}
            >
              {converged
                ? "AGREED"
                : anyPartitioned
                  ? "SPLIT"
                  : anyCandidate
                    ? "ELECTING"
                    : "DISAGREEING"}
            </h1>
            <p className="mt-4 max-w-2xl font-mono text-[0.7rem] tracking-widest text-fixer-dim">
              {converged
                ? `ALL THREE REPLICAS HOLD AN IDENTICAL LOG · TERM ${term}`
                : anyPartitioned
                  ? "GOSSIP IS CUT SOMEWHERE · REPLICAS ARE DRIFTING APART"
                  : anyCandidate
                    ? "NO LEADER RIGHT NOW · VOTES IN FLIGHT"
                    : "REPLICAS DISAGREE · WAITING ON THE NEXT GOSSIP ROUND"}
            </p>
          </section>

          {/* Three nodes, three columns, separated by hairlines rather than
              wrapped in three cards. gap-px over a border-coloured ground is
              what draws the rules. */}
          <section className="grid grid-cols-1 gap-px border-y border-border bg-border sm:grid-cols-3">
            {CLUSTER.map((n) => {
              const h = health[n.id] ?? null;
              const state = nodeState(h);
              const bad = state === "dead" || state === "partitioned";
              const sinceSync = h ? secondsSinceLastSync(h) : null;
              const tone =
                state === "leader"
                  ? "text-converged"
                  : bad
                    ? "text-safelight"
                    : state === "candidate"
                      ? "text-drifting"
                      : "text-fixer-dim";
              return (
                <div
                  key={n.id}
                  className={`bg-emulsion px-5 py-6 ${state === "candidate" ? "settling" : ""}`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-lg font-bold">{n.id}</span>
                    <span className={`font-mono text-[0.65rem] tracking-widest ${tone}`}>
                      {state.toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-4 font-display text-3xl font-extrabold tabular-nums xl:text-4xl">
                    {h ? h.events.toLocaleString() : "—"}
                  </p>
                  <p className="label-mono mt-1">events replicated</p>
                  <p className="mt-3 font-mono text-[0.6rem] tracking-widest text-stale">
                    {sinceSync != null ? `SYNCED ${sinceSync.toFixed(1)}S AGO` : "NO CONTACT"}
                  </p>
                </div>
              );
            })}
          </section>

          <SplitBrain eventId={selectedEventId} />

          <section className="grid gap-10 border-b border-border py-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:gap-16">
            <div className="min-w-0">
              <p className="label-mono">Mesh · one pulse per observed round-trip</p>
              <div className="mt-4">
                <NetworkGraph health={health} />
              </div>
              <p className="mt-2 font-mono text-[0.55rem] tracking-widest text-stale">
                <span className="text-converged">●</span> GOSSIP ROUND-TRIP&nbsp;&nbsp;
                <span className="text-drifting">●</span> LEADER HEARTBEAT
              </p>
            </div>

            {/* Four figures, hairline-ruled, no tiles. */}
            <dl className="grid grid-cols-2 gap-x-10 gap-y-7 self-start">
              {(
                [
                  ["Guests shooting", String(guests), "text-fixer"],
                  ["Frames landed", frames.toLocaleString(), "text-fixer"],
                  [
                    "Popular spot",
                    topZone
                      ? `${prettyZone(topZone.zone)} · ${topZone.guests} ${
                          topZone.guests === 1 ? "person" : "people"
                        }`
                      : "—",
                    "text-drifting",
                  ],
                  [
                    "Last quorum read",
                    quorum
                      ? quorum.strongly_consistent
                        ? "Consistent"
                        : "May be stale"
                      : "Not run yet",
                    quorum
                      ? quorum.strongly_consistent
                        ? "text-converged"
                        : "text-safelight"
                      : "text-stale",
                  ],
                ] as const
              ).map(([label, value, tone]) => (
                <div key={label} className="border-t border-border pt-3">
                  <dt className="label-mono">{label}</dt>
                  <dd
                    className={`mt-1.5 font-display text-2xl leading-tight font-bold xl:text-3xl ${tone}`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
              {quorum && (
                <div className="col-span-2 border-t border-border pt-3">
                  <dt className="label-mono">
                    N={quorum.N} R={quorum.R} W={quorum.W} ·{" "}
                    {quorum.strongly_consistent ? "R+W>N, always fresh" : "R+W≤N, can land stale"}
                  </dt>
                  <dd className="mt-1.5 font-mono text-[0.65rem] tracking-widest text-fixer-dim">
                    QUERIED {quorum.queried.map((u) => URL_TO_ID[u] ?? u).join(", ") || "—"}
                    {quorum.unreachable.length > 0 && (
                      <span className="text-safelight">
                        {" "}
                        · UNREACHABLE {quorum.unreachable.map((u) => URL_TO_ID[u] ?? u).join(", ")}
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section className="grid gap-10 border-b border-border py-8 lg:grid-cols-2 xl:gap-16">
            <div className="min-w-0">
              <p className="label-mono">Merged aesthetic scores</p>
              {zones.length === 0 ? (
                <p className="mt-4 font-mono text-[0.65rem] tracking-widest text-stale">
                  NO FRAMES YET
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {zones.map((z) => (
                    <li
                      key={z.zone}
                      className="grid grid-cols-[minmax(6rem,9rem)_1fr_3rem] items-center gap-4"
                    >
                      <span className="truncate text-sm capitalize">
                        {prettyZone(z.zone)}
                        <span className="ml-2 font-mono text-[0.6rem] tracking-widest text-stale">
                          {z.guests}P
                        </span>
                      </span>
                      <span className="h-px bg-border">
                        <span
                          className="block h-px"
                          style={{
                            // Scaled off popular_score, the same number the
                            // list is already sorted by -- a second formula
                            // here would eventually draw the bars in an order
                            // the rows contradict.
                            width: `${Math.min(100, z.popular_score * 6)}%`,
                            background: z.stale ? "var(--safelight)" : "var(--converged)",
                            boxShadow: "0 0 0 1px currentColor",
                          }}
                        />
                      </span>
                      <span className="text-right font-mono text-xs tabular-nums text-fixer-dim">
                        {z.avg_aesthetic != null ? z.avg_aesthetic.toFixed(2) : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="min-w-0">
              <p className="label-mono">Event tape · observed state changes</p>
              <ul className="mt-4 space-y-2">
                {log.length === 0 && (
                  <li className="font-mono text-[0.65rem] text-stale">watching the cluster…</li>
                )}
                {log.map((l, i) => (
                  <li key={`${l.t}-${i}`} className="font-mono text-[0.68rem] leading-relaxed">
                    <span className="text-stale">{l.t}</span>{" "}
                    <span
                      className={
                        l.kind === "ok"
                          ? "text-converged"
                          : l.kind === "warn"
                            ? "text-drifting"
                            : "text-safelight"
                      }
                    >
                      {l.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* Chaos: still one deliberate region, but a row of plain controls
              rather than a boxed sidebar. Destructive things stay safelight,
              recovery stays converged, tuning stays drifting. */}
          <section className="py-8">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="label-mono text-safelight">Break it on purpose</p>
              <p className="font-mono text-[0.6rem] tracking-widest text-stale">
                CUTS GOSSIP BOTH WAYS · RAFT HEARTBEATS UNAFFECTED, NO RE-ELECTION
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={isolateLeader}
                disabled={!leaderNode || busy === "isolate-leader"}
                className="border border-safelight px-4 py-2.5 font-mono text-[0.68rem] tracking-widest text-safelight transition-colors hover:bg-safelight/10 disabled:opacity-40"
              >
                ISOLATE THE LEADER
              </button>
              {CLUSTER.map((n) => (
                <button
                  key={n.id}
                  onClick={() => isolateOne(n.id)}
                  disabled={busy === `isolate-${n.id}`}
                  className="border border-border px-4 py-2.5 font-mono text-[0.68rem] tracking-widest text-drifting transition-colors hover:border-drifting disabled:opacity-40"
                >
                  CUT {n.id.toUpperCase()}
                </button>
              ))}
              <button
                onClick={healAll}
                disabled={busy === "heal"}
                className="border border-converged px-4 py-2.5 font-mono text-[0.68rem] tracking-widest text-converged transition-colors hover:bg-converged/10 disabled:opacity-40"
              >
                HEAL ALL
              </button>
              <button
                onClick={reset}
                disabled={busy === "reset"}
                className="border border-border px-4 py-2.5 font-mono text-[0.68rem] tracking-widest text-fixer-dim transition-colors hover:text-fixer disabled:opacity-40"
              >
                RESET CLUSTER
              </button>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="label-mono">W</span>
                {[1, 2, 3].map((v) => (
                  <button
                    key={v}
                    onClick={() => setW(v)}
                    className={`h-8 w-8 border font-mono text-xs tabular-nums ${
                      w === v ? "border-drifting text-drifting" : "border-border text-stale"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="label-mono">R</span>
                {[1, 2, 3].map((v) => (
                  <button
                    key={v}
                    onClick={() => setR(v)}
                    className={`h-8 w-8 border font-mono text-xs tabular-nums ${
                      r === v ? "border-drifting text-drifting" : "border-border text-stale"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <button
                onClick={runQuorumRead}
                disabled={quorumRunning}
                className="border-b border-fixer pb-0.5 font-mono text-[0.68rem] tracking-widest text-fixer disabled:opacity-40"
              >
                {quorumRunning ? "READING…" : `RUN A QUORUM READ · R=${r} W=${w}`}
              </button>
            </div>
          </section>
        </div>
      ) : (
        /* ---------------- events view: the desk work ---------------- */
        <div className="mx-auto max-w-[110rem] px-6 pb-20 xl:px-10">
          <section className="grid gap-10 border-b border-border py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] xl:gap-16">
            <div>
              <p className="label-mono">Scope every live panel</p>
              <select
                value={selectedEventId ?? ""}
                onChange={(e) => setSelectedEventId(e.target.value || undefined)}
                className="mt-3 w-full max-w-md border border-input bg-emulsion px-3 py-2 text-sm"
              >
                <option value="">All events (merged)</option>
                {events.map((ev) => (
                  <option key={ev.event_id} value={ev.event_id}>
                    {ev.name} ({ev.slug})
                  </option>
                ))}
              </select>

              <p className="label-mono mt-8">Public URL for printed QR codes</p>
              <input
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
                placeholder="https://your-venue-domain.example"
                className="mt-3 w-full max-w-md border border-input bg-emulsion px-3 py-2 font-mono text-xs"
              />
              {baseUrlIsLocal && (
                <p className="mt-2 max-w-md text-[0.72rem] leading-relaxed text-safelight">
                  This points at {publicBaseUrl || "localhost"}, which only means something on THIS
                  machine. A guest's phone needs the venue's real LAN IP or public domain here
                  before you print or show anything.
                </p>
              )}
            </div>

            <form onSubmit={createEvent} className="grid gap-3 sm:grid-cols-2">
              <p className="label-mono sm:col-span-2">New event</p>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Event name"
                required
                className="border border-input bg-emulsion px-3 py-2 text-sm"
              />
              <input
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="slug (e.g. hollis-marchetti)"
                required
                className="border border-input bg-emulsion px-3 py-2 font-mono text-xs"
              />
              <input
                value={newVenue}
                onChange={(e) => setNewVenue(e.target.value)}
                placeholder="Venue (optional)"
                className="border border-input bg-emulsion px-3 py-2 text-sm"
              />
              <input
                value={newZones}
                onChange={(e) => setNewZones(e.target.value)}
                placeholder="Zones, comma-separated (blank = single room)"
                className="border border-input bg-emulsion px-3 py-2 font-mono text-xs"
              />
              <div className="sm:col-span-2">
                {createEventError && (
                  <p className="mb-2 text-xs text-safelight">{createEventError}</p>
                )}
                <button
                  disabled={creatingEvent}
                  className="bg-fixer px-5 py-2 text-sm font-semibold text-emulsion disabled:opacity-50"
                >
                  {creatingEvent ? "Creating…" : "Create event"}
                </button>
              </div>
            </form>
          </section>

          <section className="py-8">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="label-mono">Hosted events</p>
              {eventsTotal > events.length && (
                <p className="font-mono text-[0.6rem] tracking-widest text-stale">
                  SHOWING {events.length} OF {eventsTotal}
                </p>
              )}
            </div>

            <ul className="mt-4 divide-y divide-border border-t border-border">
              {!eventsLoaded && (
                <li className="py-4 font-mono text-[0.65rem] text-stale">loading events…</li>
              )}
              {eventsLoaded && events.length === 0 && (
                <li className="py-4 font-mono text-[0.65rem] tracking-widest text-stale">
                  NO EVENTS HOSTED YET. CREATE ONE ABOVE.
                </li>
              )}
              {events.map((ev) => (
                <li key={ev.event_id} className="py-5">
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold">{ev.name}</p>
                      <p className="mt-0.5 font-mono text-[0.62rem] tracking-widest text-stale">
                        <span className={ev.status === "ended" ? "text-stale" : "text-converged"}>
                          {ev.status === "ended" ? "ENDED" : "ACTIVE"}
                        </span>
                        {" · "}/{ev.slug} ·{" "}
                        {ev.zones.length > 1 ? `${ev.zones.length} zones` : "single room"}
                        {ev.venue ? ` · ${ev.venue}` : ""}
                        {recapByEvent[ev.event_id]?.ready
                          ? ` · RECAP FROZEN, ${recapByEvent[ev.event_id]!.photos.length} PHOTOS`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-4 font-mono text-[0.62rem] tracking-widest">
                      <button
                        onClick={() => setSelectedEventId(ev.event_id)}
                        className={`border-b pb-0.5 ${
                          selectedEventId === ev.event_id
                            ? "border-drifting text-drifting"
                            : "border-transparent text-stale hover:text-fixer"
                        }`}
                      >
                        VIEW
                      </button>
                      <button
                        onClick={() => void copyJoinUrl(ev)}
                        className="border-b border-transparent pb-0.5 text-stale hover:text-fixer"
                      >
                        COPY LINK
                      </button>
                      <button
                        onClick={() => void toggleQr(ev)}
                        className={`border-b pb-0.5 ${
                          qrOpenId === ev.event_id
                            ? "border-fixer text-fixer"
                            : "border-transparent text-stale hover:text-fixer"
                        }`}
                      >
                        {qrOpenId === ev.event_id ? "HIDE QR" : "SHOW QR"}
                      </button>
                      <button
                        onClick={() => void freezeRecap(ev)}
                        disabled={recapBusyId === ev.event_id}
                        className="border-b border-transparent pb-0.5 text-drifting hover:border-drifting disabled:opacity-40"
                      >
                        {recapBusyId === ev.event_id
                          ? "FREEZING…"
                          : recapByEvent[ev.event_id]?.ready
                            ? "RE-CHECK RECAP"
                            : "END EVENT & FREEZE RECAP"}
                      </button>
                    </div>
                  </div>

                  {qrOpenId === ev.event_id && (
                    <div className="mt-5 flex flex-wrap items-center gap-6">
                      {qrSvgById[ev.event_id] ? (
                        <div
                          // [&>svg]:h-full/w-full is load-bearing: qrcode's
                          // toString(svg) hard-codes width="320" height="320"
                          // on the element, so without an override the injected
                          // SVG paints at its intrinsic size and spills over
                          // the link beside it and the rows below. The viewBox
                          // is what makes scaling it down lossless.
                          className="h-40 w-40 shrink-0 bg-white p-2 [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
                          // qrcode's output is our own generated markup, not
                          // user input -- nothing here ever comes from a guest.
                          dangerouslySetInnerHTML={{ __html: qrSvgById[ev.event_id]! }}
                        />
                      ) : (
                        <p className="font-mono text-[0.62rem] text-stale">rendering…</p>
                      )}
                      <div className="min-w-0 flex-1 space-y-3">
                        {/* Rendered from the cached token rather than by
                            calling joinUrl (now async, since tokens are
                            fetched on demand) -- toggleQr has already
                            resolved it by the time this panel is open. */}
                        <p className="break-all font-mono text-[0.65rem] text-fixer-dim">
                          {tokenBySlug[ev.slug]
                            ? `${publicBaseUrl || ""}/join/${ev.slug}?k=${tokenBySlug[ev.slug]}`
                            : "fetching join link…"}
                        </p>
                        <button
                          disabled={!qrSvgById[ev.event_id]}
                          onClick={() =>
                            qrSvgById[ev.event_id] &&
                            printJoinCard(qrSvgById[ev.event_id]!, ev.name, ev.venue)
                          }
                          className="border border-border px-3 py-1.5 font-mono text-[0.62rem] tracking-widest text-fixer-dim hover:text-fixer disabled:opacity-40"
                        >
                          PRINT TABLE CARD
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}
