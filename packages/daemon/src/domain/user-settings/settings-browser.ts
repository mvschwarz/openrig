import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";
import { SETTINGS_VALID_KEYS, type SettingsStore, type ResolvedSetting } from "./settings-store.js";
import { connectionsProjection, readConnectionConfiguration } from "../gateway/connections-projection.js";
import { DEFAULT_CONFIG } from "../gateway/slack/config.js";
import { projectionPath } from "../gateway/human-registry.js";
import { loadHostRegistry } from "../hosts/hosts-registry-reader.js";
import { DEFAULT_HEALTH_POLICY, validateHealthPolicy } from "../health-policy.js";

type Value = string | number | boolean | null;
type State = "available" | "missing" | "malformed" | "unavailable";
type Kind = "scalar" | "text" | "path" | "identity" | "url" | "names" | "paths" | "withheld";
export interface BrowserEntry {
  key: string;
  group: "general" | "slack" | "people" | "hosts" | "health";
  value: Value;
  defaultValue: Value;
  defaultKnown: boolean;
  subject?: string;
  source: "env" | "file" | "default" | "unreported" | "unavailable";
  visibility: "shown" | "withheld" | "unavailable";
  reason: string | null;
  scope: string;
  application: string;
}
interface BrowserSource { id: string; state: State; path: string | null; detail: string; }

/** Names are presentation policy, never a second setting registry or resolver. */
const PATHS = new Set(["db.path", "transcripts.path", "workspace.root", "workspace.slices_root",
  "workspace.steering_path", "workspace.specs_root", "workspace.projects_root", "workspace.catalog_path",
  "topology.root", "context.root", "skills.root", "policies.claude_compaction.message_file_path"]);
const IDENTITIES = new Set(["daemon.host", "host.name", "host.selected", "context.system_world",
  "ui.timezone", "agents.advisor_session", "agents.operator_session", "workspace.operator_seat_name",
  "workflow.exception_routing", "policies.idle_gate_qitem.auto_register"]);
const INSTRUCTIONS = new Set(["policies.claude_compaction.pre_compact_instruction",
  "policies.claude_compaction.compact_instruction", "policies.claude_compaction.message_inline",
  "policies.claude_compaction.post_restore_audit_instruction"]);
function kindFor(key: string): Kind {
  if (PATHS.has(key)) return "path";
  if (IDENTITIES.has(key)) return "identity";
  if (INSTRUCTIONS.has(key)) return "withheld";
  if (key === "files.allowlist" || key === "progress.scan_roots") return "paths";
  if (key === "recovery.provider_auth_env_allowlist" || key === "policies.idle_gate_qitem.opt_in_sessions") return "names";
  return "scalar";
}

/** Value/type policy first; credential and terminal-control checks are defense in depth.
 * Unknown objects and unreviewed strings are never serialized, even under an innocent key. */
