// Crash-cart C3 — the REAL probe adapters wired into resolveDaemonState (main.ts). The classification
// logic is unit-tested (injected fetch); isProcessAlive/readDaemonJson are thin node-API wrappers
// proven by the real-daemon-down run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStateFile, HealthzProbeResult } from "./crash-cart-detect.js";

/** Collect the TERMINAL ATTEMPTS from a rejection tree — the leaf error nodes that represent an actual
 *  connect attempt. Node/Undici's global fetch wraps a refused socket as an OUTER `TypeError
 *  {message:"fetch failed", code:undefined}` → `cause` (single address), or an `AggregateError` whose
 *  `.errors[]` are the per-address attempts. A node WITH a `cause` or non-empty `errors[]` is a WRAPPER
 *  (it recurses, never counts as a terminal attempt); a node with neither is a terminal attempt — which
 *  may carry a `code` (ECONNREFUSED/ETIMEDOUT/…) or NONE at all. A code-less attempt is retained here,
 *  which a flattened code-Set would erase. Depth-bounded (cycle-safe); a node hit at the cap is treated
 *  as a terminal attempt (its code, typically absent, then counts — conservatively). */
const MAX_WALK_DEPTH = 10; // real Undici chains are 2–3 deep; this is generous. Beyond it = UNRESOLVED.

function collectTerminalAttempts(err: unknown): Array<{ code?: string; name?: string; unresolved?: boolean }> {
  const attempts: Array<{ code?: string; name?: string; unresolved?: boolean }> = [];
  const onPath = new Set<object>(); // cycle detection by IDENTITY (a back-edge cannot be resolved)
  const visit = (e: unknown, depth: number): void => {
    // A non-object rejection (string/undefined/…) is not a resolvable terminal → unknown (non-refused).
    if (!e || typeof e !== "object") {
      attempts.push({ unresolved: true });
      return;
    }
    const o = e as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    // CYCLE: this exact object is already on the current path — it cannot be fully resolved → unknown.
    if (onPath.has(o)) {
      attempts.push({ unresolved: true });
      return;
    }
    const children: unknown[] = [];
    if (o.cause) children.push(o.cause);
    if (Array.isArray(o.errors)) children.push(...(o.errors as unknown[]));
    if (children.length === 0) {
      // A FULLY-RESOLVED terminal attempt (no cause, no errors): its own code is real evidence.
      attempts.push({ code: typeof o.code === "string" ? o.code : undefined, name: typeof o.name === "string" ? o.name : undefined });
      return;
    }
    // A WRAPPER (has children). If depth is exhausted, we CANNOT resolve it → record an UNKNOWN attempt;
    // NEVER reinterpret an unresolved wrapper's OWN code as terminal evidence (exhaustion is not evidence).
    if (depth >= MAX_WALK_DEPTH) {
      attempts.push({ unresolved: true });
      return;
    }
    onPath.add(o);
    for (const c of children) visit(c, depth + 1);
    onPath.delete(o);
  };
  visit(err, 0);
  return attempts;
}

/** Classify a fetch REJECTION into a probe result — POSITIVE-FORM predicate (guard/orch rail):
 *  DOWN (refused) ONLY when (a) at least one terminal attempt exists AND (b) EVERY terminal attempt is
 *  recognizably ECONNREFUSED. Anything else — a timeout, an abort, another code, or a CODE-LESS /
 *  unrecognized failure — is ambiguous evidence and stays timeout/unverified (a timeout never promotes to
 *  a confirmed down; the cart never offers RESTORE on partial evidence). "No known-bad sibling" (a negated
 *  code-Set) erased a code-less sibling; "ALL known-good" (this positive form) closes the whole family. */
export function classifyProbeError(err: unknown): HealthzProbeResult {
  const attempts = collectTerminalAttempts(err);
  const refusedUnanimous = attempts.length > 0 && attempts.every((a) => a.code === "ECONNREFUSED");
  return refusedUnanimous ? "refused" : "timeout";
}

export interface ProbeDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  timeoutMs?: number;
}

/** Probe `<url>` (a daemon /healthz): 2xx → answered; non-2xx (foreign occupant) → not-openrig; a
 *  rejection is classified (refused/timeout). Bounded by an abort timeout. */
export async function probeHealthz(url: string, deps: ProbeDeps): Promise<HealthzProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 800);
  try {
    const res = await deps.fetch(url, { signal: controller.signal });
    return res.ok ? "answered" : "not-openrig";
  } catch (e) {
    return classifyProbeError((e ?? {}) as { code?: string; name?: string });
  } finally {
    clearTimeout(timer);
  }
}

/** True if `pid` is a live process. `process.kill(pid, 0)` throws ESRCH when absent, EPERM when it
 *  exists but we can't signal it (still alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read + parse `$OPENRIG_HOME/daemon.json` → the {pid,port,host} record, or undefined if absent or
 *  malformed (treated as "no state file"). */
export function readDaemonJson(openrigHome: string): DaemonStateFile | undefined {
  const p = join(openrigHome, "daemon.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown; port?: unknown; host?: unknown };
    if (typeof j.pid === "number" && typeof j.port === "number") {
      return { pid: j.pid, port: j.port, host: typeof j.host === "string" ? j.host : undefined };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
