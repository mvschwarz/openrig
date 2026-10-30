import type { ExecFn } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { readPlatformEnv } from "./platform-env.js";

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
  /** Resolved command path from the platform lookup. Null for non-cli probes or missing tools. */
  detectedPath: string | null;
  /** Provider used for the probe (e.g. 'homebrew'). Null for generic CLI probes. */
  provider: string | null;
  /** The exact command executed. Null for native filesystem lookup or unsupported probes. */
  command: string | null;
  /** Install hints from the manifest — display only, never executed. */
  installHints: Record<string, string> | null;
  /** Error message if probe failed or timed out. */
  error: string | null;
}

interface ProbeOptions {
  timeoutMs?: number;
  platform?: string;
  env?: NodeJS.ProcessEnv;
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
  private env: NodeJS.ProcessEnv;

  constructor(exec: ExecFn, opts?: ProbeOptions) {
    this.exec = exec;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.platform = opts?.platform ?? process.platform;
    this.env = opts?.env ?? process.env;
  }

  /**
   * Probe a CLI tool via `command -v`.
   * Returns the resolved binary path in detectedPath, version stays null.
   */
  async probeCli(name: string): Promise<ProbeResult> {
    if (this.platform === "win32") {
      const result: ProbeResult = { name, kind: "cli_tool", status: "missing", version: null, detectedPath: null, provider: null, command: null, installHints: null, error: null };
      try {
        result.detectedPath = await this.withTimeout(this.findWindowsCommand(name));
        result.status = result.detectedPath ? "installed" : "missing";
      } catch (error) {
        result.status = "unknown";
        result.error = (error as Error).message;
      }
      return result;
    }
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
      const msg = (err as Error).message ?? "";
      if (msg.includes("timed out")) {
        return {
          name, kind: "cli_tool", status: "unknown", version: null,
          detectedPath: null, provider: null, command: cmd,
          installHints: null, error: "probe timed out",
        };
      }
      // Only treat "not found" / exit-code errors as genuinely missing.
      // Other errors (EACCES, etc) are unknown — must not become auto_approvable.
      if (msg.includes("not found") || msg.includes("No such") || msg.includes("exit code")) {
        return {
          name, kind: "cli_tool", status: "missing", version: null,
          detectedPath: null, provider: null, command: cmd,
          installHints: null, error: null,
        };
      }
      return {
        name, kind: "cli_tool", status: "unknown", version: null,
        detectedPath: null, provider: null, command: cmd,
        installHints: null, error: msg,
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
      const msg = (err as Error).message ?? "";
      if (msg.includes("timed out")) {
        return {
          name, kind: "system_package", status: "unknown", version: null,
          detectedPath: null, provider: "homebrew", command: cmd,
          installHints: null, error: "probe timed out",
        };
      }
      if (msg.includes("No such keg") || msg.includes("not found") || msg.includes("exit code")) {
        return {
          name, kind: "system_package", status: "missing", version: null,
          detectedPath: null, provider: "homebrew", command: cmd,
          installHints: null, error: null,
        };
      }
      return {
        name, kind: "system_package", status: "unknown", version: null,
        detectedPath: null, provider: "homebrew", command: cmd,
        installHints: null, error: msg,
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
    return this.withTimeout(this.exec(cmd));
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timed out")), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  private async findWindowsCommand(name: string): Promise<string | null> {
    const extensions = (readPlatformEnv(this.env, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    // A dot can belong to the command's stem (python3.12.exe, for example).
    // Native lookup also tries PATHEXT after an exact dotted filename.
    const names = [...new Set([...(path.extname(name) ? [name] : []), ...extensions.map(extension => name + extension)])];
    const explicit = /[\\/]/.test(name);
    const dirs = explicit ? [""] : (readPlatformEnv(this.env, "PATH", "win32") ?? "").split(path.delimiter);
    for (const dir of dirs) for (const file of names) {
      const candidate = path.resolve(dir.replace(/^"(.*)"$/, "$1"), file);
      try { if ((await stat(candidate)).isFile()) return candidate; }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    return null;
  }
}
