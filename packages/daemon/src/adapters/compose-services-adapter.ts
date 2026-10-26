import { connect } from "node:net";
import type { ExecFn } from "./tmux.js";

// -- Result types --

/** Outcome of a TCP wait-target check. `reason` says why a failed check failed. */
export type TcpCheckResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "unreachable" | "named_port_needs_nc" };

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

function formatExecError(err: unknown): string {
  if (err instanceof Error) {
    const execErr = err as Error & { stdout?: unknown; stderr?: unknown };
    const stdout = typeof execErr.stdout === "string"
      ? execErr.stdout.trim()
      : "";
    const stderr = typeof execErr.stderr === "string"
      ? execErr.stderr.trim()
      : "";
    const details = [stdout, stderr].filter(Boolean).join("\n");
    if (details && !err.message.includes(details)) {
      return `${err.message}\n${details}`;
    }
    return err.message;
  }
  return String(err);
}

/** Docker's own words when its Compose v2 plugin is missing: plain `docker` reads Compose's `-f` as its own flag ("unknown
 *  shorthand flag: 'f'"), or doesn't know `compose` at all. So every compose command fails. */
const COMPOSE_MISSING_SIGNS = /unknown shorthand flag: 'f'|'compose' is not a docker command/;

/** What a person sees when the Compose check fails. The check's own diagnostic is the cause as far as it's known: a missing
 *  plugin is the usual one, not the only one. */
export function composeMissingMessage(detail: string): string {
  const reason = detail.replace(/\.+$/, "");
  return `Service bundles need Docker Compose v2, and \`docker compose version\` failed${reason ? `: ${reason}` : ""}. Make sure this Docker has its Compose v2 plugin.`;
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

  /** Whether Docker Compose v2 is available to this Docker. */
  async composeAvailable(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.exec("docker compose version 2>&1");
      return { ok: true };
    } catch (err) {
      // Docker's own reason: not the exec's "Command failed" header, nor Docker's pointer to its help after it.
      const reason = formatExecError(err).split("\n").map((line) => line.trim())
        .find((line) => line && !line.startsWith("Command failed") && !/^See '.*--help'/.test(line));
      return { ok: false, message: composeMissingMessage(reason ?? "") };
    }
  }

  /** Whether a failed compose command failed because Compose v2 is missing. Only Docker's own words for that lead to the
   *  check; any other failure is reported as it came, with no further commands. */
  private async composeMissingBehind(err: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
    return COMPOSE_MISSING_SIGNS.test(formatExecError(err)) ? this.composeAvailable() : { ok: true };
  }

  /** The containers Docker has for a Compose project, read with plain `docker` (no Compose plugin needed); null when Docker
   *  can't be read. */
  async projectContainers(projectName: string): Promise<string[] | null> {
    try {
      const out = await this.exec(`docker ps -aq --filter ${sq(`label=com.docker.compose.project=${projectName}`)} 2>&1`);
      return out.split(/\s+/).filter(Boolean);
    } catch {
      return null;
    }
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
      const compose = await this.composeMissingBehind(err);
      return { ok: false, code: "compose_up_failed", message: compose.ok ? formatExecError(err) : `${compose.message}\n${formatExecError(err)}` };
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
      // Without Compose v2 nothing of this project could have started through it. When plain Docker confirms the project
      // has no containers, there's nothing to take down; otherwise say what's missing.
      const compose = await this.composeMissingBehind(err);
      if (!compose.ok && (await this.projectContainers(opts.projectName))?.length === 0) return { ok: true };
      return { ok: false, code: "compose_down_failed", message: compose.ok ? formatExecError(err) : `${compose.message}\n${formatExecError(err)}` };
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
      const parseInput = this.extractComposePsPayload(output);
      const services = this.parseComposePs(parseInput);
      // `[]` is how array-format Compose releases report a project with no containers.
      if (parseInput !== "" && services.length === 0 && !/^\[\s*\]$/.test(parseInput)) {
        return { ok: false, services: [], error: "docker compose ps returned unparseable JSON output" };
      }
      return { ok: true, services };
    } catch (err) {
      return { ok: false, services: [], error: formatExecError(err) };
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
    const tailArg = Number.isFinite(opts.tail) ? ` --tail ${opts.tail}` : "";
    const cmd = `docker compose ${args} logs${tailArg}${serviceArg} 2>&1`;
    try {
      const output = await this.exec(cmd);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: "", error: formatExecError(err) };
    }
  }

  /** Run a checkpoint export command. */
  async runCheckpointExport(command: string): Promise<ComposeResult> {
    try {
      await this.exec(command);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "checkpoint_export_failed", message: formatExecError(err) };
    }
  }

  /** Run a checkpoint import command. */
  async runCheckpointImport(command: string): Promise<ComposeResult> {
    try {
      await this.exec(command);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "checkpoint_import_failed", message: formatExecError(err) };
    }
  }

  /** Probe an HTTP wait target. Any 2xx or 3xx response passes this target;
   * redirects are not followed. This proves the server answered, not application readiness. */
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
    return (await this.checkTcp(target, timeoutMs)).ok;
  }

  /**
   * Check a TCP wait target (`host:port`, `[v6]:port`, or `host:service-name`) and say why it
   * failed. A numeric port is probed with Node's own socket, so it works without an external `nc`,
   * which many Linux installs lack. A named port such as `db:postgresql` goes through `nc`, which
   * looks the service name up; where `nc` is missing the check fails with `named_port_needs_nc`.
   */
  async checkTcp(target: string, timeoutMs: number = 5000): Promise<TcpCheckResult> {
    const match = /^(?:\[([^\]]+)\]|([^:]+)):([^:]+)$/.exec(target);
    const host = match?.[1] ?? match?.[2];
    const portStr = match?.[3];
    if (!host || !portStr) return { ok: false, reason: "malformed" };
    if (/^\d+$/.test(portStr)) {
      const port = Number(portStr);
      if (port < 1 || port > 65535) return { ok: false, reason: "malformed" };
      return (await this.connectTcp(host, port, timeoutMs)) ? { ok: true } : { ok: false, reason: "unreachable" };
    }
    // A service name may start with a digit (`9pfs` in the services database) but needs a letter,
    // and never starts with `-`, so nothing reads as an `nc` option.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(portStr) || !/[A-Za-z]/.test(portStr)) {
      return { ok: false, reason: "malformed" };
    }
    try {
      await this.exec("command -v nc");
    } catch {
      return { ok: false, reason: "named_port_needs_nc" };
    }
    try {
      await this.exec(`nc -z -w ${Math.ceil(timeoutMs / 1000)} ${sq(host)} ${sq(portStr)} 2>/dev/null`);
      return { ok: true };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  /** True if a TCP connection to host:port opens within the timeout. */
  private connectTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      const socket = connect({ host, port, timeout: timeoutMs });
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
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

  private extractComposePsPayload(output: string): string {
    const trimmed = output.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

    const jsonLines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") || line.startsWith("["));

    return jsonLines.join("\n");
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
