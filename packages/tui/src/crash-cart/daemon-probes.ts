// Crash-cart C3 — the REAL probe adapters wired into resolveDaemonState (main.ts). The classification
// logic is unit-tested (injected fetch); isProcessAlive/readDaemonJson are thin node-API wrappers
// proven by the real-daemon-down run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStateFile, HealthzProbeResult } from "./daemon-state.js";

/** Classify a fetch REJECTION into a probe result. ECONNREFUSED = the only strong down signal; an
 *  abort/timeout = unverified; anything else = timeout (conservative — never a fabricated down). */
export function classifyProbeError(err: { code?: string; name?: string }): HealthzProbeResult {
  if (err.code === "ECONNREFUSED") return "refused";
  if (err.name === "AbortError" || err.code === "ETIMEDOUT" || err.code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
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