function safeValue(value: unknown, kind: Kind, redact: (v: unknown) => string | null): { value: Value; reason: string | null } {
  const hidden = (reason: string) => ({ value: null, reason });
  if (value === null || value === undefined) return { value: null, reason: null };
  if (kind === "withheld") return hidden("Authored instruction contents withheld; inspect at the owning source.");
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return kind === "scalar" ? { value, reason: null } : hidden("Unexpected value type withheld.");
  }
  if (typeof value !== "string") return hidden("Unexpected value type withheld.");
  if (!value) return { value: "", reason: null };
  if (kind === "scalar") return hidden("Unreviewed string value withheld.");
  if (/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value) || redact(value) !== value || value.includes("[redacted]")
    || /(?:xox[baprs]-|xapp-|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16}|-----BEGIN [^-]*PRIVATE KEY|(?:bearer|password|secret|token)\s*[:=])/i.test(value)) {
    return hidden("Credential-bearing or unsafe text withheld.");
  }
  if (kind === "url") {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return hidden("Unsupported target URL withheld.");
      // Paths may contain opaque credentials too: show the address, never arbitrary URL components.
      return { value: url.origin, reason: url.username || url.password || url.search || url.hash || url.pathname !== "/"
        ? "URL credentials, path, query and fragment withheld." : null };
    } catch { return hidden("Invalid target URL withheld."); }
  }
  if (value.includes("://")) return hidden("URI contents withheld outside the target-address view.");
  if (kind === "path" && (!isAbsolute(value) && !value.startsWith("~/") && !/^[A-Za-z0-9_. /-]+$/.test(value))) {
    return hidden("Unrecognized path form withheld.");
  }
  if (kind === "path" && /[?#=]/.test(value)) return hidden("Potentially sensitive path components withheld.");
  if (kind === "identity" && !/^[A-Za-z0-9_.:@/+ -]*$/.test(value)) return hidden("Unexpected identity text withheld.");
  if (kind === "names" && !/^[A-Za-z0-9_.:@/, -]*$/.test(value)) return hidden("Unexpected name-list contents withheld.");
  if (kind === "paths" && !value.split(",").every((p) => /^[A-Za-z0-9_.-]+:(?:\/|~\/|\.\/)[^?=#]*$/.test(p.trim()))) {
    return hidden("Unexpected named-path contents withheld.");
  }
  return { value, reason: null };
}

/** File state only. Resolution/defaulting stays with each existing domain owner. */
function sourceFile(file: string): { state: State; bytes: string | null } {
  try { return { state: "available", bytes: readFileSync(file, "utf8") }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable", bytes: null }; }
}
function application(key: string): string {
  if (key === "ui.terminal.max_live_terminals") return "Legacy web client; unset resolver value, consumer fallback 2. No TUI limit implied.";
  if (key === "workflow.exception_routing") return "Unset leaves routing to workflow/class/host precedence; running route unverified.";
  if (key === "ui.timezone") return "Daemon-instance value; TUI display timezone is client-local and selected at launch.";
  if (key.startsWith("snapshots.periodic.")) return "Selected when the snapshot scheduler starts; running scheduler unverified.";
  if (key === "retention.enabled") return "Selected at daemon startup; running sweeper unverified.";
  if (key.startsWith("retention.")) return "Read on the retention sweep; last applied value unverified.";
  if (key.startsWith("policies.claude_compaction.")) return "Read by the compaction policy consumer; running action unverified.";
  if (key === "terminal.status_bar" || key.startsWith("runtime.")) return "Future launch behavior; existing sessions not verified.";
  return "Resolved configuration; running application unverified.";
}

/** Additive safe view of existing owners. No mutation, host probe, provider call or repair. */
export function settingsBrowser(store: SettingsStore, gateway: Record<string, unknown> | null = null, home = getOpenRigHome()) {
  const read = readConnectionConfiguration(home);
  const redact = read.text;
  const entries: BrowserEntry[] = [];
  const sources: BrowserSource[] = [];
  const safePath = (path: string) => safeValue(path, "path", redact).value as string | null;
  function add(key: string, group: BrowserEntry["group"], value: unknown, defaultValue: unknown,
    source: BrowserEntry["source"], kind: Kind = "scalar", scope = "Displayed daemon instance",
    applied = "Configured only; running application unverified.") {
    const v = safeValue(value, kind, redact);
    const d = safeValue(defaultValue, kind, redact);
    entries.push({ key, group, value: v.value, defaultValue: d.value, defaultKnown: defaultValue !== undefined && !["people", "hosts"].includes(group), source,
      visibility: source === "unavailable" ? "unavailable" : v.value === null && v.reason ? "withheld" : "shown",
      reason: v.reason ?? d.reason, scope, application: applied });
  }
  const file = sourceFile(store.configPath);
  let generalState = file.state;
  let resolved: Record<string, ResolvedSetting> | null = null;
  try {
    if (file.bytes !== null) {
      const raw: unknown = JSON.parse(file.bytes);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid object");
    }
  } catch { generalState = "malformed"; }
  if (generalState !== "malformed" && generalState !== "unavailable") {
    try { resolved = store.resolveAllWithSource(); }
    catch { generalState = "unavailable"; }
  }
  sources.push({ id: "general", state: generalState, path: safePath(store.configPath),
    detail: "Environment > file > derived default. Exact winning variable and rejected-override warnings are not reported by the resolver." });
  for (const key of SETTINGS_VALID_KEYS) {
    const r = resolved?.[key];
    add(key, "general", r?.value, r?.defaultValue, r?.source ?? "unavailable", kindFor(key),
      key === "ui.terminal.max_live_terminals" ? "Legacy web client" : "Displayed daemon instance", application(key));
  }
  if (resolved) {
    for (const host of store.listFeedHostSubscriptions()) {
      const key = "feed.subscriptions." + host.hostId + ".enabled";
      const r = store.resolveFeedHostSubscription(key)!;
      add(key, "general", r.value, r.defaultValue, r.source);
    }
  }

  const c = connectionsProjection(home, gateway, store, read);
  sources.push({ id: "slack", state: read.sourceState, path: safePath(read.configPath),
    detail: c.configuration ? (c.configuration.enabled ? "Enabled" : "Disabled") + "; applied " + c.running.applied + "; external reach unverified."
      : "Configuration unavailable; no disabled/default success inferred." });
  const slackKinds: Record<string, Kind> = { enabled: "scalar", inboundDestination: "identity",
    outboundDestinations: "names", sourceLabel: "text", channel: "identity", requiredScopes: "names",
    minimumLevelThatPosts: "identity", minimumLevelThatInterrupts: "identity" };
  for (const [key, kind] of Object.entries(slackKinds)) {
    const cfg = read.cfg as unknown as Record<string, unknown> | null;
    const defs = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const flatten = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : v;
    add("slack." + key, "slack", cfg ? flatten(cfg[key]) : null, flatten(defs[key]),
      cfg ? read.fields.includes(key) ? "file" : "default" : "unavailable", kind);
  }
  // #192: the channel map as one read-only line, "match: channel" per entry.
  add("slack.channelMap", "slack", read.cfg ? c.configuration!.channelMap.map((e) => `${e.match ?? "withheld"}: ${e.channel ?? "withheld"}`).join(", ") : null, "",
    read.cfg ? read.cfg.channelMap !== undefined ? "file" : "default" : "unavailable", "names");
  add("slack.credentialFile", "slack", read.cfg ? Boolean(read.cfg.secretsEnvFile) : null, false,
    read.cfg ? read.fields.includes("secretsEnvFile") ? "file" : "default" : "unavailable");
  entries.at(-1)!.reason = "Credential file reference presence only; reference and contents withheld.";
  for (const name of ["botToken", "appToken"] as const) {
    add("slack." + name, "slack", c.configuration?.[name], null, c.configuration ? "unreported" : "unavailable", "identity");
    entries.at(-1)!.defaultKnown = false;
    entries.at(-1)!.reason = "Credential resolution presence only; values and provenance withheld.";
  }

  const humanPath = projectionPath(home);
  const humanFile = sourceFile(humanPath);
  sources.push({ id: "people", state: c.registry.state === "available" ? "available"
    : humanFile.state === "available" ? "malformed" : humanFile.state, path: safePath(humanPath),
    detail: "Read-only registry; canonical fragments own identity. Per-field defaults are not reported. Registration does not prove delivery." });
  const subjectKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
  for (const h of c.humans) {
    // Stable opaque keys preserve refresh selection without reflecting authored identity contents.
    const prefix = "people." + h.browserKey + ".";
    const subject = safeValue(h.displayName, "text", redact).value as string | null;
    for (const [key, value] of Object.entries({ entityId: h.entityId, address: h.address, displayName: h.displayName,
      class: h.class, deliveryClass: h.deliveryClass, availability: h.availability, away: h.away, excluded: h.excluded })) {
      add(prefix + key, "people", value, null, "file", key === "away" || key === "excluded" ? "scalar" : key === "displayName" ? "text" : "identity");
      entries.at(-1)!.subject = subject ?? "Person";
    }
    h.bindings.forEach((b) => {
      for (const [key, value] of Object.entries(b)) {
        if (key === "browserKey") continue;
        add(prefix + "bindings." + b.browserKey + "." + key, "people", value, null, "file", key === "credentialReference" ? "scalar" : "identity");
        entries.at(-1)!.subject = subject ?? "Person";
        if (key === "credentialReference") entries.at(-1)!.reason = "Credential reference presence only; reference and contents withheld.";
      }
    });
  }

  const hostPath = join(home, "hosts.yaml");
  const hostFile = sourceFile(hostPath);
  const hosts = loadHostRegistry(hostPath);
  sources.push({ id: "hosts", state: hosts.ok ? "available" : hostFile.state === "available" ? "malformed" : hostFile.state,
    path: safePath(hostPath), detail: "Authored registered targets only; no connection or readiness probe." });
  if (hosts.ok) hosts.registry.hosts.forEach((host) => {
    const prefix = "hosts." + subjectKey(host.id) + ".";
    const optional = host.transport === "http" ? { bearer_env: null, bearer_file: null } : { user: null };
    for (const [key, value] of Object.entries({ hostId: null, notes: null, ...optional, ...host })) {
      const credential = key === "bearer_env" || key === "bearer_file";
      add(prefix + key, "hosts", credential ? Boolean(value) : value, null, "file",
        credential ? "scalar" : key === "notes" ? "withheld" : key === "url" ? "url" : "identity",
        "Registered target metadata; displayed instance owns this declaration");
      entries.at(-1)!.subject = safeValue(host.id, "identity", redact).value as string | null ?? "Target";
      if (credential) entries.at(-1)!.reason = "Authentication reference presence only; reference and contents withheld.";
      if (key === "notes") entries.at(-1)!.reason = "Free-form notes withheld.";
    }
  });

  const healthPath = join(home, "health", "policy.json");
  const healthFile = sourceFile(healthPath);
  let healthState = healthFile.state;
  let health: typeof DEFAULT_HEALTH_POLICY | null = null;
  try {
    if (healthFile.state === "missing") health = DEFAULT_HEALTH_POLICY;
    else if (healthFile.bytes !== null) health = validateHealthPolicy(JSON.parse(healthFile.bytes));
  } catch { healthState = "malformed"; }
  sources.push({ id: "health", state: healthState, path: safePath(healthPath),
    detail: "Validated health policy. Context-pressure settings are resolved separately; no evaluation or notification." });
  function policyLeaves(value: unknown, defaults: unknown, prefix = "health.policy") {
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      for (const [key, d] of Object.entries(defaults)) policyLeaves((value as Record<string, unknown> | null)?.[key], d, prefix + "." + key);
    } else {
      const flatten = (v: unknown) => Array.isArray(v) ? v.join(", ") : v;
      add(prefix, "health", flatten(value), flatten(defaults), health ? healthFile.state === "missing" ? "default" : "file" : "unavailable",
        typeof defaults === "string" || defaults === null || Array.isArray(defaults) ? "names" : "scalar");
    }
  }
  policyLeaves(health, DEFAULT_HEALTH_POLICY);
  return { observedAt: new Date().toISOString(), home: safePath(home), sources, entries,
    exclusions: [
      "Rig/project/workflow/seat declarations remain in their owning Specs and rig views.",
      "Provider credentials and private runtime files are outside CONFIG.",
      "Arbitrary unregistered JSON keys are unsupported.",
      "Slack queueUrl is unused; retired alertTag is not a supported control.",
      "Instruction bodies, free notes, credential contents and sensitive URL components are withheld.",
    ],
    readOnly: true };
}
