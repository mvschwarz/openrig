import path from "node:path";
import os from "node:os";
import {
  CODEX_SEAT_PERMISSION_PROFILE,
  codexFilesystemOverrides,
  type CodexFilesystemAccess,
  type CodexFilesystemPermissions,
} from "./codex-member-permissions.js";
import { readCodexConfiguration } from "./codex-network-default.js";

export type CodexFilesystemDecision =
  | { ok: true; verified: true }
  | { ok: true; verified: false; reason: string }
  | { ok: false; error: string };
const verified = (): CodexFilesystemDecision => ({ ok: true, verified: true });
const refuse = (error: string): CodexFilesystemDecision => ({ ok: false, error });
const unknown = (reason: string): CodexFilesystemDecision => ({ ok: true, verified: false, reason });
export const codexPolicyWarning = (reason: string): string => `policy not verified: ${reason}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// Null means absent, including options added by a later native reader.
const present = (record: Record<string, unknown>) => Object.entries(record).filter(([, value]) => value != null);
function combine(...checks: CodexFilesystemDecision[]): CodexFilesystemDecision {
  let inconclusive: Extract<CodexFilesystemDecision, { verified: false }> | undefined;
  for (const check of checks) {
    if (!check.ok) return check;
    if (!check.verified) inconclusive ??= check;
  }
  return inconclusive ?? verified();
}
const accessRank = { deny: 0, read: 1, write: 2 };
const isAccess = (value: unknown): value is CodexFilesystemAccess => value === "read" || value === "write" || value === "deny";
const canonicalKey = (key: string) => key === ":project_roots" ? ":workspace_roots" : key;
const literalAbsolute = (key: string) => path.isAbsolute(key) && path.normalize(key) === key && !/[?*\[\]{}]/.test(key);
const nativeSelectors = new Set([":root", ":minimal", ":workspace_roots", ":tmpdir", ":slash_tmp"]);
const literalHomePath = (key: string) => key.startsWith("~/") && path.normalize(key) === key && !/[?*\[\]{}]/.test(key);

/** Compare only established flat coverage. Native expansion, inheritance and
 * unfamiliar syntax stay unknown; this is not a second sandbox implementation. */
function compareFilesystem(actual: unknown, permissions: CodexFilesystemPermissions): CodexFilesystemDecision {
  if (actual == null) return refuse("Codex did not return the selected filesystem mapping");
  if (!isRecord(actual)) return unknown("Codex selected filesystem mapping has an unfamiliar representation");
  const entries = present(actual);
  if (!entries.length) return refuse("Codex selected filesystem mapping is empty");
  const authored = Object.fromEntries(Object.entries(permissions.filesystem).map(([key, value]) => [canonicalKey(key), value]));
  const effective = Object.fromEntries(entries.map(([key, value]) => [canonicalKey(key), value]));
  const ambiguous = new Set<string>();
  for (const keys of [Object.keys(permissions.filesystem), entries.map(([key]) => key)]) {
    const seen = new Set<string>();
    for (const key of keys.map(canonicalKey)) {
      if (seen.has(key)) ambiguous.add(key);
      seen.add(key);
    }
  }
  const at = (rules: Record<string, unknown>, key: string): CodexFilesystemAccess | undefined => {
    if (ambiguous.has(key)) return undefined;
    if (isAccess(rules[key])) return rules[key];
    const fullRoot = rules[":root"] ?? (literalAbsolute(path.sep) ? rules[path.sep] : undefined);
    // These are known native grants, not unfamiliar syntax. A newly merged
    // selector expands the authored policy unless an authored full-root grant
    // already covers it. Minimal read does not authorize full-root read.
    if (nativeSelectors.has(key)) return isAccess(fullRoot) ? fullRoot : "deny";
    if (!literalAbsolute(key) && !literalHomePath(key)) return undefined;
    const ancestors = Object.keys(rules).filter(root => (literalAbsolute(root) || literalHomePath(root)) && key.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
      .sort((a, b) => b.length - a.length);
    const root = ancestors[0];
    if (root) return isAccess(rules[root]) ? rules[root] : undefined;
    if (isAccess(fullRoot)) return fullRoot;
    if (literalHomePath(key)) return "deny";
    if (Object.keys(rules).some(rule => !literalAbsolute(rule) && rule !== ":minimal")) return undefined;
    // :minimal read cannot grant write; its native read coverage is not
    // enumerated here, so extra reads outside a literal ancestor stay unknown.
    if (rules[":minimal"] != null) return rules[":minimal"] === "read" ? "read" : undefined;
    return "deny";
  };
  const checks: CodexFilesystemDecision[] = [];
  const unfamiliar = entries.some(([, value]) => !isAccess(value));
  for (const [key, value] of Object.entries(effective)) {
    if (!isAccess(value)) { checks.push(unknown("Codex returned an unfamiliar filesystem access value or nested mapping")); continue; }
    const expected = at(authored, key);
    if (expected === undefined) { checks.push(unknown("Filesystem rule coverage could not be compared")); continue; }
    if (accessRank[value] > accessRank[expected]) return refuse("Codex selected filesystem policy widens the seat's access");
    if (!(key in authored) && value === "read" && expected === "read" && !Object.keys(authored).some(root =>
      root === ":root" || (literalAbsolute(root) && literalAbsolute(key) && key.startsWith(root.endsWith(path.sep) ? root : root + path.sep)))) {
      checks.push(unknown("Native minimal read coverage could not be compared"));
    }
  }
  for (const [key, access] of Object.entries(authored)) {
    if (key in effective) continue;
    const remaining = at(effective, key);
    if (remaining !== undefined && accessRank[remaining] > accessRank[access] && !unfamiliar) return refuse("Codex selected filesystem policy omits a seat restriction");
    checks.push(unknown("An authored filesystem rule is absent from the effective mapping"));
  }
  return combine(...checks);
}

const UNRELATED_REQUIREMENTS = new Set([
  "modelProvider", "modelProviders", "allowedLoginMethods", "cliAuthCredentialsStore", "chatgptBaseUrl",
  "additionalDeveloperInstructions", "allowedWindowsSandboxImplementations", "allowedWebSearchModes",
  "allowManagedHooksOnly", "allowBrowserAndComputerUse", "allowAppshots", "allowRemoteControl",
  "computerUse", "browserUse", "inAppBrowser", "hooks", "enforceResidency", "models", "sqliteHome",
  "logDir", "modelCatalogJson", "checkForUpdateOnStartup", "allowLoginShell", "feedback", "otel",
  // Legacy sandbox allowlists do not select a permission profile.
  "allowedSandboxModes",
]);
function compareRequirements(read: unknown, permissions: CodexFilesystemPermissions): CodexFilesystemDecision {
  if (!isRecord(read) || !("requirements" in read)) return unknown("Codex configRequirements/read returned an unrecognized response");
  const checks: CodexFilesystemDecision[] = [];
  if (present(read).some(([key]) => key !== "requirements" && key !== "supportsIndependentSpeedModes")) checks.push(unknown("Codex returned an unfamiliar requirements response field"));
  if (read.requirements == null) return combine(...checks);
  if (!isRecord(read.requirements)) return unknown("Codex managed requirements have an unfamiliar shape");
  for (const [key, value] of present(read.requirements)) {
    if (UNRELATED_REQUIREMENTS.has(key)) continue;
    if (key === "defaultPermissions" && typeof value === "string") {
      if (value !== CODEX_SEAT_PERMISSION_PROFILE) return refuse("Codex managed default selects a different permission profile");
      continue;
    }
    if (key === "allowedApprovalPolicies" && Array.isArray(value) && value.every(policy => typeof policy === "string")) {
      if (!value.includes(permissions.approval)) return refuse("Codex managed approval allowlist excludes the seat choice");
      continue;
    }
    if (key === "allowedPermissionProfiles" && isRecord(value)) {
      if (value[CODEX_SEAT_PERMISSION_PROFILE] === false) return refuse("Codex managed profile allowlist excludes the seat choice");
      const entries = present(value);
      if (entries.every(([, allowed]) => typeof allowed === "boolean")) {
        if (value[CODEX_SEAT_PERMISSION_PROFILE] !== true) return refuse("Codex managed profile allowlist excludes the seat choice");
        continue;
      }
    }
    checks.push(unknown("Codex returned an unsupported managed requirement"));
  }
  return combine(...checks);
}

/** Positive conflicts refuse; unavailable evidence never replaces the authored
 * invocation or edits managed policy. Unknowns cannot mask a known conflict. */
export function decideCodexFilesystemPolicy(request: {
  permissions: CodexFilesystemPermissions; configRead: unknown; requirementsRead: unknown;
}): CodexFilesystemDecision {
  const { permissions, configRead, requirementsRead } = request;
  const checks = [compareRequirements(requirementsRead, permissions)];
  if (!isRecord(configRead) || !isRecord(configRead.config)) return combine(...checks, unknown("Codex config/read did not return a recognized effective configuration"));
  const config = configRead.config;
  if (config.default_permissions != null && typeof config.default_permissions !== "string") checks.push(unknown("Codex permission selection has an unfamiliar representation"));
  else if (config.default_permissions !== CODEX_SEAT_PERMISSION_PROFILE) return refuse("Codex did not select the seat filesystem permission profile");
  if (config.approval_policy != null && typeof config.approval_policy !== "string") checks.push(unknown("Codex approval selection has an unfamiliar representation"));
  else if (config.approval_policy !== permissions.approval) return refuse("Codex effective approval policy differs from the seat selection");
  if (config.permissions == null) return refuse("Codex did not return the selected filesystem permission profile");
  if (!isRecord(config.permissions)) return combine(...checks, unknown("Codex permission profiles have an unfamiliar representation"));
  const selected = config.permissions[CODEX_SEAT_PERMISSION_PROFILE];
  if (selected == null) return refuse("Codex did not return the selected filesystem permission profile");
  if (!isRecord(selected)) return combine(...checks, unknown("Codex selected profile has an unfamiliar representation"));
  if (!present(selected).length) return refuse("Codex selected permission profile is empty");
  if (present(selected).some(([key]) => key !== "filesystem" && key !== "network" && key !== "description")) checks.push(unknown("Codex returned an unfamiliar selected profile option"));
  checks.push(compareFilesystem(selected.filesystem, permissions));
  const network = selected.network;
  if (!isRecord(network)) checks.push(unknown("Codex selected network policy could not be compared"));
  else {
    if (network.enabled === true && !permissions.network_access) return refuse("Codex selected permission profile widens network access");
    if (typeof network.enabled !== "boolean") checks.push(unknown("Codex selected network access is unfamiliar"));
    if (present(network).some(([key]) => key !== "enabled")) checks.push(unknown("Codex returned unfamiliar network options"));
  }
  return combine(...checks);
}

/** Pin the normal account home for this opt-in path so the reader and dispatch
 * do not accidentally use different pane-shell defaults. */
export function resolveCodexFilesystemHome(home?: string, normalHome?: string): string | undefined {
  try {
    const resolved = home ?? process.env.CODEX_HOME ?? path.join(normalHome ?? os.homedir(), ".codex");
    return resolved && path.isAbsolute(resolved) && !/[\0\r\n]/.test(resolved) ? resolved : undefined;
  } catch { return undefined; }
}

export async function verifyCodexFilesystemPolicy(request: {
  permissions: CodexFilesystemPermissions; cwd: string; codexHome?: string;
  launchPath?: string; launchWrapper?: readonly string[]; codexConfigProfile?: string;
}): Promise<CodexFilesystemDecision> {
  if (request.launchWrapper?.length) return unknown("launch_wrapper may change the effective home or configuration; the unwrapped reader cannot certify it");
  // app-server does not expose this CLI profile layer on the supported path.
  // Keep -p on the actual invocation and leave enforcement to Codex.
  if (request.codexConfigProfile?.trim()) return unknown("the native reader cannot load the selected codex_config_profile");
  const codexHome = resolveCodexFilesystemHome(request.codexHome);
  if (!codexHome) return unknown("the actual Codex account home could not be resolved");
  try {
    const read = await readCodexConfiguration({ cwd: request.cwd, codexHome, launchPath: request.launchPath,
      args: ["-c", `approval_policy=${JSON.stringify(request.permissions.approval)}`,
        ...codexFilesystemOverrides(request.permissions).flatMap(value => ["-c", value])] });
    if (!read.ok) return unknown(read.reason);
    return decideCodexFilesystemPolicy({ permissions: request.permissions, configRead: read.configRead, requirementsRead: read.requirementsRead });
  } catch { return unknown("Native Codex configuration reader failed"); }
}

export type CodexFilesystemVerifier = typeof verifyCodexFilesystemPolicy;
