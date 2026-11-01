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

/** The real location of `p`, resolving its nearest existing ancestor (as containment does), or null if unreadable. */
function canonical(p: string): string | null {
  try {
    let existing = path.resolve(p);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    return path.resolve(fs.realpathSync(existing), path.relative(existing, path.resolve(p)));
  } catch { return null; }
}

/** Where each path the evaluation read outside the missions root is observed: its parent, shallow, filtered to its
 *  name (for a missing parent, the nearest existing ancestor, filtered to the next segment toward it). A directory
 *  whose real location leaves the project is never watched: the nearest ancestor that stays inside is, filtered to
 *  the next segment. Every watched directory, the missions root included (under its configured and its real name),
 *  is also anchored at each ancestor up to
 *  `top`, filtered to the next segment, so a replaced or re-pointed directory on the way is seen and its watch rebound. */
function shallowWatches(missionsRoot: string, realRoot: string, top: string, project: string, read: Iterable<string>): Shallow {
  const out: Shallow = new Map();
  const inside = (dir: string) => { const real = canonical(dir); return real !== null && within(real, project); };
  // The project may be reached by an alias: real-location paths are bounded by the real project's parent.
  const realTop = path.dirname(project);
  const topOf = (p: string) => (within(p, top) ? top : within(p, realTop) ? realTop : null);
  for (const file of read) {
    const target = path.resolve(file);
    if (within(target, missionsRoot) || within(target, realRoot)) continue;
    let child = target, dir = path.dirname(target);
    while (dir !== child && !proofFs.exists(dir)) { child = dir; dir = path.dirname(dir); }
    const bound = topOf(dir);
    if (bound === null) continue;
    while (dir !== child && dir !== bound && !inside(dir)) { child = dir; dir = path.dirname(dir); }
    if (dir === child || dir === bound) continue;
    add(out, dir, path.basename(child));
  }
  // The missions root is anchored under both its names: a replaced real root must rebind the recursive watch too.
  for (const watched of [...out.keys(), missionsRoot, realRoot]) {
    const bound = topOf(watched);
    if (bound === null) continue;
    for (let p = watched; p !== bound && within(p, bound); p = path.dirname(p)) {
      const parent = path.dirname(p);
      if (parent === bound || inside(parent)) add(out, parent, path.basename(p));
    }
  }
  return out;
}

/**
 * Push invalidation over the existing bus; existing client quiet refresh is the missed-event repair.
 * The missions root is watched recursively. Anything else the readiness evaluation reads (project and policy files,
 * including absent nearer ones, and accepted evidence elsewhere in the project) is watched at its parent directory,
 * not recursively, so sibling checkouts and build trees are never subscribed to.
 */
export function watchProofSources(missionsRoot: string, invalidate: () => void, bus: EventBus, scopeChanged?: () => void): ProofSourceWatch {
  missionsRoot = path.resolve(missionsRoot);
  let projectRoot = path.dirname(missionsRoot);
  try { projectRoot = resolveProjectRoot(missionsRoot) ?? projectRoot; } catch { /* Legacy roots keep the missions root's parent. */ }
  const top = path.dirname(path.resolve(projectRoot));
  // The authority boundary in real terms: what the readers' containment check accepts.
  const project = canonical(projectRoot) ?? path.resolve(projectRoot);
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
    const hash = createHash("sha256").update(JSON.stringify(readProjectReadiness(missionsRoot, createProofPolicyRead(), undefined, io, note).missions.map(m => [m.name, m.revision]))).digest("hex");
    // A file read through a link inside the project depends on its real location too: observe both.
    for (const file of [...read]) {
      const real = canonical(file);
      if (real !== null && real !== path.resolve(file) && within(real, project)) read.add(real);
    }
    return { hash, watches: shallowWatches(missionsRoot, canonical(missionsRoot) ?? missionsRoot, top, project, read) };
  };
  // failed latches for this instance: a watcher that errored is not trusted to be replaced by a later read.
  let closed = false, failed = false, covered = false, readable = false;
  let revision = "unavailable", timer: NodeJS.Timeout | undefined;
  let scopeDirty = false;
  const notifyScope = () => { try { scopeChanged?.(); } catch { /* A later event or explicit refresh retries the view read. */ } };
  let wanted: Shallow = new Map();
  const shallow = new Map<string, fs.FSWatcher>();
  let recursive: fs.FSWatcher | undefined;
  // The real location the recursive watch was attached at (it follows a linked root to that directory); null if
  // it could not be established.
  let recursiveReal: string | null = null;
  const notify = (next: string) => { try { bus.emit({ type: "proof.sources_changed", scope: missionsRoot, revision: next }); } catch { /* Quiet refresh remains the repair path. */ } };
  /** A directory at or below `changed` may have been replaced: its watches are dropped, to be reattached by path. */
  const stale = (changed: string) => {
    for (const [dir, watcher] of shallow) if (within(dir, changed)) { watcher.close(); shallow.delete(dir); }
    if (recursive && (within(missionsRoot, changed) || (recursiveReal !== null && within(recursiveReal, changed)))) { recursive.close(); recursive = undefined; }
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
    if (filename == null || _event === "rename" || /(?:^|[\\/])(?:SPEC\.md|README\.md|mission\.yaml)$/.test(filename.toString())) scopeDirty = true;
    schedule();
  };
  const onError = () => {
    if (closed) return;
    failed = true; covered = false; revision = "unavailable";
    invalidate(); notify("unavailable"); notifyScope();
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
    const real = canonical(missionsRoot);
    if (recursive && real !== recursiveReal) { recursive.close(); recursive = undefined; }
    if (!recursive) { recursive = watchDir(missionsRoot, true); recursiveReal = real; added = true; }
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
      // A root whose real location is unknown or outside the project has no anchors there: never certified.
      if (!resubscribe(read.watches)) { covered = recursiveReal !== null && within(recursiveReal, project); return read.hash; }
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
        if (scopeDirty) { scopeDirty = false; notifyScope(); }
        const before = observed();
        const next = evaluate();
        readable = true;
        // Deduplicate on what clients see: the revision and whether the sources are observed. Losing or regaining
        // coverage is news even when the proof result itself did not change.
        if (next === revision && observed() === before) return;
        revision = next;
        invalidate();
        notify(observed() ? revision : "unavailable");
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
    recursiveReal = canonical(missionsRoot);
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
    invalidate(); notify("unavailable"); notifyScope();
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
