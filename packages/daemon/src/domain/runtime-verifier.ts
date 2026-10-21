import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ExecFn } from "../adapters/tmux.js";
import { ProbeStoppedError, ProbeTimeoutError } from "../adapters/bounded-probe-exec.js";
import type { RuntimeVerification, RuntimeStatus } from "./bootstrap-types.js";

interface RuntimeVerifierDeps {
  exec: ExecFn;
  db: Database.Database;
  /** Runs the `--version` / `--help` probes (default: exec). The daemon passes boundedProbeExec, so a hung
   *  runtime binary is ended after a bound instead of holding up startup or bootstrap. */
  probeExec?: ExecFn;
}

/** What a probe that didn't answer within its bound records: status "error" with what happened. The binary
 *  exists but hangs, so it isn't "not found", and after a `--version` timeout `--help` isn't tried (it would
 *  usually hang too, doubling the wait). */
export function probeTimeoutOutcome(
  _binary: string,
  _probe: "version" | "help",
  timeout: ProbeTimeoutError,
): { fallBackToHelp: true } | { status: RuntimeStatus; error: string } {
  return { status: "error", error: timeout.message };
}

// OPR.0.4.6.PI1 — Pi's documented Node engine floor (package.json engines).
export const PI_NODE_ENGINE_FLOOR = "22.19.0";

