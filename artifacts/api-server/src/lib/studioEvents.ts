/**
 * Studio live-reload event bus (M9 Phase 2).
 *
 * A tiny, in-process Server-Sent-Events fan-out the embedded
 * `@hyperframes/studio` editor subscribes to (`GET /api/studio/events`) so its
 * file tree / preview hot-reloads the instant a file-CRUD route mutates the
 * workspace on disk. Connections are keyed by `userId` — multi-tenant isolation
 * holds here too: a user only ever receives change events for their OWN
 * workspaces (the route layer always emits with the authenticated `req.user.id`).
 *
 * SINGLE-INSTANCE by design: the registry is a module-level `Map`, so it only
 * fans out within ONE Node process. That's correct for the Railway single
 * container we ship today; a Redis pub/sub fan-out for horizontal scale is
 * tracked as future work (mirrors the auth rate-limiter follow-on).
 */
import { type Response } from "express";

/**
 * userId → the set of open SSE responses for that user. A user can have several
 * concurrent connections (multiple Studio tabs); every one gets each event.
 */
const subscribers = new Map<string, Set<Response>>();

/**
 * Register an SSE `Response` under `userId`. Returns an unsubscribe function the
 * route MUST call on `req.on("close")` so a disconnected client is dropped from
 * the fan-out (and the empty user bucket is reaped to avoid an unbounded Map).
 */
export function subscribe(userId: string, res: Response): () => void {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set<Response>();
    subscribers.set(userId, set);
  }
  set.add(res);

  return () => {
    const current = subscribers.get(userId);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) subscribers.delete(userId);
  };
}

/**
 * Best-effort write of `payload` to an SSE response. `res.write` can throw if the
 * socket was torn down between the `close` event firing and this call (a race we
 * can't fully lock out); swallow it — the `close` handler will have already
 * unsubscribed, so a stray failed write is harmless.
 */
function safeWrite(res: Response, payload: string): void {
  try {
    if (!res.writableEnded) {
      res.write(payload);
    }
  } catch {
    // Write-after-close: the connection is gone; nothing to do.
  }
}

/**
 * Notify every one of `userId`'s open Studio connections that `path` changed.
 * Emitted by the write / create / delete / rename / duplicate file routes. The
 * studio client listens for `file-change` and reloads the affected file.
 */
export function emitFileChange(userId: string, path: string): void {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  const payload = `event: file-change\ndata: ${JSON.stringify({ path })}\n\n`;
  for (const res of set) {
    safeWrite(res, payload);
  }
}

/**
 * Process-lifetime heartbeat: SSE proxies (and some browsers) drop a connection
 * that's been idle too long. A periodic comment line keeps every connection
 * warm without emitting a real event. `.unref()` so this timer never holds the
 * process open on its own. It is intentionally never cleared — one interval for
 * the lifetime of the server is not a leak.
 */
const HEARTBEAT_MS = 25_000;
const heartbeat = setInterval(() => {
  for (const set of subscribers.values()) {
    for (const res of set) {
      safeWrite(res, ": ping\n\n");
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();
