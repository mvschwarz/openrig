import { Command } from "commander";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getOpenRigHome, readOpenRigUrl } from "../openrig-compat.js";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";
import { formatDaemonHostForUrl } from "../client.js";
import { resolveConfiguredDaemonTarget } from "../daemon-lifecycle.js";
import { observeStartReservation } from "../daemon-start-lock.js";
import { createProcessLiveness, signalProbe, readProcessState } from "../process-liveness.js";
import type { DaemonUnverifiedEvidence } from "@openrig/daemon/crash-cart";

// `rig crash-cart --json` — the daemon-DOWN recovery verdict emit (plan c015d9ed §C3, coupling ruling
// option A). Prints ONE JSON = the 3-state detector verdict + (on DOWN) the discovery — READ-ONLY, a
// public agent-readable surface (the 4 rails). A fail-closed refusal still prints STRUCTURED JSON
// (never exit-code-only). The `emit` is injected: the real wiring imports emitCrashCartState from the
// scoped @openrig/daemon/crash-cart subpath (reuse VERBATIM) — set up alongside this command.
//
// SCOPE FENCE (plan R10 / Boundaries): "no new CLI verb v1; bare `rig` is the cart." There are NO
// `restore-fleet` / `cancel-fleet` public verbs — the TUI drives the conductor through the daemon client
// directly against the R2-sanctioned daemon-side batch route. This command emits the read-only verdict only.

export type DaemonState = "up" | "down" | "unverified";

export interface CrashCartEmit {
  state: DaemonState;
  evidence?: { pidState: string; probeResult: string; failedSignal: string };
  discovery?: unknown;
  refusal?: string;
}

export interface CrashCartCommandDeps {
  /** Produce the verdict (the real wiring: emitCrashCartState with live probes + the C2 read). */
  emit: () => Promise<CrashCartEmit>;
  /** Emit one line (default: stdout). */
  write: (line: string) => void;
}

/** Read daemon.json returning the FULL record incl. `db` (loadCrashCartDiscovery needs the db path;
 *  the detector's readDaemonJson omits it). */
