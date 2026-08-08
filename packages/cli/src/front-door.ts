// Slice-17 mini-req 7 — BARE-RIG FRONT DOOR (founder, arch-reinforced).
//
// bare `rig` (no args) opens the TUI, k9s-style, TTY-AWARE:
//   - the guard checks BOTH stdin AND stdout isTTY — a pipe/redirect on
//     EITHER stream means a script is involved, so the front door does NOT
//     own the invocation and the normal commander usage path runs (prints
//     usage, exits fast, never hangs — `echo x | rig` must not block);
//   - first-impression degrade: transport, cwd/read, command/PATH, and
//     enforcement remain distinct typed axes; TUI-init failures stay concise;
//   - `--help`, `--version`, and every subcommand are ARGS, so they are
//     naturally excluded from bare invocation and behave unchanged.
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  DaemonClient,
  DaemonConnectionError,
  DaemonResponseError,
  DaemonTimeoutError,
} from "./client.js";

interface FrontDoorPermissionDiagnostic {
  transport: { state: "healthy" | "connect" | "timeout" | "response"; detail?: string };
  cwdRead: { state: "visible" | "denied" | "unknown" };
  commandPath: { state: "available" | "missing" | "unknown" };
  enforcement: {
    axis: "permission" | "sandbox" | "resource_trust" | "not_applicable";
    state: "aligned" | "drift" | "unknown";
    expected: string | null;
    effective: string | { defaultMode: string } | null;
    sourcePath: string | null;
    reason?: string;
  };
  observedAt: string;
}

export type FrontDoorProbeResult =
  | { state: "ready" }
  | { state: "diagnostic"; diagnostic: FrontDoorPermissionDiagnostic };

type LegacyTransportProbeResult = { state: "connect" | "timeout" | "response"; message: string };

interface FrontDoorProbeClient {
  get(path: string, options?: { timeoutMs?: number }): Promise<{ status: number; data: unknown }>;
}

function transportDiagnostic(state: "connect" | "timeout" | "response", detail?: string): FrontDoorPermissionDiagnostic {
  return {
    transport: { state, ...(detail ? { detail } : {}) },
    cwdRead: { state: "unknown" },
    commandPath: { state: "unknown" },
    enforcement: {
      axis: "not_applicable",
      state: "unknown",
      expected: null,
      effective: null,
      sourcePath: null,
      reason: "transport_unavailable",
    },
    observedAt: new Date().toISOString(),
  };
}

/** Monorepo-first, bundled-fallback TUI entry resolution — the exact
 * resolveDaemonPath pattern (see daemon-lifecycle.ts): a dev checkout's
 * `packages/tui/dist` is the source of truth; an npm-install layout ships
 * the bundled copy next to the cli. Null = not found (caller degrades). */
export function resolveTuiPath(baseDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const cliBaseDir = path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
  const monorepo = path.join(path.resolve(cliBaseDir, "../../tui"), "dist/main.js");
  if (exists(monorepo)) return monorepo;
  const bundled = path.join(path.resolve(cliBaseDir, "../tui"), "dist/main.js");
  if (exists(bundled)) return bundled;
  return null;
}

export const USAGE_LINES = [
  "rig — the OpenRig control plane",
  "",
  "  rig              open mission control (interactive terminal only)",
  "  rig tui          open mission control (explicit alias of bare `rig`)",
  "  rig --help       full command list",
  "  rig up <rig>     bring a rig up",
  "  rig ps           list live seats",
];

export interface FrontDoorIo {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
  /** Typed daemon/current-seat probe (legacy booleans remain accepted for injected callers). */
  probeDaemon?: () => Promise<boolean | FrontDoorProbeResult | LegacyTransportProbeResult>;
  /** launch the TUI and resolve with its exit code */
  launchTui?: () => Promise<number>;
}

function envValue(env: NodeJS.ProcessEnv, current: string, legacy: string): string | undefined {
  return env[current]?.trim() || env[legacy]?.trim() || undefined;
}

/**
 * Managed seats request the strict current-seat diagnostic. Unmanaged shells
 * keep the cheap health-only path. Transport classes remain distinct.
 */
