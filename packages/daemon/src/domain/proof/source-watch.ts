import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import type { ScopeFsDeps } from "../scope/scope-view-projection.js";
import { createProofPolicyRead, proofFs, readProjectReadiness, resolveProjectRoot } from "./judgments.js";

export interface ProofSourceWatch {
  close(): void;
  observation(): { state: "watching" | "unavailable"; revision: string };
}
export function proofSourceObservation(c: { get: (key: never) => unknown }) {
  return (c.get("proofSourceWatch" as never) as ProofSourceWatch | undefined)?.observation() ?? { state: "unavailable", revision: "unverified" };
}

/** A needed watch could not be attached: the sources are not observed (distinct from an input that can't be read). */
class WatchFailure extends Error {}

/** Per directory outside the missions root, the entry names that matter there. */
type Shallow = Map<string, Set<string>>;

const within = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
function add(out: Shallow, dir: string, name: string) {
  const names = out.get(dir) ?? new Set<string>();
  names.add(name);
  out.set(dir, names);
}

/** Where each path the evaluation read outside the missions root is observed: its parent, shallow, filtered to its
 *  name (for a missing parent, the nearest existing ancestor, filtered to the next segment toward it). Every watched
 *  directory, the missions root included, is also anchored at each ancestor up to `top`, filtered to the next segment,
 *  so a replaced or re-pointed directory on the way is seen and its watch rebound. */
function shallowWatches(missionsRoot: string, top: string, read: Iterable<string>): Shallow {
  const out: Shallow = new Map();
  for (const file of read) {
    const target = path.resolve(file);
    if (within(target, missionsRoot)) continue;
    let child = target, dir = path.dirname(target);
    while (dir !== child && !proofFs.exists(dir)) { child = dir; dir = path.dirname(dir); }
    if (dir === child) continue;
    add(out, dir, path.basename(child));
  }
  for (const watched of [...out.keys(), missionsRoot]) {
    for (let p = watched; within(p, top) && p !== top; p = path.dirname(p)) add(out, path.dirname(p), path.basename(p));
  }
  return out;
}

/**
 * Push invalidation over the existing bus; existing client quiet refresh is the missed-event repair.
 * The missions root is watched recursively. Anything else the readiness evaluation reads (project and policy files,
 * including absent nearer ones, and accepted evidence elsewhere in the project) is watched at its parent directory,
 * not recursively, so sibling checkouts and build trees are never subscribed to.
 */
