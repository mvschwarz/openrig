import type { ExecFn } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** Probe result status — matches Phase 5 spec */
export type ProbeStatus = "installed" | "missing" | "unsupported" | "unknown";

/** Input specification for a single requirement to probe */
export interface RequirementSpec {
  name: string;
  kind: "cli_tool" | "system_package";
  installHints?: Record<string, string>;
}

/** Result of probing a single requirement */
export interface ProbeResult {
  name: string;
  kind: "cli_tool" | "system_package";
  status: ProbeStatus;
  /** Version string when provider reports it (e.g. brew). Null for cli_tool probes. */
  version: string | null;
  /** Resolved binary path from `command -v`. Null for non-cli probes or missing tools. */
  detectedPath: string | null;
  /** Provider used for the probe (e.g. 'homebrew'). Null for generic CLI probes. */
  provider: string | null;
  /** The exact command that was executed. Null if no probe was executed (unsupported). */
  command: string | null;
  /** Install hints from the manifest — display only, never executed. */
  installHints: Record<string, string> | null;
  /** Error message if probe failed or timed out. */
  error: string | null;
}

interface ProbeOptions {
  timeoutMs?: number;
  platform?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Provider-backed probe registry for CLI tools and system packages.
 * Uses injected ExecFn — no real shell execution in tests.
 */
export class RequirementsProbeRegistry {
  private exec: ExecFn;
  private timeoutMs: number;
  private platform: string;

  constructor(exec: ExecFn, opts?: ProbeOptions) {
    this.exec = exec;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.platform = opts?.platform ?? process.platform;
  }

  /**
   * Probe a CLI tool via `command -v`.
   * Returns the resolved binary path in detectedPath, version stays null.
   */
  async probeCli(name: string): Promise<ProbeResult> {
    const cmd = `command -v ${shellQuote(name)}`;
    try {
      const stdout = await this.execWithTimeout(cmd);
      const detectedPath = stdout.trim() || null;
      return {
        name,
        kind: "cli_tool",
        status: detectedPath ? "installed" : "missing",
        version: null,
        detectedPath,
        provider: null,
        command: cmd,
        installHints: null,
        error: null,
      };
    } catch (err) {
      if ((err as Error).message?.includes("timed out")) {
        return {
          name, kind: "cli_tool", status: "unknown", version: null,
          detectedPath: null, provider: null, command: cmd,
          installHints: null, error: "probe timed out",
        };
      }
      return {
        name, kind: "cli_tool", status: "missing", version: null,
        detectedPath: null, provider: null, command: cmd,
        installHints: null, error: null,
      };
    }
  }

  /**
   * Probe a system package via Homebrew (`brew list --versions`).
   * Parses version from output when available.
   */
  async probeBrew(name: string): Promise<ProbeResult> {
    const cmd = `brew list --versions ${shellQuote(name)}`;
    try {
      const stdout = await this.execWithTimeout(cmd);
      const trimmed = stdout.trim();
      // brew list --versions outputs: "name 1.2.3" or "name 1.2.3 1.2.4"
      const parts = trimmed.split(/\s+/);
      const version = parts.length > 1 ? parts[parts.length - 1]! : null;
      return {
        name,
        kind: "system_package",
        status: "installed",
        version,
        detectedPath: null,
        provider: "homebrew",
        command: cmd,
        installHints: null,
        error: null,
      };
    } catch (err) {
      if ((err as Error).message?.includes("timed out")) {
        return {
          name, kind: "system_package", status: "unknown", version: null,
          detectedPath: null, provider: "homebrew", command: cmd,
          installHints: null, error: "probe timed out",
        };
      }
      return {
        name, kind: "system_package", status: "missing", version: null,
        detectedPath: null, provider: "homebrew", command: cmd,
        installHints: null, error: null,
      };
    }
  }

  /**
   * Probe a single requirement. Routes to the appropriate provider.
   * Preserves installHints from the spec onto the result.
   */
  async probeRequirement(spec: RequirementSpec): Promise<ProbeResult> {
    let result: ProbeResult;

    if (spec.kind === "cli_tool") {
      result = await this.probeCli(spec.name);
    } else if (spec.kind === "system_package") {
      if (this.platform !== "darwin") {
        result = {
          name: spec.name,
          kind: "system_package",
          status: "unsupported",
          version: null,
          detectedPath: null,
          provider: null,
          command: null,
          installHints: null,
          error: null,
        };
      } else {
        result = await this.probeBrew(spec.name);
      }
    } else {
      result = {
        name: spec.name,
        kind: spec.kind,
        status: "unsupported",
        version: null,
        detectedPath: null,
        provider: null,
        command: null,
        installHints: null,
        error: null,
      };
    }

    // Preserve installHints from spec — display only, never executed
    if (spec.installHints) {
      result.installHints = spec.installHints;
    }

    return result;
  }

  /**
   * Probe all requirements in sequence. Returns results in input order.
   */
  async probeAll(specs: RequirementSpec[]): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const spec of specs) {
      results.push(await this.probeRequirement(spec));
    }
    return results;
  }

  private async execWithTimeout(cmd: string): Promise<string> {
    return Promise.race([
      this.exec(cmd),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timed out")), this.timeoutMs)
      ),
    ]);
  }
}
