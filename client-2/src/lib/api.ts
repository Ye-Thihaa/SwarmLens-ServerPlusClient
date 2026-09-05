/**
 * Talks to the real SwarmLens backend (../../main.py) -- 3 gossiping
 * nodes, no shared database, no central authority. Same node-picking
 * pattern as client/src/nodes.ts: race a cheap health check, use
 * whichever node answers first, treat "nobody answered" as a routine
 * offline state, never an error to surface loudly.
 */

export type RemotePhoto = {
  photo_id: string;
  guest_id: string;
  zone: string;
  /** Which hosted event this frame belongs to. Always present on the way
   * out -- store.py fills in "default" for anything logged before
   * multi-event hosting existed. */
  event_id: string;
  url: string;
  composition_score: number;
  likes: number;
  stored_on: string;
  vclock: Record<string, number>;
  concurrent_with: string[];
  taken_at: number; // unix seconds
};

export type ZoneScore = {
  zone: string;
  photos: number;
  likes: number;
  /** Distinct guests who shot here — a set union server-side, so it
   * survives a partition the way likes do. Not the same as `photos`:
   * one guest firing off ten frames is one guest. */
  guests: number;
  /** guests*3 + likes*2 + photos, computed server-side. Zones arrive
   * already sorted by it, so `zones[0]` is the popular spot. */
  popular_score: number;
  avg_aesthetic: number | null;
  owner: string;
  stale: boolean;
};

export type QuorumResult = {
  node: string;
  event_id: string | null;
  N: number;
  R: number;
  W: number;
  strongly_consistent: boolean;
  queried: string[];
  unreachable: string[];
  zones: ZoneScore[];
};

export type PeerState = { reachable: boolean | null; last_ok: number | null; fails: number };

export type NodeHealth = {
  node: string;
  events: number;
  digest: Record<string, number>;
  gossip: {
    rounds: number;
    events_pulled: number;
    events_pushed: number;
    peers: Record<string, PeerState>;
    partitioned: string[];
  };
  raft: {
    node: string;
    role: "follower" | "candidate" | "leader";
    term: number;
    leader_id: string | null;
    voted_for: string | null;
  };
};

/** This repo's standard local run (see README.md / docker-compose.yml):
 * node1:8001 <-> node2:8002 <-> node3:8003, all-to-all peers -- same
 * layout dashboard.html hardcodes. `peers` order matters: a node's
 * /chaos/partition/{peer_index} indexes into *that node's own* PEERS
 * env var, positionally, not by a global node id -- see CLAUDE.md's
 * chaos gotcha. 127.0.0.1 (not localhost) to match how the nodes were
 * actually launched (SELF_URL/PEERS in README.md), so gossip.partitioned
 * entries reported by /health line up with URL_TO_ID below. */
type ClusterNode = { id: string; url: string; peers: string[] };

const DEFAULT_CLUSTER_URLS = [
  "http://127.0.0.1:8001",
  "http://127.0.0.1:8002",
  "http://127.0.0.1:8003",
];

/** Builds the cluster from an ordered URL list. The ORDER is load-bearing
 * beyond naming: each node's `peers` must line up with that node's own
 * PEERS env var, because /chaos/partition/{i} indexes into it positionally
 * (CLAUDE.md's chaos gotcha). Deriving both from one ordered list is what
 * keeps them in step -- listing URLs in the same order the backends list
 * each other is the only thing a deployer has to get right.
 *
 * VITE_CLUSTER_URLS exists for deployments where the nodes aren't on
 * loopback (three Render services, say). It must be VITE_-prefixed and so
 * is baked into the client bundle at build time -- that's acceptable
 * because these are the same URLs the guest app already calls, not a
 * secret. The operator TOKEN still never reaches the browser; it stays in
 * the server functions (lib/operatorGateway.ts). */
function buildCluster(urls: string[]): ClusterNode[] {
  const ids = urls.map((_, i) => `node${i + 1}`);
  return urls.map((url, i) => ({
    id: ids[i]!,
    url: url.replace(/\/+$/, ""), // a trailing slash would double up in every path
    peers: ids.filter((_, j) => j !== i),
  }));
}