export function watchProofSources(missionsRoot: string, invalidate: () => void, bus: EventBus): ProofSourceWatch {
  missionsRoot = path.resolve(missionsRoot);
  let projectRoot = path.dirname(missionsRoot);
  try { projectRoot = resolveProjectRoot(missionsRoot) ?? projectRoot; } catch { /* Legacy roots keep the missions root's parent. */ }
  const top = path.dirname(path.resolve(projectRoot));
  // ponytail: bounded local workspaces use a full semantic read after a file burst.
  // Keep this workload measured; subtree indexing is warranted only when that bound is exceeded.
  const basis = () => {
    const read = new Set<string>();
    const note = (p: string) => { read.add(p); return p; };
    const io: ScopeFsDeps = {
      exists: (p) => proofFs.exists(note(p)),
      readFile: (p) => proofFs.readFile(note(p)),
      ...(proofFs.readBytes ? { readBytes: (p: string) => proofFs.readBytes!(note(p)) } : {}),
      listDir: (p) => proofFs.listDir(note(p)),
      isDirectory: (p) => proofFs.isDirectory(note(p)),
    };
    const hash = createHash("sha256").update(JSON.stringify(readProjectReadiness(missionsRoot, createProofPolicyRead(), undefined, io).missions.map(m => [m.name, m.revision]))).digest("hex");
    return { hash, watches: shallowWatches(missionsRoot, top, read) };
  };
  // failed latches for this instance: a watcher that errored is not trusted to be replaced by a later read.
  let closed = false, failed = false, covered = false, readable = false;
  let revision = "unavailable", timer: NodeJS.Timeout | undefined;
  let wanted: Shallow = new Map();
  const shallow = new Map<string, fs.FSWatcher>();
  let recursive: fs.FSWatcher | undefined;
  const notify = (next: string) => { try { bus.emit({ type: "proof.sources_changed", scope: missionsRoot, revision: next }); } catch { /* Quiet refresh remains the repair path. */ } };
  /** A directory at or below `changed` may have been replaced: its watches are dropped, to be reattached by path. */
  const stale = (changed: string) => {
    for (const [dir, watcher] of shallow) if (within(dir, changed)) { watcher.close(); shallow.delete(dir); }
    if (recursive && within(missionsRoot, changed)) { recursive.close(); recursive = undefined; }
  };
  const onEvent = (dir: string | null) => (_event: string, filename: string | Buffer | null) => {
    if (closed) return;
    if (dir !== null) {
      // No filename (null, or none given): anything here may have been replaced, so every watch at or below this
      // directory is rebound by path on the next read (the recursive root too, if it lies below).
      if (filename == null) stale(dir);
      else if (!wanted.get(dir)?.has(filename.toString())) return;
      else stale(path.join(dir, filename.toString()));
    }
    schedule();
  };
  const onError = () => {
    if (closed) return;
    failed = true; covered = false; revision = "unavailable";
    invalidate(); notify("unavailable");
  };
  const watchDir = (dir: string, recursiveWatch: boolean) => {
    try {
      const watcher = fs.watch(dir, { recursive: recursiveWatch, persistent: false }, onEvent(recursiveWatch ? null : dir));
      watcher.on("error", onError);
      return watcher;
    } catch (e) { throw new WatchFailure(`${dir}: ${(e as Error).message}`); }
  };
  /** Attach watches for directories newly needed (the recursive root too, if it was dropped), then release ones no
   *  longer needed (new coverage first). Returns whether anything was attached. */
  const resubscribe = (next: Shallow): boolean => {
    let added = false;
    if (!recursive) { recursive = watchDir(missionsRoot, true); added = true; }
    for (const dir of next.keys()) {
      if (shallow.has(dir)) continue;
      shallow.set(dir, watchDir(dir, false));
      added = true;
    }
    wanted = next;
    for (const [dir, watcher] of shallow) if (!next.has(dir)) { watcher.close(); shallow.delete(dir); }
    return added;
  };
  /** Read the sources and keep the subscriptions in step with what was read, even when the result is unchanged.
   *  Coverage is certified only by a read whose every dependency was already watched before it; if the dependencies
   *  keep moving past a small budget, the sources are reported unobserved rather than read forever. */
  const evaluate = (): string => {
    let read = basis();
    for (let i = 0; ; i++) {
      if (!resubscribe(read.watches)) { covered = true; return read.hash; }
      if (i === 2) { covered = false; return read.hash; }
      read = basis();
    }
  };
  const observed = () => !closed && !failed && covered && readable;
  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      try {
        const next = evaluate();
        readable = true;
        if (next === revision) return;
        revision = next;
        invalidate();
        notify(revision);
      } catch (e) {
        // Never report the sources as watched after a failed read or a watch that could not be attached.
        readable = false;
        if (e instanceof WatchFailure) covered = false;
        revision = "unavailable";
        invalidate();
        notify("unavailable");
      }
    }, 40);
    timer.unref();
  };
  try {
    recursive = watchDir(missionsRoot, true);
    try { revision = evaluate(); readable = true; } catch (e) {
      if (e instanceof WatchFailure) throw e;
      // Direct reads name unavailable inputs; watching may recover them.
      covered = true;
    }
  } catch {
    closed = true;
    recursive?.close();
    for (const watcher of shallow.values()) watcher.close();
    invalidate(); notify("unavailable");
    return { close() {}, observation: () => ({ state: "unavailable", revision }) };
  }
  return {
    observation: () => ({ state: observed() ? "watching" : "unavailable", revision }),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      recursive?.close();
      for (const watcher of shallow.values()) watcher.close();
      shallow.clear();
    },
  };
}
