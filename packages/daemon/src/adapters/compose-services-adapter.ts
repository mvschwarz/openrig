import type { ExecFn } from "./tmux.js";

// -- Result types --

export type ComposeResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface ComposeServiceStatus {
  name: string;
  state: string;
  status: string;
  health: string | null;
}

export interface ComposeStatusResult {
  ok: boolean;
  services: ComposeServiceStatus[];
  error?: string;
}

export interface ComposeLogsResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Shell-quote a string using single quotes (POSIX-safe). */
function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

// -- Adapter --

/**
 * I/O adapter for Docker Compose. Shells out to `docker compose`.
 * Lives in adapters/ alongside tmux.ts — infrastructure I/O, not domain logic.
 */
export class ComposeServicesAdapter {
  private exec: ExecFn;

  constructor(exec: ExecFn) {
    this.exec = exec;
  }

  /** Start services with docker compose up -d. Readiness is handled by services-readiness, not --wait. */
  async up(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
  }): Promise<ComposeResult> {
    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const cmd = `docker compose ${args} up -d 2>&1`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "compose_up_failed", message: (err as Error).message };
    }
  }

  /** Stop services according to down policy. */
  async down(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
    policy: "leave_running" | "down" | "down_and_volumes";
  }): Promise<ComposeResult> {
    if (opts.policy === "leave_running") {
      return { ok: true }; // intentional no-op
    }

    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const volumeFlag = opts.policy === "down_and_volumes" ? " --volumes" : "";
    const cmd = `docker compose ${args} down${volumeFlag} 2>&1`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "compose_down_failed", message: (err as Error).message };
    }
  }

  /** Get service statuses via docker compose ps --format json. */
  async status(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
  }): Promise<ComposeStatusResult> {
    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const cmd = `docker compose ${args} ps --format json 2>&1`;
    try {
      const output = await this.exec(cmd);
      const services = this.parseComposePs(output);
      if (output.trim() !== "" && services.length === 0) {
        return { ok: false, services: [], error: "docker compose ps returned unparseable JSON output" };
      }
      return { ok: true, services };
    } catch (err) {
      return { ok: false, services: [], error: (err as Error).message };
    }
  }

  /** Get logs for a specific service or all services. */
  async logs(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
    service?: string;
    tail?: number;
  }): Promise<ComposeLogsResult> {
    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const serviceArg = opts.service ? ` ${sq(opts.service)}` : "";
    const tailArg = opts.tail ? ` --tail ${opts.tail}` : "";
    const cmd = `docker compose ${args} logs${tailArg}${serviceArg} 2>&1`;
    try {
      const output = await this.exec(cmd);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: "", error: (err as Error).message };
    }
  }

  /** Run a checkpoint export command. */
  async runCheckpointExport(command: string): Promise<ComposeResult> {
    try {
      await this.exec(command);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "checkpoint_export_failed", message: (err as Error).message };
    }
  }

  /** Run a checkpoint import command. */
  async runCheckpointImport(command: string): Promise<ComposeResult> {
    try {
      await this.exec(command);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "checkpoint_import_failed", message: (err as Error).message };
    }
  }

  /** Probe an HTTP wait target. Returns true if the URL responds with 2xx. */
  async probeHttp(url: string, timeoutMs: number = 5000): Promise<boolean> {
    try {
      const cmd = `curl -sf -o /dev/null -w '%{http_code}' --max-time ${Math.ceil(timeoutMs / 1000)} ${sq(url)} 2>/dev/null`;
      const output = await this.exec(cmd);
      const code = parseInt(output.trim(), 10);
      return code >= 200 && code < 400;
    } catch {
      return false;
    }
  }

  /** Probe a TCP wait target. Returns true if the port is open. */
  async probeTcp(target: string, timeoutMs: number = 5000): Promise<boolean> {
    try {
      const [host, portStr] = target.split(":");
      if (!host || !portStr) return false;
      const cmd = `nc -z -w ${Math.ceil(timeoutMs / 1000)} ${sq(host)} ${sq(portStr)} 2>/dev/null`;
      await this.exec(cmd);
      return true;
    } catch {
      return false;
    }
  }

  // -- Private helpers --

  private baseArgs(composeFile: string, projectName: string, profiles?: string[]): string {
    const parts = [`-f ${sq(composeFile)}`, `-p ${sq(projectName)}`];
    if (profiles && profiles.length > 0) {
      for (const p of profiles) {
        parts.push(`--profile ${sq(p)}`);
      }
    }
    return parts.join(" ");
  }

  /** Parse docker compose ps --format json. Handles both one-object-per-line and JSON array formats. */
  private parseComposePs(output: string): ComposeServiceStatus[] {
    const trimmed = output.trim();
    if (!trimmed) return [];

    // Try JSON array first
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
        return arr.map((obj) => this.mapServiceStatus(obj));
      } catch { /* fall through to line-by-line */ }
    }

    // One JSON object per line
    const results: ComposeServiceStatus[] = [];
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (!l || !l.startsWith("{")) continue;
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        results.push(this.mapServiceStatus(obj));
      } catch { /* skip malformed lines */ }
    }
    return results;
  }

  private mapServiceStatus(obj: Record<string, unknown>): ComposeServiceStatus {
    return {
      name: String(obj["Service"] ?? obj["Name"] ?? ""),
      state: String(obj["State"] ?? ""),
      status: String(obj["Status"] ?? ""),
      health: typeof obj["Health"] === "string" ? obj["Health"] : null,
    };
  }
}
