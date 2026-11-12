import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CODEX_SEAT_PERMISSION_PROFILE,
  codexFilesystemOverrides,
  codexFilesystemProfile,
  type CodexFilesystemPermissions,
} from "./codex-member-permissions.js";
import { readCodexConfiguration } from "./codex-network-default.js";

type Decision = { ok: true } | { ok: false; error: string };
const refuse = (error: string): Decision => ({ ok: false, error });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// 0.167.2 serializes these absent profile options as null. Remove only these
// known null defaults; preserve every nonnull or unknown entry for comparison.
const PROFILE_NULL_DEFAULTS = ["description", "extends", "workspace_roots"];
const NETWORK_NULL_DEFAULTS = ["allow_local_binding", "allow_upstream_proxy", "dangerously_allow_all_unix_sockets",
  "dangerously_allow_non_loopback_proxy", "domains", "enable_socks5", "enable_socks5_udp", "mitm", "mode",
  "proxy_url", "socks_url", "unix_sockets"];
const omitNullDefaults = (record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key, value]) => value !== null || !keys.includes(key)));

// Native app-server 0.167.2 ConfigRequirements fields that do not select or alter
// filesystem, network or approval behavior. Unknown fields are not assumed safe.
const UNRELATED_REQUIREMENTS = new Set([
  "modelProvider", "modelProviders", "allowedLoginMethods", "cliAuthCredentialsStore", "chatgptBaseUrl",
  "additionalDeveloperInstructions", "allowedWindowsSandboxImplementations", "allowedWebSearchModes",
  "allowManagedHooksOnly", "allowBrowserAndComputerUse", "allowAppshots", "allowRemoteControl",
  "computerUse", "browserUse", "inAppBrowser", "hooks", "enforceResidency", "models", "sqliteHome",
  "logDir", "modelCatalogJson", "checkForUpdateOnStartup", "allowLoginShell", "feedback", "otel",
]);
const POLICY_REQUIREMENTS = new Set([
  "allowedApprovalsReviewers", "allowedSandboxModes", "allowedPermissionProfiles", "defaultPermissions",
  "featureRequirements", "network", "application", "autoReview",
]);

/** Checks native configuration selection and merging, not native enforcement.
 * Managed policy is never changed to make this check pass. Policy combinations
 * not established by this opt-in contract are refused before a seat is launched. */
export function decideCodexFilesystemPolicy(request: {
  permissions: CodexFilesystemPermissions;
  configRead: unknown;
  requirementsRead: unknown;
}): Decision {
  const { permissions, configRead, requirementsRead } = request;
  if (!isRecord(configRead) || !isRecord(configRead.config)) {
    return refuse("Codex config/read did not return a recognized effective configuration");
  }
  const config = configRead.config;
  if (config.sandbox_mode != null || config.sandbox_workspace_write != null) {
    return refuse("Codex legacy sandbox settings conflict with the seat filesystem policy; remove them from the loaded account/project configuration");
  }
  if (config.profile != null) return refuse("A named Codex configuration profile cannot be combined with a seat filesystem policy");
  if (config.default_permissions !== CODEX_SEAT_PERMISSION_PROFILE) {
    return refuse("Codex did not select the seat filesystem permission profile");
  }
  if (config.approval_policy !== permissions.approval) {
    return refuse("Codex effective approval policy differs from the seat selection");
  }
  if (!isRecord(config.permissions) || !isRecord(config.permissions[CODEX_SEAT_PERMISSION_PROFILE])) {
    return refuse("Codex did not return the selected filesystem permission profile");
  }
  const selected = omitNullDefaults(config.permissions[CODEX_SEAT_PERMISSION_PROFILE], PROFILE_NULL_DEFAULTS);
  if (isRecord(selected.filesystem)) selected.filesystem = omitNullDefaults(selected.filesystem, ["glob_scan_max_depth"]);
  if (isRecord(selected.network)) selected.network = omitNullDefaults(selected.network, NETWORK_NULL_DEFAULTS);
  if (!isRecord(selected.filesystem) || Object.keys(selected.filesystem).length === 0
    || !Object.values(selected.filesystem).every(access => access === "read" || access === "write" || access === "deny")) {
    return refuse("Codex selected filesystem mapping is empty or unrecognized");
  }
  if (!isDeepStrictEqual(selected, codexFilesystemProfile(permissions))) {
    return refuse("Codex selected permission profile differs from the seat policy; remove lower-layer additions or conflicting settings");
  }
  if (!isRecord(requirementsRead) || !("requirements" in requirementsRead)
    || Object.keys(requirementsRead).some(key => key !== "requirements" && key !== "supportsIndependentSpeedModes")) {
    return refuse("Codex configRequirements/read returned an unrecognized response");
  }
  const requirements = requirementsRead.requirements;
  if (requirements === null) return { ok: true };
  if (!isRecord(requirements)) return refuse("Codex managed requirements are unrecognized");
  for (const [key, value] of Object.entries(requirements)) {
    if (value == null) continue;
    if (UNRELATED_REQUIREMENTS.has(key)) continue;
    if (key === "allowedApprovalPolicies") {
      if (Array.isArray(value) && value.every(policy => policy === "never" || policy === "on-request" || policy === "untrusted")
        && value.includes(permissions.approval)) continue;
      return refuse("Codex managed approval requirements do not establish the seat approval choice");
    }
    if (!POLICY_REQUIREMENTS.has(key)) return refuse("Codex returned an unsupported managed requirement; seat filesystem policy cannot be verified");
    return refuse(`Codex managed ${key} cannot yet be combined with a seat filesystem policy`);
  }
  return { ok: true };
}

export async function verifyCodexFilesystemPolicy(request: {
  permissions: CodexFilesystemPermissions;
  cwd: string;
  codexHome?: string;
  launchPath?: string;
}): Promise<Decision> {
  if (!request.codexHome || !isAbsolute(request.codexHome) || /[\0\r\n]/.test(request.codexHome)) {
    return refuse("Seat filesystem policy requires a known absolute CODEX_HOME; configure member/rig env.CODEX_HOME or daemon CODEX_HOME");
  }
  try {
    const read = await readCodexConfiguration({ cwd: request.cwd, codexHome: request.codexHome, launchPath: request.launchPath,
      args: ["-c", `approval_policy=${JSON.stringify(request.permissions.approval)}`,
        ...codexFilesystemOverrides(request.permissions).flatMap(value => ["-c", value])] });
    if (!read.ok) return refuse(`Cannot verify Codex seat filesystem policy: ${read.reason}`);
    return decideCodexFilesystemPolicy({ permissions: request.permissions,
      configRead: read.configRead, requirementsRead: read.requirementsRead });
  } catch {
    return refuse("Native Codex configuration reader failed; seat filesystem policy was not verified");
  }
}

export type CodexFilesystemVerifier = typeof verifyCodexFilesystemPolicy;
