import { Command } from "commander";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

/** The `POST /api/crash-cart/restore-fleet` on-commit response — the fleet-attempt handle
 *  (the restore runs in the daemon BACKGROUND; the CLI polls the status endpoint below). */
interface FleetKickResponse {
  fleetAttemptId: string;
  status: string;
}

/** The `GET /api/crash-cart/restore-fleet/:id` status — progress + the FleetRollup + verdict,
 *  updated as rigs complete. The CLI polls this until `done` (never treats the kick as the result). */
interface FleetStatusResponse {
  done: boolean;
  cancelled: boolean;
  rollup: {
    counts: Record<string, number>;
    sequence: Array<{ rigId: string; outcome: string; receiptRef?: number }>;
    attention_required: Array<{ rigId: string; seat: string; need: string }>;
  };
  verdict: string;
}

// `rig crash-cart --json` — the daemon-DOWN recovery verdict emit (plan c015d9ed §C3, coupling ruling
// option A). Prints ONE JSON = the 3-state detector verdict + (on DOWN) the discovery — READ-ONLY, a
// public agent-readable surface (the 4 rails). A fail-closed refusal still prints STRUCTURED JSON
// (never exit-code-only). The `emit` is injected: the real wiring imports emitCrashCartState from the
// scoped @openrig/daemon/crash-cart subpath (reuse VERBATIM) — set up alongside this command.
//
// NOTE: this CLI-local CrashCartEmit is the documented parse/print contract; it matches the daemon's
// emit shape (the JSON contract). When the subpath export lands, the real emit is wired as the default.

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
  /** For `restore-fleet`: acquire the daemon client (default: status → guard → DaemonClient);
   *  injectable so the conductor call is testable without a live daemon. */
  getRestoreClient?: (opts: { json?: boolean }) => Promise<DaemonClient | null>;
  lifecycleDeps?: LifecycleDeps;
  clientFactory?: (url: string) => DaemonClient;
  /** Poll delay between status reads (default 500ms); injected as a no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
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

  // Acquire the daemon client for the fleet verbs (status → guard → DaemonClient), injectable in tests.
  const acquireClient = async (json: boolean): Promise<DaemonClient | null> =>
    deps?.getRestoreClient
      ? deps.getRestoreClient({ json })
      : await (async () => {
          const lifecycleDeps = deps?.lifecycleDeps ?? realDeps();
          const status = await getDaemonStatus(lifecycleDeps);
          if (!daemonStatusGuard(status, { json })) return null;
          const factory = deps?.clientFactory ?? ((url: string) => new DaemonClient(url));
          return factory(getDaemonUrl(status));
        })();

  // `rig crash-cart restore-fleet [--json]` — drive the daemon-side conductor (Atom B):
  // POST /api/crash-cart/restore-fleet → the FleetRollup + derived verdict. Requires the
  // daemon UP (the ⏎ flow's `s` step runs first); fail-closed if not.
  cmd
    .command("restore-fleet")
    .description("Restore every rig on this host kernel-first — the crash-cart conductor.")
    .option("--json", "emit the FleetRollup + verdict as JSON")
    .action(async (_opts: { json?: boolean }, command: Command) => {
      // --json can be parsed as the parent's global option (crash-cart also declares it),
      // so read the merged view.
      const json = (command.optsWithGlobals() as { json?: boolean }).json === true;
      const write = deps?.write ?? ((line: string) => process.stdout.write(line + "\n"));
      const client = await acquireClient(json);
      if (!client) {
        process.exitCode = 1;
        return;
      }
      const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const POLL_INTERVAL_MS = 500;
      const MAX_POLLS = 1200; // ~10 min ceiling; on exhaustion the restore keeps running (re-poll by id)
      try {
        // Kick the async verb — the daemon answers on-commit with a fleet-attempt handle
        // and restores in the background. A single bounded POST would time out on a real
        // seconds-per-seat fleet restore and discard the rollup; we POLL to completion.
        const kick = await client.post<FleetKickResponse>("/api/crash-cart/restore-fleet");
        if (kick.status >= 400) {
          const err = (kick.data as { error?: string })?.error ?? `HTTP ${kick.status}`;
          write(json ? JSON.stringify({ error: err }) : `Fleet restore failed: ${err}`);
          process.exitCode = 1;
          return;
        }
        const fleetAttemptId = kick.data?.fleetAttemptId;
        if (!fleetAttemptId) {
          write(json ? JSON.stringify({ error: "no fleetAttemptId" }) : "Fleet restore failed: no fleet-attempt id returned");
          process.exitCode = 1;
          return;
        }
        // Surface the attempt id so a user can cancel from another terminal (the operator lifecycle).
        if (!json) write(`Fleet restore started (attempt ${fleetAttemptId}) — 'rig crash-cart cancel-fleet ${fleetAttemptId}' to stop.`);

        let final: FleetStatusResponse | undefined;
        for (let i = 0; i < MAX_POLLS; i++) {
          const status = await client.get<FleetStatusResponse>(`/api/crash-cart/restore-fleet/${fleetAttemptId}`);
          if (status.status >= 400) {
            const err = (status.data as { error?: string })?.error ?? `HTTP ${status.status}`;
            write(json ? JSON.stringify({ error: err }) : `Fleet restore failed: ${err}`);
            process.exitCode = 1;
            return;
          }
          if (status.data?.done) {
            final = status.data;
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }
        if (!final) {
          // Still running past the ceiling — honest, never a false verdict. The restore
          // continues in the daemon; the operator can re-poll by id.
          write(
            json
              ? JSON.stringify({ error: "still running", fleetAttemptId })
              : `Fleet restore still running (attempt ${fleetAttemptId}) — poll again shortly.`,
          );
          process.exitCode = 1;
          return;
        }

        if (json) {
          write(JSON.stringify({ rollup: final.rollup, verdict: final.verdict }));
          return;
        }
        const { rollup, verdict } = final;
        write(`Fleet restore: ${verdict}${final.cancelled ? " (cancelled)" : ""}`);
        for (const r of rollup.sequence) write(`  ${r.rigId}: ${r.outcome}`);
        if (rollup.attention_required.length > 0) {
          write("Needs attention:");
          for (const a of rollup.attention_required) write(`  ${a.rigId}/${a.seat} — ${a.need}`);
        }
      } catch (e) {
        // r1: the sync action had NO error handling — a thrown client error killed the verb
        // with an unhandled rejection. Structured, honest failure instead.
        const msg = e instanceof Error ? e.message : String(e);
        write(json ? JSON.stringify({ error: msg }) : `Fleet restore failed: ${msg}`);
        process.exitCode = 1;
      }
    });

  // `rig crash-cart cancel-fleet <fleetAttemptId> [--json]` — reach the cancel endpoint for a running
  // fleet restore (stop-before-next-rig). The operator-facing CLI trigger for the endpoint that exists,
  // so cancel is reachable off the cockpit path too (r2 HIGH-1 / plan R8).
  cmd
    .command("cancel-fleet <fleetAttemptId>")
    .description("Cancel a running fleet restore (stop-before-next-rig).")
    .option("--json", "emit the cancel result as JSON")
    .action(async (fleetAttemptId: string, _opts: { json?: boolean }, command: Command) => {
      const json = (command.optsWithGlobals() as { json?: boolean }).json === true;
      const write = deps?.write ?? ((line: string) => process.stdout.write(line + "\n"));
      const client = await acquireClient(json);
      if (!client) {
        process.exitCode = 1;
        return;
      }
      try {
        const res = await client.post<{ ok?: boolean; cancelled?: boolean; error?: string }>(
          `/api/crash-cart/restore-fleet/${encodeURIComponent(fleetAttemptId)}/cancel`,
        );
        if (res.status >= 400) {
          const err = res.data?.error ?? `HTTP ${res.status}`;
          write(json ? JSON.stringify({ error: err }) : `Cancel failed: ${err}`);
          process.exitCode = 1;
          return;
        }
        write(json ? JSON.stringify(res.data) : `Cancel requested for ${fleetAttemptId} (stop-before-next-rig).`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        write(json ? JSON.stringify({ error: msg }) : `Cancel failed: ${msg}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