const clusterUrlsFromEnv = (import.meta.env["VITE_CLUSTER_URLS"] as string | undefined)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const CLUSTER: ClusterNode[] = buildCluster(
  clusterUrlsFromEnv?.length ? clusterUrlsFromEnv : DEFAULT_CLUSTER_URLS,
);

function configuredNodeUrls(): string[] {
  const fromEnv = import.meta.env["VITE_NODE_URLS"] as string | undefined;
  if (fromEnv)
    return fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return CLUSTER.map((n) => n.url);
}

export const NODES = configuredNodeUrls();
export const CLUSTER_SIZE = NODES.length;
export const URL_TO_ID: Record<string, string> = Object.fromEntries(
  CLUSTER.map((n) => [n.url, n.id]),
);

/** The zones the DEFAULT event uses -- every photo logged before hosted
 * events existed carries one of these. A real event brings its own list
 * (see lib/event.ts's JoinedEvent.zones, set by the host in the operator
 * console); this is only the fallback for a guest who opened the app
 * without scanning anything. */
export const ZONES = ["flower_arch", "bar", "dance_floor", "photo_booth", "entrance"];

/** Composited strips from routes/album.tsx are ordinary photos tagged with
 * this zone -- that's how event.$slug.tsx's "Photo booth" tab finds them
 * again. It isn't a place in the room, so a host never lists it among an
 * event's zones, and it can show up in /zones for an event that didn't
 * declare it. That's expected: it's a marker, not a corner. */
export const BOOTH_ZONE = "photo_booth";

export function prettyZone(zone: string): string {
  return zone.replace(/_/g, " ");
}

// ---- hosted events ------------------------------------------------------

export type HostedEvent = {
  event_id: string;
  slug: string;
  name: string;
  venue: string;
  when: string;
  zones: string[];
  created_at: number;
};

/** What the operator console lists. Still gated (a public directory of
 * every event on the cluster is what multi-tenant hosting has to avoid),
 * but deliberately **without** join_token: the console polls this every
 * 5s, and shipping every event's credential to a browser on a timer is
 * both needless exposure and needless bytes once a venue has run a
 * season. Fetch one on demand with fetchJoinToken when actually printing
 * a QR. `status` is derived server-side from whether that event's recap
 * has been frozen. */
export type HostedEventAdmin = HostedEvent & {
  created_by: string;
  status: "active" | "ended";
};

export type HostedEventPage = {
  total: number;
  limit: number;
  offset: number;
  events: HostedEventAdmin[];
};

/** Resolves one scanned QR: slug (+ its join token) -> the event_id every
 * later call carries. Returns null for both "no such event" and "wrong
 * token" -- main.py answers 404 to both on purpose, and so should the UI:
 * telling a scanner that the slug exists but their token is wrong is a
 * distinction only someone probing for other people's events cares
 * about. */
export async function resolveEvent(
  node: string,
  slug: string,
  joinToken: string,
): Promise<HostedEvent | null> {
  const r = await fetch(`${node}/events/${encodeURIComponent(slug)}?k=${encodeURIComponent(joinToken)}`);
  if (r.status === 404) return null;
  const body = await asJson<{ node: string; event: HostedEvent }>(r, `${node}/events/${slug}`);
  return body.event;
}

/** The operator's own list, join tokens included -- gated by
 * OPERATOR_TOKEN like the chaos endpoints. Called only from
 * lib/operatorGateway.ts's server functions, never straight from the
 * browser, so the token stays server-side. */
export const listHostedEvents = (
  node: string,
  headers: Record<string, string> = {},
  opts: { status?: "active" | "ended"; limit?: number; offset?: number } = {},
) => {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  q.set("limit", String(opts.limit ?? 50));
  q.set("offset", String(opts.offset ?? 0));
  return fetch(`${node}/events?${q}`, { headers }).then((r) =>
    asJson<HostedEventPage & { node: string }>(r, `${node}/events`),
  );
};

/** One event's join token, fetched only when an operator actually prints
 * that event's QR -- see HostedEventAdmin above for why the list no
 * longer carries them. Server-side only (operator-gated), like the list. */
