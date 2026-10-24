import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import type { ScopeFsDeps } from "../scope/scope-view-projection.js";
import { createProofPolicyRead, proofFs, readProjectReadiness } from "./judgments.js";

export interface ProofSourceWatch {
  close(): void;
  observation(): { state: "watching" | "unavailable"; revision: string };
}
export function proofSourceObservation(c: { get: (key: never) => unknown }) {
  return (c.get("proofSourceWatch" as never) as ProofSourceWatch | undefined)?.observation() ?? { state: "unavailable", revision: "unverified" };
}

/** A needed watch could not be attached: the sources are not observed (distinct from an input that can't be read). */
class WatchFailure extends Error {}

/** Per directory outside the missions root, the entry names a readiness evaluation read there. */
type Shallow = Map<string, Set<string>>;

/** Where each path the evaluation read outside the missions root is observed: its parent, shallow, filtered to its
 *  name; for a missing parent, the nearest existing ancestor, filtered to the next segment toward it. */
function shallowWatches(missionsRoot: string, read: Iterable<string>): Shallow {
  const out: Shallow = new Map();
  for (const file of read) {
    const target = path.resolve(file);
    if (target === missionsRoot || target.startsWith(missionsRoot + path.sep)) continue;
    let child = target, dir = path.dirname(target);
    while (dir !== child && !proofFs.exists(dir)) { child = dir; dir = path.dirname(dir); }
    if (dir === child) continue;
    const names = out.get(dir) ?? new Set<string>();
    names.add(path.basename(child));
    out.set(dir, names);
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
    return { hash, watches: shallowWatches(missionsRoot, read) };
  };
  let closed = false, covered = false, readable = false;
  let revision = "unavailable", timer: NodeJS.Timeout | undefined;
  let wanted: Shallow = new Map();
  const shallow = new Map<string, fs.FSWatcher>();
  let recursive: fs.FSWatcher | undefined;
  const notify = (next: string) => { try { bus.emit({ type: "proof.sources_changed", scope: missionsRoot, revision: next }); } catch { /* Quiet refresh remains the repair path. */ } };
  const onEvent = (dir: string | null) => (_event: string, filename: string | Buffer | null) => {
    if (closed) return;
    // No filename (null, or none given) means "something here changed": re-read rather than guess.
    if (dir !== null && filename != null && !wanted.get(dir)?.has(filename.toString())) return;
    schedule();
  };
  const onError = () => {
    if (closed) return;
    covered = false; revision = "unavailable";
    invalidate(); notify("unavailable");
  };
  /** Attach watches for directories newly needed, then release ones no longer needed (new coverage first).
   *  Returns whether any were added. */
  const resubscribe = (next: Shallow): boolean => {
    let added = false;
    for (const dir of next.keys()) {
      if (shallow.has(dir)) continue;
      let watcher: fs.FSWatcher;
      try { watcher = fs.watch(dir, { recursive: false, persistent: false }, onEvent(dir)); }
      catch (e) { throw new WatchFailure(`${dir}: ${(e as Error).message}`); }
      watcher.on("error", onError);
      shallow.set(dir, watcher);
      added = true;
    }
    wanted = next;
    for (const [dir, watcher] of shallow) if (!next.has(dir)) { watcher.close(); shallow.delete(dir); }
    return added;
  };
  /** Read the sources and keep the subscriptions in step with what was read, even when the result is unchanged.
   *  After attaching new watches it reads again, so a change between the read and the watch is not missed. */
  const evaluate = (): string => {
    let read = basis();
    for (let i = 0; i < 2 && resubscribe(read.watches); i++) read = basis();
    covered = true;
    return read.hash;
  };
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
    recursive = fs.watch(missionsRoot, { recursive: true, persistent: false }, onEvent(null));
    recursive.on("error", onError);
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
    observation: () => ({ state: !closed && covered && readable ? "watching" : "unavailable", revision }),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      recursive?.close();
      for (const watcher of shallow.values()) watcher.close();
      shallow.clear();
    },
  };
}
