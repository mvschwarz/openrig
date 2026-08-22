// Crash-cart C3 — the REAL probe adapters wired into resolveDaemonState (main.ts). The classification
// logic is unit-tested (injected fetch); isProcessAlive/readDaemonJson are thin node-API wrappers
// proven by the real-daemon-down run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStateFile, HealthzProbeResult } from "./crash-cart-detect.js";

/** Collect every `code`/`name` across a rejection's cause chain. Node/Undici's global fetch rejects a
 *  refused TCP connection with an OUTER `TypeError {message:"fetch failed", code:undefined}` and the real
 *  `ECONNREFUSED` nested in `cause` (and, for a host that resolves to several addresses, an
 *  `AggregateError` whose `.errors[]` each carry the code). Checking only the outer error misses it — so
 *  a provably-down daemon read as "timeout" → "unverified" → no cockpit. We walk the chain to see it. */
function collectErrorSignals(err: unknown): { codes: Set<string>; names: Set<string> } {
  const codes = new Set<string>();
  const names = new Set<string>();
  const visit = (e: unknown, depth: number): void => {
    if (!e || typeof e !== "object" || depth > 5) return;
    const o = e as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof o.code === "string") codes.add(o.code);
    if (typeof o.name === "string") names.add(o.name);
    if (o.cause) visit(o.cause, depth + 1);
    if (Array.isArray(o.errors)) for (const sub of o.errors) visit(sub, depth + 1);
  };
  visit(err, 0);
  return { codes, names };
}

/** Classify a fetch REJECTION into a probe result. ECONNREFUSED ANYWHERE in the cause chain = the strong
 *  DOWN signal (the daemon socket refused). Abort/connect-timeout = unverified; anything else = timeout
 *  (conservative — never a fabricated down). Handles both a raw `{code}` and the wrapped Undici shape. */
export function classifyProbeError(err: unknown): HealthzProbeResult {
  const { codes, names } = collectErrorSignals(err);
  // DOWN (refused) requires UNAMBIGUOUS refusal: ECONNREFUSED on the terminal attempts with NO
  // non-refused sibling (no timeout/abort/unknown code alongside it). A mixed multi-address
  // AggregateError — e.g. ECONNREFUSED on one address + ETIMEDOUT on another — is AMBIGUOUS evidence, so
  // it stays timeout/unverified: a timeout NEVER promotes to a confirmed down (the detector contract), and
  // the cart must not offer RESTORE EVERYTHING on partial evidence. (Refusal no longer wins by precedence.)
  const nonRefusedSibling = names.has("AbortError") || [...codes].some((c) => c !== "ECONNREFUSED");
  if (codes.has("ECONNREFUSED") && !nonRefusedSibling) return "refused";
  if (names.has("AbortError") || codes.has("ETIMEDOUT") || codes.has("UND_ERR_CONNECT_TIMEOUT")) return "timeout";
  return "timeout";
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