export const fetchJoinToken = (
  node: string,
  slug: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${node}/events/${encodeURIComponent(slug)}/token`, { headers }).then((r) =>
    asJson<{ event_id: string; slug: string; join_token: string }>(
      r,
      `${node}/events/${slug}/token`,
    ),
  );

export type CreateEventResult =
  | { ok: true; event: HostedEventAdmin }
  | { ok: false; reason: "slug_taken" | "invalid" | "error" };

/** Registers (or, passing back an existing event_id, edits) one hosted
 * event. Same gate as the chaos endpoints -- see require_operator_token
 * in main.py -- routed through the server function below so
 * OPERATOR_TOKEN never reaches client JS. */
export async function createHostedEvent(
  node: string,
  body: {
    slug: string;
    name: string;
    venue: string;
    when: string;
    zones: string[];
    event_id: string | undefined;
  },
  headers: Record<string, string> = {},
): Promise<CreateEventResult> {
  const r = await fetch(`${node}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true, event: (await r.json()) as HostedEventAdmin };
  if (r.status === 409) return { ok: false, reason: "slug_taken" };
  if (r.status === 400) return { ok: false, reason: "invalid" };
  return { ok: false, reason: "error" };
}

/** Races a cheap health check across every configured node and returns
 * whichever answers first, or null when none do.
 *
 * The timeout is a worst-case bound, not a latency target: Promise.any
 * settles the moment ANY node answers, so a healthy cluster resolves in
 * milliseconds regardless of what this is set to. It only decides how
 * long to wait before declaring the cluster unreachable.
 *
 * 1500ms was too tight, and produced a symptom that looked like the
 * backend flapping. On a machine with a loopback-intercepting proxy (a
 * VPN client, a corporate proxy -- see CLAUDE.md's proxy gotcha), a COLD
 * connection was measured at ~2.1s against ~12ms once the proxy had a
 * warm connection to reuse. So the first poll after an idle gap blew the
 * budget on all three nodes at once and rendered "NO NODE REACHABLE",
 * then the next poll succeeded instantly -- intermittent, with nothing
 * wrong on the backend at all (containers never restarted; raft never
 * lost its leader). The same shape shows up on a phone waking its radio,
 * which is exactly when a guest opens the app. */
export async function pickNode(timeoutMs = 4000): Promise<string | null> {
  const attempts = NODES.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`${url}/health`, { signal: controller.signal });
      if (!r.ok) throw new Error(`${url} unhealthy`);
      return url;
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null; // AggregateError -- every node failed or timed out
  }
}

