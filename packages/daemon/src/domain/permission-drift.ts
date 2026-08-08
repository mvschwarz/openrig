import nodePath from "node:path";

export type AppliedLaunchAxis = "permission" | "sandbox" | "resource_trust" | "not_applicable";
export type AppliedLaunchState = "observed" | "unknown";

export interface AppliedLaunchObservation {
  runtime: string;
  axis: AppliedLaunchAxis;
  state: AppliedLaunchState;
  value: string | null;
  reason?: string;
}

export type TransportState = "healthy" | "connect" | "timeout" | "response";
export type CwdReadState = "visible" | "denied" | "unknown";
export type CommandPathState = "available" | "missing" | "unknown";
export type EnforcementState = "aligned" | "drift" | "unknown";

export interface EffectiveClaudePermission {
  defaultMode: string;
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface RuntimeEnforcementDiagnostic {
  axis: AppliedLaunchAxis;
  state: EnforcementState;
  expected: string | null;
  effective: string | EffectiveClaudePermission | null;
  sourcePath: string | null;
  reason?: string;
}

export interface PermissionDriftDiagnostic {
  transport: { state: TransportState };
  cwdRead: { state: CwdReadState };
  commandPath: { state: CommandPathState };
  enforcement: RuntimeEnforcementDiagnostic;
  observedAt: string;
}

export interface PermissionDriftFs {
  readFile(path: string): string;
  cwdReadable(path: string): boolean | null;
  commandAvailable(command: string): boolean | null;
  /** Live harness-derived Claude permission-mode vocabulary. null = unresolved. */
  claudePermissionModes(): string[] | null;
}

export function parseClaudePermissionModes(help: string): string[] | null {
  const start = help.indexOf("--permission-mode <mode>");
  if (start < 0) return null;
  const block = help.slice(start, start + 600);
  const choices = block.match(/choices:\s*([^)]+)\)/)?.[1];
  if (!choices) return null;
  const values = [...choices.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  return values.length > 0 ? values : null;
}

export function observeClaudePermission(flag: string): AppliedLaunchObservation {
  if (flag.trim() === "--permission-mode acceptEdits") {
    return { runtime: "claude-code", axis: "permission", state: "observed", value: "acceptEdits" };
  }
  if (flag.trim() === "--dangerously-skip-permissions") {
    return { runtime: "claude-code", axis: "permission", state: "observed", value: "bypassPermissions" };
  }
  return { runtime: "claude-code", axis: "permission", state: "unknown", value: null, reason: "unrecognized_launch_argument" };
}

export function observeCodexSandbox(arg: string): AppliedLaunchObservation {
  const normalized = arg.trim().replace(/\s+/g, " ");
  if (normalized === "-s workspace-write") {
    return { runtime: "codex", axis: "sandbox", state: "observed", value: "workspace-write" };
  }
  if (normalized === "-s danger-full-access") {
    return { runtime: "codex", axis: "sandbox", state: "observed", value: "danger-full-access" };
  }
  if (normalized.startsWith("-p ")) {
    return { runtime: "codex", axis: "sandbox", state: "unknown", value: null, reason: "named_profile_unresolved" };
  }
  return { runtime: "codex", axis: "sandbox", state: "unknown", value: null, reason: "unrecognized_launch_argument" };
}

export function observePiResourceTrust(trust: "approve" | "no-approve"): AppliedLaunchObservation {
  return { runtime: "pi", axis: "resource_trust", state: "observed", value: trust };
}

function runtimeCommand(runtime: string): string | null {
  if (runtime === "claude-code") return "claude";
  if (runtime === "codex") return "codex";
  if (runtime === "pi") return "pi";
  return null;
}

function cwdReadState(fs: PermissionDriftFs, cwd: string | null): CwdReadState {
  if (!cwd) return "unknown";
  try {
    const value = fs.cwdReadable(cwd);
    return value === true ? "visible" : value === false ? "denied" : "unknown";
  } catch {
    return "unknown";
  }
}

