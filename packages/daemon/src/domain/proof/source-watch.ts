import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import { readProjectReadiness, resolveProjectRoot } from "./judgments.js";

export interface ProofSourceWatch {
  close(): void;
  observation(): { state: "watching" | "unavailable"; revision: string };
}
export function proofSourceObservation(c: { get: (key: never) => unknown }) {
  return (c.get("proofSourceWatch" as never) as ProofSourceWatch | undefined)?.observation() ?? { state: "unavailable", revision: "unverified" };
}

/** Push invalidation over the existing bus; existing client quiet refresh is the missed-event repair. */
export function watchProofSources(missionsRoot: string, invalidate: () => void, bus: EventBus): ProofSourceWatch {
  const workspace = path.dirname(missionsRoot);
  let projectRoot = workspace;
  try { projectRoot = resolveProjectRoot(missionsRoot); } catch { /* Legacy roots retain their existing watch boundary. */ }
  // ponytail: bounded local workspaces use a full semantic read after a file burst.
  // Keep this workload measured; subtree indexing is warranted only when that bound is exceeded.
  const basis = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(missionsRoot).missions.map(m => [m.name, m.revision]))).digest("hex");
  let state: "watching" | "unavailable" = "unavailable";
  let revision = "unavailable", timer: NodeJS.Timeout | undefined;
  try { revision = basis(); state = "watching"; } catch { /* Direct reads name unavailable inputs; watching may recover them. */ }
  const notify = (next: string) => { try { bus.emit({ type: "proof.sources_changed", scope: missionsRoot, revision: next }); } catch { /* Quiet refresh remains the repair path. */ } };
  const watchers: fs.FSWatcher[] = [];
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        const next = basis();
        if (next === revision) return;
        revision = next; state = "watching";
        invalidate();
        notify(revision);
      } catch {
        state = "unavailable"; revision = "unavailable";
        invalidate();
        notify("unavailable");
      }
    }, 40);
    timer.unref();
  };
  try {
    watchers.push(fs.watch(workspace, { recursive: true, persistent: false }, schedule));
    if (projectRoot !== workspace) {
      watchers.push(fs.watch(projectRoot, { recursive: false, persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === "project.yaml") schedule();
      }));
    }
  } catch {
    for (const watcher of watchers) watcher.close();
    if (timer) clearTimeout(timer);
    invalidate(); notify("unavailable");
    return { close() {}, observation: () => ({ state: "unavailable", revision }) };
  }
  for (const watcher of watchers) watcher.on("error", () => { state = "unavailable"; revision = "unavailable"; invalidate(); notify("unavailable"); });
  return { observation: () => ({ state, revision }), close: () => { state = "unavailable"; if (timer) clearTimeout(timer); for (const watcher of watchers) watcher.close(); } };
}