async function asJson<T>(r: Response, what: string): Promise<T> {
  if (!r.ok) throw new Error(`${what} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export const getHealth = (node: string) =>
  fetch(`${node}/health`).then((r) => asJson<NodeHealth>(r, `${node}/health`));

/** Every read below takes the event the caller is scoped to, as a REQUIRED
 * parameter typed `string | undefined` -- required so no call site can
 * forget it exists, `| undefined` so the one legitimate caller that wants
 * every event merged (the operator console's cluster-wide overview) can
 * ask for that on purpose rather than by omission. Every guest-facing
 * route always passes a real event_id (see lib/event.ts's
 * useCurrentEvent); only routes/console.tsx ever passes undefined. */
function eventQuery(eventId: string | undefined): string {
  return eventId ? `event_id=${encodeURIComponent(eventId)}` : "";
}

export const getPhotos = (node: string, eventId: string | undefined) =>
  fetch(`${node}/photos${eventId ? `?${eventQuery(eventId)}` : ""}`)
    .then((r) => asJson<{ node: string; photos: RemotePhoto[] }>(r, `${node}/photos`))
    .then((b) => b.photos);

export function photoImageUrl(node: string, photoId: string): string {
  return `${node}/photos/${photoId}/image`;
}

export const postPhoto = (
  node: string,
  body: {
    guest_id: string;
    zone: string;
    composition_score: number;
    vclock: Record<string, number>;
    image_base64: string;
    event_id: string;
  },
) =>
  fetch(`${node}/photos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => asJson<{ ok: boolean; photo_id: string; seq: number }>(r, `${node}/photos POST`));

/** Fires ai_engine.py's pretrained analysis (saliency AR guide, CLIP
 * film-stock suggestion, CLIP+LAION aesthetic score) on a photo this
 * device already has the bytes for. The resulting aesthetic_score event
 * feeds GET /zones' avg_aesthetic the normal way -- see main.py's
 * /analyze docstring. Can be slow on a cold model download (~154MB,
 * first call only); callers should treat this as fire-and-forget, never
 * block a photo's upload on it. */
export const postAnalyze = (node: string, body: { photo_id: string; image_base64: string }) =>
  fetch(`${node}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) =>
    asJson<{ ar_guide: unknown; suggested_filter: string; aesthetic_score: number }>(
      r,
      `${node}/analyze`,
    ),
  );

type Rect = { x: number; y: number; w: number; h: number };

/** Directions come in matched, opposite pairs -- read the field names.
 * move_subject_* is which way the subject should shift *within the frame*;
 * pan_camera_* is which way to turn the camera to achieve that, which is
 * the inverse. Rendering the wrong one gives the guest a confidently
 * backwards arrow, so the UI should use pan_camera_* for anything shaped
 * like an instruction. See ai_engine.compute_ar_guide. */
export type ArGuide = {
  centroid: { x: number; y: number };
  image_size: { w: number; h: number };
  target: { x: number; y: number };
  dx: number;
  dy: number;
  move_subject_x: "left" | "right" | "centered";
  move_subject_y: "up" | "down" | "centered";
  pan_camera_x: "left" | "right" | "centered";
  pan_camera_y: "up" | "down" | "centered";
  strength: "none" | "slight" | "moderate" | "large";
  subject_found: boolean;
  /** Which detector actually answered. "face" is YuNet and is far more
   * trustworthy about *what the photo is of*; "saliency" only knows what
   * is visually unusual, so it can box a bright lamp beside the guest. */
  subject_source: "face" | "saliency";
  well_composed: boolean;
};

/** rect/subject_box are normalized 0..1 against the frame that was sent,
 * so they overlay the viewfinder directly -- which is why the client must
 * send the frame cropped the way it's displayed (see grabPreviewFrame in
 * routes/capture.tsx), not the raw uncropped sensor image. */
export type Reframe = {
  rect: Rect;
  subject_box: Rect;
  zoom: number;
  worth_it: boolean;
  subject_found: boolean;
};

/** Dominant face only, null when there isn't one. eyes_open/smiling come
 * from MediaPipe blendshapes (trained 0..1 outputs); roll/yaw come from
 * YuNet's landmarks. `turned` is returned but deliberately not surfaced --
 * it hasn't been validated across enough faces to tell a guest. */
export type FaceState = {
  roll_deg: number;
  level: boolean;
  yaw_ratio: number;
  facing_camera: boolean;
  turned: "none" | "left" | "right";
  eyes_open?: boolean;
  blink_left?: number;
  blink_right?: number;
  smiling?: boolean;
  smile_score?: number;
};

export type ComposePreview = {
  ar_guide: ArGuide;
  reframe: Reframe;
  face: FaceState | null;
  scene: {
    colors: string[];
    saturation: "low" | "medium" | "high";
    brightness: "dark" | "even" | "bright";
    mean_saturation: number;
    mean_brightness: number;
  };
  suggested_filter: string;
  /** False when the top two stocks are within CONFIDENT_MARGIN of each
   * other -- i.e. a tie. The UI must soften its copy rather than assert a
   * preference the scores don't support. */
  confident: boolean;
  margin: number;
  picks: { key: string; name: string; score: number }[];
  reason: string;
  aesthetic_score: number;
};

/** Live viewfinder guidance, computed but never persisted (unlike
 * postAnalyze above, which appends an aesthetic_score event). Returns
 * null when the node sheds the request with 503 -- every preview slot
 * busy is an expected, routine outcome under load, not an error worth
 * surfacing: the caller just tries again on its next tick. */
export async function postAnalyzePreview(
  node: string,
  body: { image_base64: string; aspect: number },
  signal?: AbortSignal,
): Promise<ComposePreview | null> {
  const r = await fetch(`${node}/analyze/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? null, // exactOptionalPropertyTypes: RequestInit wants null, not undefined
  });
  if (r.status === 503) return null;
  return asJson<ComposePreview>(r, `${node}/analyze/preview`);
}

