import { Command } from "commander";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

function openrigHome(): string {
  return process.env.OPENRIG_HOME ?? join(homedir(), ".openrig");
}

/** Read daemon.json returning the FULL record incl. `db` (loadCrashCartDiscovery needs the db path;
 *  the detector's readDaemonJson omits it). */
function readDaemonJsonWithDb(home: string): { pid: number; port: number; host?: string; db: string } | undefined {
  const p = join(home, "daemon.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown; port?: unknown; host?: unknown; db?: unknown };
    if (typeof j.pid === "number" && typeof j.port === "number" && typeof j.db === "string") {
      return { pid: j.pid, port: j.port, host: typeof j.host === "string" ? j.host : undefined, db: j.db };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real verdict: LAZY-imports the narrow @openrig/daemon/crash-cart subpath at invocation (dep
 * rail 2 — rig startup + other verbs never load the daemon module) and composes the shipped detector
 * + C2 read VERBATIM (rail 2) with live probes + read-only IO. This is real-run glue over the tested
 * emit/detector/read cores.
 */
async function realEmit(): Promise<CrashCartEmit> {
  const cc = await import("@openrig/daemon/crash-cart");
  const home = openrigHome();
  const openrigUrl = process.env.OPENRIG_URL;
  const probeClassified = (url: string) =>
    cc.probeHealthz(url, { fetch: (u, init) => fetch(u, init as RequestInit), timeoutMs: 700 });
  const detectDeps = {
    openrigHome: home,
    readDaemonJson: cc.readDaemonJson,
    isProcessAlive: cc.isProcessAlive,
    probeHealthz: probeClassified,
    openrigUrl,
  };
  return cc.emitCrashCartState({
    resolveState: () =>
      cc.resolveDaemonState({ ...detectDeps, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), maxProbes: 3, retryDelayMs: 400 }),
    assembleEvidence: async () => {
      const state = cc.readDaemonJson(home);
      const pidState = state
        ? cc.isProcessAlive(state.pid)
          ? `alive (pid ${state.pid})`
          : `dead (pid ${state.pid})`
        : "no daemon.json";
      const url = openrigUrl
        ? `${openrigUrl.replace(/\/$/, "")}/healthz`
        : `http://${state?.host ?? "127.0.0.1"}:${state?.port ?? 7433}/healthz`;
      const probeResult = await probeClassified(url);
      return { pidState, probeResult, failedSignal: `healthz ${probeResult} at ${url}` };
    },
    loadDiscovery: async () => {
      const { discovery } = await cc.loadCrashCartDiscovery({
        openrigHome: home,
        readDaemonJson: readDaemonJsonWithDb,
        isProcessAlive: cc.isProcessAlive,
        probeHealthz: (url) => probeClassified(url).then((r) => r === "answered"),
        copyFile: copyFileSync,
        exists: existsSync,
        makeScratchDir: () => mkdtempSync(join(tmpdir(), "crash-cart-")),
        removeScratchDir: (d) => rmSync(d, { recursive: true, force: true }),
        openDb: cc.openDaemonDbReadonly,
        openrigUrl,
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
