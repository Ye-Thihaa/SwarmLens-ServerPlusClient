/**
 * Offline-first local queue: photos and likes get written here
 * immediately, rendered optimistically, then synced to the cluster in
 * the background. Same shape as the Phase 5 reference client's Dexie
 * outbox (client/src/db.ts + sync.ts), backed by localStorage instead of
 * IndexedDB -- simpler for this app, at the cost of localStorage's
 * ~5-10MB per-origin ceiling, which is fine for a demo's worth of queued
 * photos but not a real deployment's.
 */

import { useSyncExternalStore } from "react";
import { pickNode, postAnalyze, postLike, postPhoto } from "./api";
import { DEFAULT_EVENT_ID } from "./event";

export type OutboxPhoto = {
  local_id: string;
  kind: "photo";
  guest_id: string;
  zone: string;
  composition_score: number;
  vclock: Record<string, number>;
  image_base64: string;
  created_at: number;
  synced: boolean;
  photo_id?: string;
  error?: string;
  /** The event this frame was SHOT at, captured at queue time and never
   * re-read from the current event when it finally syncs. That distinction
   * is the whole point: a guest shooting offline at a wedding, then
   * walking into the next room and scanning that event's QR, would
   * otherwise have their queued wedding frames drain into the second
   * event -- visible to a roomful of strangers, not a UI glitch. Absent on
   * rows queued before hosted events existed; treated as "default". */
  event_id?: string;
};

export type OutboxLike = {
  local_id: string;
  kind: "like";
  guest_id: string;
  photo_id: string;
  vclock: Record<string, number>;
  created_at: number;
  synced: boolean;
  error?: string;
};

export type OutboxItem = OutboxPhoto | OutboxLike;

const STORAGE_KEY = "swarmlens_outbox";

/** Thrown when a write to the outbox's backing localStorage fails --
 * almost always because the ~5-10MB per-origin quota (see this file's
 * module docstring) got hit by the accumulated base64 JPEGs of a long
 * shooting session. `quotaExceeded` lets a caller give the guest a
 * specific, actionable message ("your roll is full") instead of a generic
 * failure, since the fix (delete a photo, or sync while online) is
 * different from any other kind of write failure. */
export class OutboxWriteError extends Error {
  quotaExceeded: boolean;
  constructor(cause: unknown) {
    super("Couldn't save to this device's local roll.");
    this.cause = cause;
    this.quotaExceeded = cause instanceof DOMException && cause.name === "QuotaExceededError";
  }
}

function readAll(): OutboxItem[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as OutboxItem[];
  } catch {
    return [];
  }
}

/** Every mutator below (`addPhoto`, `addLike`, `removePhoto`, `patch`)
 * goes through this, so a failure here is the ONE place that needs to
 * turn into a clear, catchable error rather than an uncaught
 * `QuotaExceededError` a caller several stack frames away never sees.
 * Before this wrapped the failure, `confirmReview` in `routes/capture.tsx`
 * closed its review sheet unconditionally right after calling `addPhoto`
 * -- so a guest whose roll was full would watch "USE THIS FRAME" appear
 * to work (the sheet closed, the camera looked normal) while the photo
 * silently never made it into the outbox at all. */
function writeAll(items: OutboxItem[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    throw new OutboxWriteError(e);
  }
}

const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const EMPTY: OutboxItem[] = [];

// useSyncExternalStore requires a stable (===) snapshot when nothing
// changed -- readAll() re-parses JSON on every call, which is a *new*
// array reference every time even when localStorage is untouched, so
// React sees "changed" on every render and loops forever. Cache against
// the raw string and only re-parse when it actually differs.
let cachedRaw: string | null = null;
let cachedSnapshot: OutboxItem[] = EMPTY;

function getSnapshot(): OutboxItem[] {
  if (typeof window === "undefined") return EMPTY;
  const raw = localStorage.getItem(STORAGE_KEY) ?? "[]";
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedSnapshot = JSON.parse(raw) as OutboxItem[];
    } catch {
      cachedSnapshot = EMPTY;
    }
  }
  return cachedSnapshot;
}

export function useOutbox(): OutboxItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** The queued photos belonging to one event. Every guest screen that reads
 * the outbox goes through this rather than filtering inline, so the
 * "missing event_id means default" fallback for rows queued before hosted
 * events existed lives in one place instead of four. */
export function photosForEvent(items: OutboxItem[], eventId: string): OutboxPhoto[] {
  return items.filter(
    (it): it is OutboxPhoto =>
      it.kind === "photo" && (it.event_id ?? DEFAULT_EVENT_ID) === eventId,
  );
}