export const postLike = (
  node: string,
  body: { guest_id: string; photo_id: string; vclock: Record<string, number> },
) =>
  fetch(`${node}/likes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => asJson<{ ok: boolean; likes: number }>(r, `${node}/likes POST`));

// Mirrors main.py's PUBLIC_LIMIT_PER_GUEST -- a curation cap (best strips
// of the night, not a dump of the whole roll), enforced server-side so it
// holds no matter which node a guest's toggle lands on. Kept in sync by
// hand since this repo has no shared config between the two languages.
export const PUBLIC_LIMIT_PER_GUEST = 25;

export const getPublicPhotos = (node: string, eventId: string | undefined) =>
  fetch(`${node}/photos/public${eventId ? `?${eventQuery(eventId)}` : ""}`)
    .then((r) => asJson<{ node: string; photos: RemotePhoto[] }>(r, `${node}/photos/public`))
    .then((b) => b.photos);

export type PublicMarkResult =
  | { ok: true }
  | { ok: false; reason: "limit" | "forbidden" | "not_found" | "error" };

/** Opts one of this guest's own photos into (or out of) the public
 * gallery. Doesn't throw on the expected failure modes -- a full quota or
 * a stale photo_id are routine outcomes the caller should show inline,
 * not exceptions to catch. */
export async function setPhotoPublic(
  node: string,
  body: { guest_id: string; photo_id: string; public: boolean; vclock: Record<string, number> },
): Promise<PublicMarkResult> {
  const r = await fetch(`${node}/photos/public`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  if (r.status === 409) return { ok: false, reason: "limit" };
  if (r.status === 403) return { ok: false, reason: "forbidden" };
  if (r.status === 404) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "error" };
}

export type DeleteResult = { ok: true } | { ok: false; reason: "forbidden" | "not_found" | "error" };

/** Retracts one of this guest's own photos everywhere (see main.py's
 * POST /photos/delete docstring) -- the room feed, zones, likes, and the
 * public gallery, once gossip catches up on every node. Only meant to be
 * called for a photo currently in the public gallery; a private roll
 * photo never needs the network at all, see outbox.ts's removePhoto. */
export async function deletePhoto(
  node: string,
  body: { guest_id: string; photo_id: string; vclock: Record<string, number> },
): Promise<DeleteResult> {
  const r = await fetch(`${node}/photos/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true };
  if (r.status === 403) return { ok: false, reason: "forbidden" };
  if (r.status === 404) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "error" };
}

// ---- end-of-event recap: the frozen "most memorable" slideshow ---------

export type RecapPhoto = { photo_id: string; guest_id: string; zone: string; likes: number };

export type Recap = { event_id: string; ready: boolean; photos: RecapPhoto[] };

/** Mirrors main.py's RECAP_TOP_N -- the real default, kept in sync by hand
 * like PUBLIC_LIMIT_PER_GUEST above. Only used for copy ("top 10"), never
 * to slice the array client-side -- the server already capped it. */
export const RECAP_TOP_N = 10;

/** The frozen top-liked snapshot for one event's recap slideshow, once an
 * operator has called the event over (see triggerRecap below). No token
 * needed to read -- same reasoning as getPublicPhotos: a guest coming back
 * to relive the night is exactly who this is for. `ready: false` with an
 * empty list is the routine "nothing frozen yet" state, not an error --
 * the UI should say "check back later," never show a broken-page state. */
export const getRecap = (node: string, eventId: string) =>
  fetch(`${node}/recap?${eventQuery(eventId)}`).then((r) => asJson<Recap>(r, `${node}/recap`));

/** Freezes an event's top-liked-photos snapshot. Idempotent and safe to
 * call on every node -- same broadcast pattern as the chaos actions, since
 * the caller doesn't know which node is the Raft leader and only the
 * leader's call actually appends anything. Routed through
 * lib/operatorGateway.ts so OPERATOR_TOKEN stays server-side, like every
 * other operator action. */
export const triggerRecap = (node: string, eventId: string, headers: Record<string, string> = {}) =>
  fetch(`${node}/recap/trigger?${eventQuery(eventId)}`, { method: "POST", headers }).then((r) =>
    asJson<{ triggered: boolean; by: string; event_id: string }>(r, `${node}/recap/trigger`),
  );