function commandPathState(fs: PermissionDriftFs, runtime: string): CommandPathState {
  const command = runtimeCommand(runtime);
  if (!command) return "unknown";
  try {
    const value = fs.commandAvailable(command);
    return value === true ? "available" : value === false ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

function unknownEnforcement(
  axis: AppliedLaunchAxis,
  expected: string | null,
  sourcePath: string | null,
  reason: string,
): RuntimeEnforcementDiagnostic {
  return { axis, state: "unknown", expected, effective: null, sourcePath, reason };
}

function parseStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return [...value];
}

function inspectClaude(
  cwd: string | null,
  applied: AppliedLaunchObservation | null,
  fs: PermissionDriftFs,
): RuntimeEnforcementDiagnostic {
  const expected = applied?.state === "observed" ? applied.value : null;
  if (!cwd) {
    return unknownEnforcement("permission", expected, null, "cwd_unknown");
  }
  const sourcePath = nodePath.join(cwd, ".claude", "settings.local.json");
  if (!applied || applied.runtime !== "claude-code" || applied.axis !== "permission" || applied.state !== "observed" || !expected) {
    return unknownEnforcement("permission", expected, sourcePath, applied?.reason ?? "applied_launch_unknown");
  }

  let raw: string;
  try {
    raw = fs.readFile(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unknownEnforcement("permission", expected, sourcePath, code === "ENOENT" ? "settings_missing" : "settings_unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownEnforcement("permission", expected, sourcePath, "settings_unparseable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unknownEnforcement("permission", expected, sourcePath, "settings_invalid_shape");
  }

  const permissions = (parsed as Record<string, unknown>).permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return unknownEnforcement("permission", expected, sourcePath, permissions === undefined ? "permissions_missing" : "permissions_invalid_shape");
  }
  const record = permissions as Record<string, unknown>;
  const defaultMode = record.defaultMode;
  if (typeof defaultMode !== "string") {
    return unknownEnforcement("permission", expected, sourcePath, "default_mode_missing");
  }
  let supportedModes: Set<string>;
  try {
    const liveModes = fs.claudePermissionModes();
    if (!liveModes || liveModes.length === 0) {
      return unknownEnforcement("permission", expected, sourcePath, "harness_semantics_unknown");
    }
    supportedModes = new Set(liveModes);
  } catch {
    return unknownEnforcement("permission", expected, sourcePath, "harness_semantics_unknown");
  }
  if (!supportedModes.has(defaultMode)) {
    return unknownEnforcement("permission", expected, sourcePath, "unsupported_default_mode");
  }
  const allow = parseStringArray(record.allow);
  const ask = parseStringArray(record.ask);
  const deny = parseStringArray(record.deny);
  if (!allow || !ask || !deny) {
    return unknownEnforcement("permission", expected, sourcePath, "permission_rules_invalid_shape");
  }
  const denySet = new Set(deny);
  if (allow.some((entry) => denySet.has(entry))) {
    return unknownEnforcement("permission", expected, sourcePath, "conflicting_rules");
  }

  const effective: EffectiveClaudePermission = { defaultMode, allow, ask, deny };
  return {
    axis: "permission",
    state: defaultMode === expected ? "aligned" : "drift",
    expected,
    effective,
    sourcePath,
  };
}

function inspectLaunchBoundRuntime(
  runtime: string,
  applied: AppliedLaunchObservation | null,
): RuntimeEnforcementDiagnostic {
  const axis: AppliedLaunchAxis = runtime === "codex" ? "sandbox" : runtime === "pi" ? "resource_trust" : "not_applicable";
  if (!applied || applied.runtime !== runtime || applied.axis !== axis || applied.state !== "observed" || !applied.value) {
    return unknownEnforcement(axis, null, null, applied?.reason ?? "applied_launch_unknown");
  }
  return {
    axis,
    state: "aligned",
    expected: applied.value,
    effective: applied.value,
    sourcePath: null,
    reason: "generation_matched_launch_effect",
  };
}

export function diagnoseRuntimePosture(input: {
  runtime: string;
  cwd: string | null;
  applied: AppliedLaunchObservation | null;
  fs: PermissionDriftFs;
  now?: () => Date;
}): PermissionDriftDiagnostic {
  const enforcement = input.runtime === "claude-code"
    ? inspectClaude(input.cwd, input.applied, input.fs)
    : inspectLaunchBoundRuntime(input.runtime, input.applied);
  return {
    transport: { state: "healthy" },
    cwdRead: { state: cwdReadState(input.fs, input.cwd) },
    commandPath: { state: commandPathState(input.fs, input.runtime) },
    enforcement,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

export function renderPermissionDriftSummary(diagnostic: PermissionDriftDiagnostic): string {
  const axisLabel = diagnostic.enforcement.axis === "resource_trust"
    ? "resource trust"
    : diagnostic.enforcement.axis;
  const effective = typeof diagnostic.enforcement.effective === "object" && diagnostic.enforcement.effective !== null
    ? diagnostic.enforcement.effective.defaultMode
    : diagnostic.enforcement.effective;
  const pieces = [
    `transport: ${diagnostic.transport.state}`,
    `cwd/read: ${diagnostic.cwdRead.state}`,
    `command/PATH: ${diagnostic.commandPath.state}`,
    `${axisLabel}: ${diagnostic.enforcement.state.toUpperCase()}`,
  ];
  if (diagnostic.enforcement.expected) pieces.push(`expected=${diagnostic.enforcement.expected}`);
  if (effective) pieces.push(`effective=${effective}`);
  if (diagnostic.enforcement.sourcePath) pieces.push(`source=${diagnostic.enforcement.sourcePath}`);
  if (diagnostic.enforcement.reason) pieces.push(`reason=${diagnostic.enforcement.reason}`);
  return pieces.join(" · ");
}
