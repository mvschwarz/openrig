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
const refuse = (error: string, remedy: string): CodexFilesystemDecision => ({ ok: false, error: `${error}\nFix: ${remedy}` });
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
function ambiguousKeys(keys: string[]): Set<string> {
  const seen = new Set<string>(), ambiguous = new Set<string>();
  for (const key of keys.map(canonicalKey)) {
    if (seen.has(key)) ambiguous.add(key);
    seen.add(key);
  }
  return ambiguous;
}
const literalAbsolute = (key: string) => path.isAbsolute(key) && path.normalize(key) === key && !/[?*\[\]{}]/.test(key);
const nativeSelectors = new Set([":root", ":minimal", ":workspace_roots", ":tmpdir", ":slash_tmp"]);
const literalHomePath = (key: string) => key.startsWith("~/") && path.normalize(key) === key && !/[?*\[\]{}]/.test(key);

/** Compare only established flat coverage. Native expansion, inheritance and
 * unfamiliar syntax stay unknown; this is not a second sandbox implementation. */
function compareFilesystem(actual: unknown, permissions: CodexFilesystemPermissions): CodexFilesystemDecision {
  if (actual == null) return refuse("Rule permissions.openrig-seat.filesystem: the agent declares read/write/deny rules, but the effective Codex profile has no mapping.",
    "Select a Codex profile that retains the agent's filesystem rules, or deliberately change the agent's codex_permissions.");
  if (!isRecord(actual)) return unknown("Codex selected filesystem mapping has an unfamiliar representation");
  const entries = present(actual);
  if (!entries.length) return refuse("Rule permissions.openrig-seat.filesystem: the agent declares read/write/deny rules, but the effective Codex mapping is empty.",
    "Restore the intended filesystem mapping in the effective Codex profile before launching.");
  const authored = Object.fromEntries(Object.entries(permissions.filesystem).map(([key, value]) => [canonicalKey(key), value]));
  const effective = Object.fromEntries(entries.map(([key, value]) => [canonicalKey(key), value]));
  const authoredAmbiguous = ambiguousKeys(Object.keys(permissions.filesystem));
  const ambiguous = new Set([...authoredAmbiguous, ...ambiguousKeys(entries.map(([key]) => key))]);
  const at = (rules: Record<string, unknown>, key: string, extraAccess?: CodexFilesystemAccess): CodexFilesystemAccess | undefined => {
    if (ambiguous.has(key)) return undefined;
    if (isAccess(rules[key])) return rules[key];
    const fullRoot = rules[":root"] ?? (literalAbsolute(path.sep) ? rules[path.sep] : undefined);
    const rootAccess = isAccess(fullRoot) ? fullRoot : "deny";
    const ancestors = Object.keys(rules).filter(root => (literalAbsolute(root) || literalHomePath(root)) && key.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
      .sort((a, b) => b.length - a.length);
    const root = ancestors[0];
    const ancestorAccess = root ? rules[root] : rootAccess;
    // Native selectors/home paths can overlap authored literal paths or other
    // selectors. Do not infer a widening where an existing grant may cover it;
    // native expansion remains Codex's job, not another policy engine here.
    // Only the agent's own ambiguity can affect coverage of another key;
    // duplicate aliases introduced by a lower layer stay local to those aliases.
    // Non-root denies are restrictions; either full-root spelling is a
    // default that narrower grants may refine under Codex's native rules.
    const denyAncestor = root !== undefined && root !== path.sep && rules[root] === "deny";
    // Codex 0.167.2's Linux/macOS minimal defaults are system paths, not
    // these user-data roots. Other minimal coverage stays unexpanded.
    const outsideMinimal = literalAbsolute(key) && /^\/(?:home|Users)(?:\/|$)/i.test(key);
    const possibleCoverage = extraAccess !== undefined && !denyAncestor
      && (!isAccess(ancestorAccess) || accessRank[extraAccess] > accessRank[ancestorAccess])
      && (authoredAmbiguous.size > 0 || Object.entries(rules).some(([rule, access]) => rule !== ":root" && rule !== path.sep
        && !(rule === ":minimal" && outsideMinimal)
        && (nativeSelectors.has(key) || literalHomePath(key) || !literalAbsolute(rule))
        && isAccess(access) && accessRank[access] >= accessRank[extraAccess]));
    if (nativeSelectors.has(key)) return key !== ":root" && possibleCoverage ? undefined : rootAccess;
    if (!literalAbsolute(key) && !literalHomePath(key)) return undefined;
    if (key !== path.sep && possibleCoverage) return undefined;
    if (root) return isAccess(rules[root]) ? rules[root] : undefined;
    if (isAccess(fullRoot)) return fullRoot;
    if (literalHomePath(key)) return "deny";
    if (Object.keys(rules).some(rule => !literalAbsolute(rule) && rule !== ":minimal")) return undefined;
    // :minimal read cannot grant write; its native read coverage is not
    // enumerated here, so extra reads outside a literal ancestor stay unknown.
    if (rules[":minimal"] != null && !outsideMinimal) return rules[":minimal"] === "read" ? "read" : undefined;
    return "deny";
  };
  const checks: CodexFilesystemDecision[] = [];
  const unfamiliar = entries.some(([, value]) => !isAccess(value));
  for (const [key, value] of Object.entries(effective)) {
    if (!isAccess(value)) { checks.push(unknown("Codex returned an unfamiliar filesystem access value or nested mapping")); continue; }
    const expected = at(authored, key, value);
    if (expected === undefined) { checks.push(unknown(`Filesystem rule ${JSON.stringify(key)}: the effective configuration grants ${value}; agent coverage could not be compared.`)); continue; }
    if (accessRank[value] > accessRank[expected]) return refuse(
      `Filesystem rule ${JSON.stringify(key)}: agent coverage is at most ${expected}; a lower Codex layer (account or trusted project) grants ${value}.`,
      "Remove the conflicting lower-layer grant, or deliberately update the agent's codex_permissions to the intended access.");
    if (!(key in authored) && value === "read" && expected === "read" && !Object.keys(authored).some(root =>
      root === ":root" || (literalAbsolute(root) && literalAbsolute(key) && key.startsWith(root.endsWith(path.sep) ? root : root + path.sep)))) {
      checks.push(unknown(`Filesystem rule ${JSON.stringify(key)}: native minimal read coverage could not be compared.`));
    }
  }
  for (const [key, access] of Object.entries(authored)) {
    if (key in effective) continue;
    const remaining = at(effective, key);
    if (remaining !== undefined && accessRank[remaining] > accessRank[access] && !unfamiliar) return refuse(
      `Filesystem rule ${JSON.stringify(key)}: the agent requires ${access}; the effective Codex policy omits that restriction and grants ${remaining}.`,
      "Restore the agent's restriction in the effective Codex profile, or deliberately change the agent's codex_permissions.");
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
      // A fallback, not a forced choice. The effective selection and allowlists
      // below establish whether Codex actually applied the agent's profile.
      continue;
    }
    if (key === "allowedApprovalPolicies" && Array.isArray(value) && value.every(policy => typeof policy === "string")) {
      if (!value.includes(permissions.approval)) return refuse("Rule allowedApprovalPolicies: the managed allowlist excludes the agent's approval choice.",
        "Ask the managed-policy owner to allow the intended approval, or select an allowed approval for the agent.");
      continue;
    }
    if (key === "allowedPermissionProfiles" && isRecord(value)) {
      if (value[CODEX_SEAT_PERMISSION_PROFILE] === false) return refuse("Rule allowedPermissionProfiles: the managed allowlist explicitly excludes the agent's filesystem profile.",
        "Ask the managed-policy owner to allow the agent's filesystem profile, or select an allowed policy for the agent.");
      const entries = present(value);
      if (entries.every(([, allowed]) => typeof allowed === "boolean")) {
        if (value[CODEX_SEAT_PERMISSION_PROFILE] !== true) return refuse("Rule allowedPermissionProfiles: the managed allowlist does not include the agent's filesystem profile.",
          "Ask the managed-policy owner to allow the agent's filesystem profile, or select an allowed policy for the agent.");
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
  const requirements = compareRequirements(requirementsRead, permissions);
  if (!requirements.ok) return requirements;
  const checks: CodexFilesystemDecision[] = [requirements];
  if (!isRecord(configRead) || !isRecord(configRead.config)) return combine(...checks, unknown("Codex config/read did not return a recognized effective configuration"));
  const config = configRead.config;
  if (config.default_permissions == null || typeof config.default_permissions !== "string") checks.push(unknown("Codex permission selection is absent or has an unfamiliar representation"));
  else if (config.default_permissions !== CODEX_SEAT_PERMISSION_PROFILE) return refuse("Rule default_permissions: the agent selects its filesystem profile; the effective Codex configuration selects a different profile.",
    "Remove the conflicting account or trusted-project selection, or deliberately change the agent's codex_permissions.");
  if (typeof config.approval_policy !== "string" || !["never", "on-request", "untrusted"].includes(config.approval_policy)) checks.push(unknown("Codex approval selection is absent or unfamiliar"));
  else if (config.approval_policy !== permissions.approval) return refuse("Rule approval_policy: the effective Codex configuration conflicts with the agent's approval choice.",
    "Align the account, trusted-project or managed approval policy with the agent's intended approval choice.");
  if (config.permissions == null) return refuse("Rule permissions.openrig-seat: the agent selects a filesystem profile, but the effective Codex configuration has no profile mapping.",
    "Restore the selected profile in the effective Codex configuration before launching.");
  if (!isRecord(config.permissions)) return combine(...checks, unknown("Codex permission profiles have an unfamiliar representation"));
  const selected = config.permissions[CODEX_SEAT_PERMISSION_PROFILE];
  if (selected == null) return refuse("Rule permissions.openrig-seat: the agent selects a filesystem profile that is absent from the effective Codex configuration.",
    "Restore the selected profile in the effective Codex configuration before launching.");
  if (!isRecord(selected)) return combine(...checks, unknown("Codex selected profile has an unfamiliar representation"));
  if (!present(selected).length) return refuse("Rule permissions.openrig-seat: the agent selects filesystem read/write/deny rules, but the effective Codex profile is empty.",
    "Restore the selected profile's intended filesystem rules before launching.");
  const unfamiliarProfile = present(selected).some(([key]) => key !== "filesystem" && key !== "network" && key !== "description");
  if (unfamiliarProfile) checks.push(unknown("Codex returned an unfamiliar selected profile option"));
  if (!(unfamiliarProfile && selected.filesystem == null)) checks.push(compareFilesystem(selected.filesystem, permissions));
  const network = selected.network;
  if (!isRecord(network)) checks.push(unknown("Codex selected network policy could not be compared"));
  else {
    if (network.enabled === true && !permissions.network_access) return refuse("Rule network.enabled: the agent denies network access; the effective Codex profile allows it.",
      "Remove the conflicting lower-layer network grant, or deliberately enable network_access in the agent's codex_permissions.");
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
        ...codexFilesystemOverrides(request.permissions).flatMap(value => ["-c", value]),
        "-c", "features.plugins=false", "-c", "features.apps=false"] });
    if (!read.ok) return unknown(read.reason);
    return decideCodexFilesystemPolicy({ permissions: request.permissions, configRead: read.configRead, requirementsRead: read.requirementsRead });
  } catch { return unknown("Native Codex configuration reader failed"); }
}

export type CodexFilesystemVerifier = typeof verifyCodexFilesystemPolicy;