export async function probeFrontDoor(input: {
  client?: FrontDoorProbeClient;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<FrontDoorProbeResult> {
  const client = input.client ?? new DaemonClient(undefined, { timeoutMs: 1500 });
  const env = input.env ?? process.env;
  const nodeId = envValue(env, "OPENRIG_NODE_ID", "RIGGED_NODE_ID");
  const sessionName = envValue(env, "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  const identityQuery = nodeId
    ? `nodeId=${encodeURIComponent(nodeId)}`
    : sessionName
      ? `sessionName=${encodeURIComponent(sessionName)}`
      : null;
  const path = identityQuery
    ? `/api/whoami?${identityQuery}&compact=1&diagnostics=permission`
    : "/healthz";
  try {
    const res = await client.get(path, { timeoutMs: 1500 });
    if (res.status < 200 || res.status >= 300) {
      return { state: "diagnostic", diagnostic: transportDiagnostic("response", `daemon returned HTTP ${res.status}`) };
    }
    if (!identityQuery) return { state: "ready" };
    const diagnostic = (res.data as { permissionDrift?: FrontDoorPermissionDiagnostic } | null)?.permissionDrift;
    if (!diagnostic) {
      return { state: "diagnostic", diagnostic: transportDiagnostic("response", "daemon response omitted permission diagnostics") };
    }
    if (
      diagnostic.transport.state === "healthy"
      && diagnostic.cwdRead.state === "visible"
      && diagnostic.commandPath.state === "available"
      && diagnostic.enforcement.state === "aligned"
    ) {
      return { state: "ready" };
    }
    return { state: "diagnostic", diagnostic };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof DaemonTimeoutError) return { state: "diagnostic", diagnostic: transportDiagnostic("timeout", detail) };
    if (error instanceof DaemonResponseError) return { state: "diagnostic", diagnostic: transportDiagnostic("response", detail) };
    if (error instanceof DaemonConnectionError) return { state: "diagnostic", diagnostic: transportDiagnostic("connect", detail) };
    return { state: "diagnostic", diagnostic: transportDiagnostic("response", detail) };
  }
}

function normalizeProbe(result: boolean | FrontDoorProbeResult | LegacyTransportProbeResult): FrontDoorProbeResult {
  if (result === true) return { state: "ready" };
  if (result === false) return { state: "diagnostic", diagnostic: transportDiagnostic("connect", "cannot connect to the OpenRig daemon") };
  switch (result.state) {
    case "ready":
    case "diagnostic":
      return result;
    case "connect":
    case "timeout":
    case "response":
      return { state: "diagnostic", diagnostic: transportDiagnostic(result.state, result.message) };
  }
}

function renderDiagnostic(diagnostic: FrontDoorPermissionDiagnostic): string {
  const label = diagnostic.enforcement.axis === "resource_trust"
    ? "resource trust"
    : diagnostic.enforcement.axis;
  const effective = typeof diagnostic.enforcement.effective === "object" && diagnostic.enforcement.effective !== null
    ? diagnostic.enforcement.effective.defaultMode
    : diagnostic.enforcement.effective;
  const parts = [
    `transport: ${diagnostic.transport.state}`,
    `cwd/read: ${diagnostic.cwdRead.state}`,
    `command/PATH: ${diagnostic.commandPath.state}`,
    `${label}: ${diagnostic.enforcement.state.toUpperCase()}`,
  ];
  if (diagnostic.transport.detail) parts.push(`detail=${diagnostic.transport.detail}`);
  if (diagnostic.enforcement.expected) parts.push(`expected=${diagnostic.enforcement.expected}`);
  if (effective) parts.push(`effective=${effective}`);
  if (diagnostic.enforcement.sourcePath) parts.push(`source=${diagnostic.enforcement.sourcePath}`);
  if (diagnostic.enforcement.reason) parts.push(`reason=${diagnostic.enforcement.reason}`);
  return parts.join(" · ");
}

function diagnosticVerdict(diagnostic: FrontDoorPermissionDiagnostic): string {
  if (diagnostic.transport.state !== "healthy") return `TRANSPORT_${diagnostic.transport.state.toUpperCase()}`;
  if (diagnostic.cwdRead.state !== "visible") return `CWD_READ_${diagnostic.cwdRead.state.toUpperCase()}`;
  if (diagnostic.commandPath.state !== "available") return `COMMAND_PATH_${diagnostic.commandPath.state.toUpperCase()}`;
  if (diagnostic.enforcement.state === "drift") return "PERMISSION_DRIFT";
  return "UNKNOWN_EFFECTIVE";
}

async function defaultLaunchTui(): Promise<number> {
  const entry = resolveTuiPath(import.meta.dirname);
  if (!entry) throw new Error("mission-control TUI is not installed (no tui/dist/main.js next to this CLI)");
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * The OWNED mission-control path, factored out so `rig tui` is a true ALIAS (not a
 * mirror) of what bare `rig` does: probe the daemon, then either launch the TUI and
 * exit with its code, or print the friendly first-impression degrade. Shared by
 * runFrontDoor (bare `rig`) and the `tui` subcommand — one launch path, no duplication.
 */
export async function openMissionControl(io: FrontDoorIo = {}): Promise<void> {
  const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const exit = io.exit ?? ((c: number) => process.exit(c));
  const probe = io.probeDaemon ?? probeFrontDoor;
  const launch = io.launchTui ?? defaultLaunchTui;

  const probeResult = normalizeProbe(await probe());
  if (probeResult.state !== "ready") {
    for (const line of USAGE_LINES) err(line);
    err("");
    err(`runtime posture: ${diagnosticVerdict(probeResult.diagnostic)}`);
    err(renderDiagnostic(probeResult.diagnostic));
    exit(1);
    return;
  }
  try {
    const code = await launch();
    exit(code);
  } catch (e) {
    // first-impression degrade: the message, never the stack
    for (const line of USAGE_LINES) err(line);
    err("");
    err(`mission control could not start: ${e instanceof Error ? e.message : String(e)}`);
    exit(1);
  }
}

/**
 * Returns true when the front door OWNED the invocation (TUI launched or a
 * degrade message printed + exit requested); false to fall through to the
 * normal commander program (args present, or a non-TTY stream).
 */
export async function runFrontDoor(argv: readonly string[], io: FrontDoorIo = {}): Promise<boolean> {
  if (argv.length > 2) return false; // any arg → the normal CLI, unchanged
  const stdinIsTTY = io.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinIsTTY || !stdoutIsTTY) return false; // script involved → usage path, fast exit

  await openMissionControl(io);
  return true;
}