function readDaemonJsonWithDb(home: string): { pid: number; port: number; host?: string; db: string } | undefined {
  const p = join(home, "daemon.json");
  if (!existsOrThrow(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown; port?: unknown; host?: unknown; db?: unknown };
    if (typeof j.pid === "number" && typeof j.port === "number" && typeof j.db === "string") {
      return { pid: j.pid, port: j.port, host: typeof j.host === "string" ? j.host : undefined, db: j.db };
    }
    throw new Error("daemon.json has no usable PID, port and database path");
  } catch (error) {
    throw new Error(`Cannot read recorded daemon state at ${p}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Only ENOENT means absent; permissions and dangling links must fail visibly. */
function existsOrThrow(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** The evidence probe's URL: OPENRIG_URL with one trailing slash trimmed, as the detector trims it, else daemon.json's
 *  host and port. The shared reader leaves a query or fragment URL as written, so the trim stays here. */
export function crashCartEvidenceUrl(openrigUrl: string | undefined, state: { host?: string; port: number } | undefined): string {
  return openrigUrl
    ? `${openrigUrl.replace(/\/$/, "")}/healthz`
    : `http://${formatDaemonHostForUrl(state?.host ?? "127.0.0.1")}:${state?.port ?? 7433}/healthz`;
}

/** Only an endpoint match lets local process evidence describe an explicit target. A URL path,
 * query or different port is not this home's listener. Loopback spellings name the same host. */
function matchesTarget(url: string, endpoint: { host?: string; port: number }): boolean {
  try {
    const selected = new URL(url);
    const local = new URL(`http://${formatDaemonHostForUrl(endpoint.host ?? "127.0.0.1")}:${endpoint.port}`);
    const host = (value: string) => value.toLowerCase().replace(/^\[|\]$/g, "");
    const selectedHost = host(selected.hostname);
    const localHost = host(local.hostname);
    const loopback = (h: string) => h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
    const sameHost = selectedHost === localHost
      || (selectedHost === "localhost" && loopback(localHost))
      || (localHost === "localhost" && loopback(selectedHost))
      || (localHost === "0.0.0.0" && (selectedHost === "localhost" || /^127\./.test(selectedHost)))
      // The daemon uses a dual-stack wildcard bind, which also accepts IPv4 loopback.
      || (localHost === "::" && (selectedHost === "localhost" || loopback(selectedHost)));
    return selected.protocol === local.protocol && selected.port === local.port
      && selected.pathname === "/" && !selected.search && !selected.hash
      && sameHost;
  } catch { return false; }
}

/**
 * The real verdict: LAZY-imports the narrow @openrig/daemon/crash-cart subpath at invocation (dep
 * rail 2 — rig startup + other verbs never load the daemon module) and composes the shipped detector
 * + C2 read VERBATIM (rail 2) with live probes + read-only IO. This is real-run glue over the tested
 * emit/detector/read cores.
 */
async function realEmit(): Promise<CrashCartEmit> {
  const cc = await import("@openrig/daemon/crash-cart");
  const home = getOpenRigHome();
  const explicitUrl = readOpenRigUrl();
  const processLiveness = createProcessLiveness({ signal: signalProbe, readProcessState });
  const readReservation = () => observeStartReservation({
    home,
    readFile: (file) => existsOrThrow(file) ? readFileSync(file, "utf8") : null,
    processLiveness,
  });
  const configured = resolveConfiguredDaemonTarget();
  const recorded = cc.readDaemonJson(home);
  const reservation = readReservation();
  const localEndpoint = recorded ?? configured;
  const selectedEndpoint = reservation && reservation.liveness !== "dead" && reservation.port
    ? { host: reservation.host ?? configured.host, port: reservation.port } : localEndpoint;
  // Resolve once. Verdict retries, evidence and discovery all address this target even if files change.
  const openrigUrl = explicitUrl ?? `http://${formatDaemonHostForUrl(selectedEndpoint.host ?? "127.0.0.1")}:${selectedEndpoint.port}`;
  let lastEvidence: DaemonUnverifiedEvidence;
  const readProcessEvidence = (state: { pid: number; host?: string; port: number } | undefined) => {
    const pending = readReservation();
    const pendingEndpoint = pending?.port
      ? { host: pending.host ?? configured.host, port: pending.port } : localEndpoint;
    if (pending && pending.liveness !== "dead" && matchesTarget(openrigUrl, pendingEndpoint)) {
      return { mayBeRunning: true, pidState: `start pending (${pending.liveness}${pending.pid === undefined ? "" : `, pid ${pending.pid}`}${pending.since ? `, since ${pending.since}` : ""})` };
    }
    if (state && matchesTarget(openrigUrl, state)) {
      const liveness = processLiveness(state.pid);
      return { mayBeRunning: liveness !== "dead", pidState: `${liveness} (pid ${state.pid})` };
    }
    return { mayBeRunning: false, pidState: explicitUrl
      ? "explicit target; no matching local daemon record or startup reservation"
      : "no matching daemon.json or live startup reservation" };
  };
  const probeClassified = (url: string) =>
    cc.probeHealthz(url, { fetch: (u, init) => fetch(u, init as RequestInit), timeoutMs: 700 });
  const detectDeps = {
    openrigHome: home,
    readDaemonJson: cc.readDaemonJson,
    isProcessAlive: (pid: number) => processLiveness(pid) !== "dead",
    probeHealthz: probeClassified,
    openrigUrl,
    readProcessEvidence,
    onEvidence: (evidence: DaemonUnverifiedEvidence) => { lastEvidence = evidence; },
  };
  return cc.emitCrashCartState({
    resolveState: () =>
      cc.resolveDaemonState({ ...detectDeps, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), maxProbes: 3, retryDelayMs: 400 }),
    assembleEvidence: async () => lastEvidence,
    loadDiscovery: async () => {
      const { discovery } = await cc.loadCrashCartDiscovery({
        ...detectDeps,
        readDaemonJson: readDaemonJsonWithDb,
        copyFile: copyFileSync,
        exists: existsOrThrow,
        configuredDbPath: new ConfigStore().resolve().db.path,
        makeScratchDir: () => mkdtempSync(join(tmpdir(), "crash-cart-")),
        removeScratchDir: (d) => rmSync(d, { recursive: true, force: true }),
        openDb: cc.openDaemonDbReadonly,
      });
      return discovery;
    },
  });
}

export function crashCartCommand(deps?: Partial<CrashCartCommandDeps>): Command {
  const cmd = new Command("crash-cart").description(
    "Emit the daemon-down recovery verdict + discovery as JSON (read-only).",
  );
  cmd.option("--json", "emit JSON (the default machine-readable form)");
  cmd.action(async () => {
    const emit = deps?.emit ?? realEmit;
    const write = deps?.write ?? ((line: string) => process.stdout.write(line + "\n"));
    const result = await emit();
    // Rail 3: the JSON is the truth (verdict + discovery, or a structured refusal). Always printed.
    write(JSON.stringify(result));
    // A non-zero exit is a HINT only (not-cleanly-up); the JSON remains the contract.
    process.exitCode = result.state === "up" ? 0 : 1;
  });

  return cmd;
}