export function addPhoto(item: Omit<OutboxPhoto, "kind" | "synced" | "created_at">): OutboxPhoto {
  const full: OutboxPhoto = { ...item, kind: "photo", synced: false, created_at: Date.now() };
  try {
    writeAll([full, ...readAll()]);
  } catch (e) {
    // A full quota is usually just bytes we no longer need -- reclaim
    // them and try once more before telling a guest their roll is full,
    // since "delete a photo" is a bad thing to demand when nothing the
    // guest can see is actually taking up the space.
    if (!(e instanceof OutboxWriteError && e.quotaExceeded) || releaseSyncedPhotoBytes() === 0) {
      throw e;
    }
    writeAll([full, ...readAll()]);
  }
  notify();
  return full;
}

export function addLike(item: Omit<OutboxLike, "kind" | "synced" | "created_at">): OutboxLike {
  const full: OutboxLike = { ...item, kind: "like", synced: false, created_at: Date.now() };
  writeAll([full, ...readAll()]);
  notify();
  return full;
}

/** Removes one item from this device's own roll -- for a photo that was
 * never made public, this is the *entire* delete operation (see
 * api.ts's deletePhoto docstring): nothing was ever shared beyond this
 * outbox, so there's nothing on the cluster to retract. For a photo
 * that *was* public, the caller (mine.tsx) sends the network tombstone
 * first and only calls this once that's confirmed -- a failed backend
 * call should leave the roll entry in place, not silently vanish while
 * the room still has the photo. */
export function removePhoto(local_id: string) {
  writeAll(readAll().filter((it) => it.local_id !== local_id));
  notify();
}

function patch(local_id: string, changes: Partial<OutboxItem>) {
  writeAll(
    readAll().map((it) => (it.local_id === local_id ? ({ ...it, ...changes } as OutboxItem) : it)),
  );
  notify();
}

/** Releases the base64 of rows that synced before this device learned to
 * drop it. Without this the fix above only helps guests whose roll is not
 * already full -- everyone else stays wedged, because a full quota blocks
 * the very writes that would clear it, and the only escape is clearing
 * site data. Returns how many rows it freed. Safe to call on every pass:
 * it writes only when it actually found something. */
export function releaseSyncedPhotoBytes(): number {
  const items = readAll();
  let freed = 0;
  const next = items.map((it) => {
    if (it.kind === "photo" && it.synced && it.photo_id && it.image_base64) {
      freed++;
      return { ...it, image_base64: "" };
    }
    return it;
  });
  if (freed === 0) return 0;
  try {
    writeAll(next);
  } catch {
    return 0; // shrinking should never fail, but never let cleanup throw
  }
  notify();
  return freed;
}

/** Drains every unsynced outbox row against whichever node answers
 * fastest. Never throws -- an unreachable cluster is a routine, expected
 * state here, not an error. Same shape as client/src/sync.ts's
 * syncOutbox in the Phase 5 reference client. */
export async function syncOutbox(): Promise<{ attempted: number; synced: number }> {
  releaseSyncedPhotoBytes();
  const pending = readAll().filter((it) => !it.synced);
  let synced = 0;
  for (const item of pending) {
    if (await syncOne(item)) synced++;
  }
  return { attempted: pending.length, synced };
}

async function syncOne(item: OutboxItem): Promise<boolean> {
  const node = await pickNode();
  if (!node) return false; // stay queued -- no node reachable right now
  try {
    if (item.kind === "photo") {
      const res = await postPhoto(node, {
        guest_id: item.guest_id,
        zone: item.zone,
        composition_score: item.composition_score,
        vclock: item.vclock,
        image_base64: item.image_base64,
        event_id: item.event_id ?? DEFAULT_EVENT_ID,
      });
      // Drop the bytes at the same moment they stop being this device's
      // only copy. The cluster now holds them as a blob, replicated to
      // all three nodes and served back by GET /photos/{id}/image, so
      // keeping the base64 here buys nothing and costs the whole roll:
      // at ~200KB a frame against localStorage's ~5MB origin quota, a
      // guest hit "your roll is full" after roughly twenty shots and
      // never recovered, because nothing ever released a synced row.
      // Worse, the wall was invisible -- My roll filters to the joined
      // event (photosForEvent), so a fresh event read "0 frames tonight"
      // while the quota was still full of a previous event's photos.
      // postAnalyze below still sends the bytes: it closes over `item`,
      // the in-memory row, not what's left in storage.
      patch(item.local_id, { synced: true, photo_id: res.photo_id, image_base64: "" });
      // Fire-and-forget: populates a real aesthetic_score for this photo
      // (see api.ts's postAnalyze docstring). Never blocks the outbox --
      // a cold model download shouldn't stall every other queued item.
      void postAnalyze(node, { photo_id: res.photo_id, image_base64: item.image_base64 }).catch(
        () => {},
      );
    } else {
      await postLike(node, {
        guest_id: item.guest_id,
        photo_id: item.photo_id,
        vclock: item.vclock,
      });
      patch(item.local_id, { synced: true });
    }
    return true;
  } catch (e) {
    patch(item.local_id, { error: String(e) });
    return false;
  }
}

export function hasLiked(photoId: string): boolean {
  return readAll().some((it) => it.kind === "like" && it.photo_id === photoId);
}