export function meetsPiNodeEngineFloor(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map((p) => parseInt(p, 10));
  const floor = PI_NODE_ENGINE_FLOOR.split(".").map((p) => parseInt(p, 10));
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0;
    const need = floor[i]!;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/**
 * Verifies runtimes are usable — not just present on PATH.
 * Persists results to runtime_verifications table automatically.
 */
export class RuntimeVerifier {
  readonly db: Database.Database;
  private exec: ExecFn;
  private probeExec: ExecFn;

  constructor(deps: RuntimeVerifierDeps) {
    this.db = deps.db;
    this.exec = deps.exec;
    this.probeExec = deps.probeExec ?? deps.exec;
  }

  /** Verify tmux: `tmux -V`, parse version from output. */
  async verifyTmux(): Promise<RuntimeVerification> {
    const result = await this.runProbe("tmux", async () => {
      const output = await this.exec("tmux -V");
      const version = this.parseVersion(output);
      if (!version) {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "unparseable version output" };
      }
      return { status: "verified" as RuntimeStatus, version, capabilitiesJson: null, error: null };
    });
    this.persist(result);
    return result;
  }

  /** Verify cmux: `cmux capabilities --json`, parse capabilities. */
  async verifyCmux(): Promise<RuntimeVerification> {
    const result = await this.runProbe("cmux", async () => {
      const output = await this.exec("cmux capabilities --json");
      const trimmed = output.trim();
      try {
        const parsed = JSON.parse(trimmed);
        const capsJson = JSON.stringify(parsed);
        return { status: "verified" as RuntimeStatus, version: null, capabilitiesJson: capsJson, error: null };
      } catch {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "invalid capabilities JSON" };
      }
    }, "degraded");
    this.persist(result);
    return result;
  }

  /** Verify Claude Code: `claude --version`, fallback to `claude --help`. */
  async verifyClaude(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("claude", "claude-code");
    this.persist(result);
    return result;
  }

  /** Verify Codex: `codex --version`, fallback to `codex --help`. */
  async verifyCodex(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("codex", "codex");
    this.persist(result);
    return result;
  }

  /** OPR.0.4.6.PI1 FR-1 — Verify Pi: `pi --version` (fallback `pi --help`)
   *  plus the Node engine floor Pi requires (>= 22.19.0). Provider/model
   *  resolvability is member-scoped and verified at launch, not here. */
  async verifyPi(): Promise<RuntimeVerification> {
    let result = await this.verifyVersionOrHelp("pi", "pi");
    if (result.status === "verified") {
      try {
        const nodeVersion = this.parseVersion(await this.exec("node --version"));
        if (nodeVersion && !meetsPiNodeEngineFloor(nodeVersion)) {
          result = this.buildVerification(
            "pi",
            "error",
            result.version,
            null,
            `Pi requires Node >= ${PI_NODE_ENGINE_FLOOR}; found ${nodeVersion}. Upgrade Node to run pi seats.`,
          );
        }
      } catch {
        // `node` unresolvable from the daemon's exec context — leave the
        // binary verification standing; the engine floor re-checks at launch.
      }
    }
    this.persist(result);
    return result;
  }

  /** OMP is an independent executable; do not inherit Pi's Node engine check. */
  async verifyOmp(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("omp", "omp");
    this.persist(result);
    return result;
  }

  /**
   * Verify multiple runtimes. Returns results in input order.
   * @param runtimes - canonical runtime names: 'tmux', 'cmux', 'claude-code', 'codex', 'pi', 'omp'
   */
  async verifyAll(runtimes: string[]): Promise<RuntimeVerification[]> {
    const results: RuntimeVerification[] = [];
    for (const runtime of runtimes) {
      switch (runtime) {
        case "tmux": results.push(await this.verifyTmux()); break;
        case "cmux": results.push(await this.verifyCmux()); break;
        case "claude-code": results.push(await this.verifyClaude()); break;
        case "codex": results.push(await this.verifyCodex()); break;
        case "pi": results.push(await this.verifyPi()); break;
        case "omp": results.push(await this.verifyOmp()); break;
        default: {
          const v = this.buildVerification(runtime, "not_found", null, null, `unknown runtime: ${runtime}`);
          this.persist(v);
          results.push(v);
        }
      }
    }
    return results;
  }

  /**
   * Shared helper: try `{binary} --version`, fall back to `{binary} --help`.
   * Used by verifyClaude and verifyCodex.
   */
  private async verifyVersionOrHelp(binary: string, canonicalName: string): Promise<RuntimeVerification> {
    // Try --version first
    try {
      const output = await this.probeExec(`${binary} --version`);
      const version = this.parseVersion(output);
      return this.buildVerification(canonicalName, "verified", version ?? null, null, null);
    } catch (err) {
      // The daemon is stopping: this probe says nothing about the runtime, so no --help and no row.
      if (err instanceof ProbeStoppedError) throw err;
      if (err instanceof ProbeTimeoutError) {
        const outcome = probeTimeoutOutcome(binary, "version", err);
        if (!("fallBackToHelp" in outcome)) return this.buildVerification(canonicalName, outcome.status, null, null, outcome.error);
      }
      // Fall back to --help
      try {
        await this.probeExec(`${binary} --help`);
        return this.buildVerification(canonicalName, "verified", null, null, null);
      } catch (helpErr) {
        if (helpErr instanceof ProbeStoppedError) throw helpErr;
        if (helpErr instanceof ProbeTimeoutError) {
          const outcome = probeTimeoutOutcome(binary, "help", helpErr);
          if (!("fallBackToHelp" in outcome)) return this.buildVerification(canonicalName, outcome.status, null, null, outcome.error);
        }
        return this.buildVerification(canonicalName, "not_found", null, null, `${binary} not found`);
      }
    }
  }

  /**
   * Run a probe with error handling. On exec failure, returns failStatus (default: not_found).
   */
  private async runProbe(
    runtime: string,
    fn: () => Promise<{ status: RuntimeStatus; version: string | null; capabilitiesJson: string | null; error: string | null }>,
    failStatus: RuntimeStatus = "not_found",
  ): Promise<RuntimeVerification> {
    try {
      const { status, version, capabilitiesJson, error } = await fn();
      return this.buildVerification(runtime, status, version, capabilitiesJson, error);
    } catch (err) {
      return this.buildVerification(runtime, failStatus, null, null, (err as Error).message);
    }
  }

  private buildVerification(
    runtime: string,
    status: RuntimeStatus,
    version: string | null,
    capabilitiesJson: string | null,
    error: string | null,
  ): RuntimeVerification {
    return {
      id: ulid(),
      runtime,
      version,
      capabilitiesJson,
      verifiedAt: new Date().toISOString(),
      status,
      error,
    };
  }

  /** Parse a semver-like version from output (e.g. "tmux 3.4" -> "3.4"). */
  private parseVersion(output: string): string | undefined {
    const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z])?)/);
    return match?.[1];
  }

  /** Persist verification to runtime_verifications table. Upserts by runtime name. */
  private persist(v: RuntimeVerification): void {
    const existing = this.db
      .prepare("SELECT id FROM runtime_verifications WHERE runtime = ?")
      .get(v.runtime) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE runtime_verifications SET version = ?, capabilities_json = ?, verified_at = ?, status = ?, error = ? WHERE runtime = ?"
      ).run(v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error, v.runtime);
      v.id = existing.id;
    } else {
      this.db.prepare(
        "INSERT INTO runtime_verifications (id, runtime, version, capabilities_json, verified_at, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(v.id, v.runtime, v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error);
    }
  }
}