export const getZones = (node: string, eventId: string | undefined) =>
  fetch(`${node}/zones${eventId ? `?${eventQuery(eventId)}` : ""}`)
    .then((r) => asJson<{ node: string; zones: ZoneScore[] }>(r, `${node}/zones`))
    .then((b) => b.zones);

export const getZonesQuorum = (node: string, R: number, W: number, eventId: string | undefined) =>
  fetch(
    `${node}/zones/quorum?R=${R}&W=${W}${eventId ? `&${eventQuery(eventId)}` : ""}`,
  ).then((r) => asJson<QuorumResult>(r, `${node}/zones/quorum`));

/** headers is how main.py's OPERATOR_TOKEN gate gets satisfied -- see
 * lib/operatorGateway.ts, the only real caller. A plain browser call
 * with no headers still works when a node has no OPERATOR_TOKEN
 * configured (main.py fails open when it's unset), which is why these
 * two stay exported and usable on their own, not folded into the
 * gateway file. */
export const chaosPartition = (
  node: string,
  peerIndex: number,
  headers: Record<string, string> = {},
) =>
  fetch(`${node}/chaos/partition/${peerIndex}`, { method: "POST", headers }).then((r) =>
    asJson<{ partitioned_from: string }>(r, `${node}/chaos/partition`),
  );

export const chaosHeal = (node: string, headers: Record<string, string> = {}) =>
  fetch(`${node}/chaos/heal`, { method: "POST", headers }).then((r) =>
    asJson<{ partitioned_from: string[] }>(r, `${node}/chaos/heal`),
  );

/** Fully isolate a node from the rest of the cluster: partition it in
 * BOTH directions from every other node, not just its own outgoing
 * gossip -- a one-sided partition self-heals within a gossip round or
 * two (CLAUDE.md's chaos gotcha). Same 4-call pattern as dashboard.html's
 * isolate(). Raft heartbeats are unaffected by this (they bypass
 * gossip.partitioned entirely -- see raft.py) so this demonstrates
 * gossip/quorum staleness, not a forced re-election. */
export async function isolateNode(
  nodeId: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const node = CLUSTER.find((n) => n.id === nodeId);
  if (!node) return;
  const calls: Promise<unknown>[] = [];
  node.peers.forEach((peerId, idx) => {
    calls.push(chaosPartition(node.url, idx, headers));
    const peer = CLUSTER.find((n) => n.id === peerId)!;
    const backIdx = peer.peers.indexOf(node.id);
    calls.push(chaosPartition(peer.url, backIdx, headers));
  });
  await Promise.allSettled(calls);
}

/** Targets CLUSTER (absolute 127.0.0.1 URLs), not NODES, for the same
 * reason isolateNode above does: NODES can be VITE_NODE_URLS' relative
 * same-origin proxy paths (/n1,/n2,/n3), set for phone testing over
 * HTTPS -- see vite.config.ts. Those only resolve against a browser's own
 * page origin. This runs server-side, inside serverHealAll's TanStack
 * server function (see operatorGateway.ts), where there is no page
 * origin to resolve a relative URL against -- a bare fetch("/n1/...")
 * fails, and Promise.allSettled swallows it silently, so "Heal all" would
 * log success and do nothing whenever a phone-testing VITE_NODE_URLS was
 * left configured. Confirmed live: the console reported "heal requested"
 * and the partition never actually cleared until this was fixed. */
export async function healAllNodes(headers: Record<string, string> = {}): Promise<void> {
  await Promise.allSettled(CLUSTER.map((n) => chaosHeal(n.url, headers)));
}

/** How many of the N configured nodes already hold each photo_id, right
 * now -- a real replica count, not a simulated one. Tolerant of down/
 * partitioned nodes (allSettled): those simply don't contribute a count,
 * which is itself the point -- a low count during a partition is real
 * signal, not a bug to paper over. */
export async function replicaAcks(
  photoIds: string[],
  eventId: string | undefined,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(photoIds.map((id) => [id, 0]));
  const results = await Promise.allSettled(NODES.map((n) => getPhotos(n, eventId)));
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    const ids = new Set(res.value.map((p) => p.photo_id));
    for (const id of photoIds) if (ids.has(id)) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}
