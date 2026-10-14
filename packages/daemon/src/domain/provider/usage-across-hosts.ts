// Slice 01 (OPR.0.7.0.1) — usage windows across registered hosts. This daemon joins its own read model with each
// registered http host's served GET /api/provider/status, over the shared bearer transport (bearers never leave
// this daemon). Each host's rows are kept verbatim inside an observation stamped with the registry host id and the
// time this daemon read it: nothing is re-aged, recomputed, merged or summed. Rows are grouped by the allowance
// identity each host already keys them by; the groups say whether hosts saw the same allowance, saw it disagree,
// or can't be linked. Every selected host appears with its transport status and whether it serves usage windows.
//
// Reading the view never starts a native read: it only GETs memory-served routes. A refresh across hosts is a
// separate, explicit call: one bounded leg per (host, provider) to that host's own refresh route, joined by
// overlapping requests here and again by the host's own coalescing. A failed leg is recorded here, in memory,
// beside the host's kept observations.

import type { AggregatedPayload, PerHostStatus } from "../hosts/fanout-contract.js";
import { LOCAL_HOST_ID, resolvesToLocalHost } from "../hosts/fanout-contract.js";
import type { HostEntry, HostRegistryLoadResult, HttpHostEntry } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest, resolveBearer, type RemoteJsonResult } from "../hosts/remote-daemon-http.js";
import { claudeUsageIdentityKey } from "./claude-usage-windows.js";
import { codexUsageIdentityKey } from "./codex-usage-windows.js";
import type {
  ClaudeUsageIdentity,
  FourBlockReadModel,
  ProviderKind,
  ProviderUsageAllowance,
  SeatConfiguredAccount,
  UsageAllowanceIdentity,
} from "./provider-types.js";
import { USAGE_CLOCK_TOLERANCE_MS } from "./usage-windows.js";

/** Reading a host's served model is an ordinary read: the same 5 s class as the read-through and the feed. */
export const USAGE_HOSTS_READ_TIMEOUT_MS = 5_000;
export const USAGE_HOSTS_READ_CONCURRENCY = 4;

/** The whole view answers within this, whatever the registry's size: hosts not heard from by then are listed as such,
 *  and the rest are served. One host takes at most 10 s (5 s status, then 5 s settings when it's off or older), so the
 *  first four hosts always fit; a caller waiting 20 s has 5 s left for this host's own read and the transfer. */
export const USAGE_HOSTS_VIEW_DEADLINE_MS = 15_000;

/** The largest answer read from a host (status, settings or refresh), stopped at the bound and never parsed. A status
 *  answer with both providers and a few dozen seats is tens of kilobytes; 1 MiB leaves room for hundreds of seats. */
export const USAGE_HOSTS_MAX_BYTES = 1024 * 1024;

/** The deepest nesting accepted in a host's answer. Today's deepest is about seven levels (a status answer's usage row,
 *  window, disagreeing seat); past 32 the answer is malformed, and that host is unavailable. */
export const USAGE_HOSTS_MAX_DEPTH = 32;

/** What replaces any string from a host that contains the bearer configured for that host. */
export const BEARER_REDACTED = "[redacted: contained this host's bearer]";

/** A refresh leg waits for the host's own bounded native read plus stopping what it started (Codex 35 s + ~8 s;
 *  Claude's auth status 10 s + ~3 s), with a margin for the network. Never the 5 s read class. */
export const REMOTE_USAGE_REFRESH_DEADLINE_MS: Record<ProviderKind, number> = { codex: 50_000, claude: 20_000 };

export type HostUsageCoverage = "served" | "off" | "older" | "unavailable";

export interface UsageRefreshLeg {
  hostId: string;
  provider: ProviderKind;
  at: string;
  outcome: "ok" | "failed";
  /** True when this request joined a leg already running, here or at the host. */
  coalesced: boolean;
  reason?: string;
  detail?: string;
}

export interface UsageHostStatus extends PerHostStatus {
  /** Whether this host serves usage windows, apart from whether it answered. */
  usage: HostUsageCoverage;
  usageReason?: string;
  /** When this daemon read the host; null when it couldn't be read. */
  readAt: string | null;
  /** The last refresh leg this daemon ran to the host, per provider (kept in memory). */
  lastRefresh?: Partial<Record<ProviderKind, UsageRefreshLeg>>;
}

export interface UsageObservation {
  hostId: string;
  readAt: string;
  /** The host's own served row, verbatim. */
  row: ProviderUsageAllowance;
}

/**
 * Between the observations inside one group. single: one host observed it. same: several hosts observed one allowance
 * (each observation kept; never summed). conflict: several hosts observed one allowance and disagree about a window's
 * reset. unknown: the identity is unresolved, or one host's observation of an id can't be linked to other hosts'
 * observations of it (the notes name them).
 */
export type UsageLinkage = "single" | "same" | "conflict" | "unknown";

export interface UsageAllowanceGroup {
  provider: ProviderKind;
  /** The allowance identity key the hosts key their rows by; null when unresolved. */
  key: string | null;
  linkage: UsageLinkage;
  observations: UsageObservation[];
  notes: string[];
}

export interface UsageAcrossHosts extends AggregatedPayload<UsageAllowanceGroup> {
  hosts: UsageHostStatus[];
  /** Registry entries that name this daemon itself, so not read twice. */
  skipped: Array<{ hostId: string; reason: string }>;
  registry: { state: "read" | "absent" | "unreadable"; note?: string };
  /** Each host's configured seat accounts, verbatim; never linked to an allowance. */
  seatAccounts: Array<{ hostId: string; seats: SeatConfiguredAccount[] }>;
  asOf: string;
}

// ——— The grouping rule (pure) ———

/** The key a host keyed this row by (the same functions the hosts use); null when unresolved or never read. */
export function allowanceKey(row: ProviderUsageAllowance): string | null {
  if (!row.identity) return null;
  return row.provider === "codex"
    ? codexUsageIdentityKey(row.identity as UsageAllowanceIdentity)
    : claudeUsageIdentityKey(row.identity as ClaudeUsageIdentity);
}

/**
 * Which observations may be linked across hosts. Claude's key already includes the email. Codex's doesn't: within
 * one host a single login is read, but across hosts the same account or workspace id can come with different login
 * emails, and the source can't tell one allowance from a workspace whose members have their own limits. So across
 * hosts a Codex observation links only under the same login email too; the rest stay apart as unknown linkage. A
 * missing (or empty) email is no evidence of the same login, so an observation without one links to nothing on
 * another host.
 */
export function crossHostLinkKey(row: ProviderUsageAllowance, key: string, hostId: string): string {
  if (row.provider !== "codex") return key;
  const email = (row.identity as UsageAllowanceIdentity).email;
  return email ? `${key}\u0000email:${email}` : `${key}\u0000host:${hostId}`;
}

function idLabel(row: ProviderUsageAllowance): string {
  const id = row.identity as UsageAllowanceIdentity;
  return `${id.accountId !== null ? `account ${id.accountId}` : `workspace ${id.workspaceId}`}, bucket ${id.limitId}`;
}

/** Fresh observations of one window from different hosts whose resets are more than the clock tolerance apart. */
function conflicts(observations: UsageObservation[]): string[] {
  const byWindow = new Map<string, Array<{ hostId: string; resetsAt: string; ms: number }>>();
  for (const o of observations) {
    for (const w of o.row.windows) {
      const ms = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
      if (w.freshness !== "fresh" || !Number.isFinite(ms)) continue;
      byWindow.set(w.window, [...(byWindow.get(w.window) ?? []), { hostId: o.hostId, resetsAt: w.resetsAt!, ms }]);
    }
  }
  const notes: string[] = [];
  for (const [window, seen] of byWindow) {
    if (new Set(seen.map((s) => s.hostId)).size < 2) continue;
    const times = seen.map((s) => s.ms);
    if (Math.max(...times) - Math.min(...times) <= USAGE_CLOCK_TOLERANCE_MS) continue;
    notes.push(`window ${window}: the hosts report resets more than ${USAGE_CLOCK_TOLERANCE_MS / 1000} s apart (`
      + `${seen.map((s) => `${s.hostId} ${s.resetsAt}`).join("; ")}); every observation is kept and none is chosen`);
  }
  return notes;
}

export function groupUsageAcrossHosts(observations: UsageObservation[]): UsageAllowanceGroup[] {
  const unlinked: UsageAllowanceGroup[] = [];
  const linked = new Map<string, { key: string; observations: UsageObservation[] }>();
  for (const o of observations) {
    const key = allowanceKey(o.row);
    if (key === null) {
      unlinked.push({ provider: o.row.provider, key: null, linkage: "unknown", observations: [o], notes: [] });
      continue;
    }
    const link = crossHostLinkKey(o.row, key, o.hostId);
    const group = linked.get(link) ?? { key, observations: [] };
    group.observations.push(o);
    linked.set(link, group);
  }
  // Groups that share an allowance key but not a link key: the same id under different logins on different hosts.
  const linksPerKey = new Map<string, Array<{ key: string; observations: UsageObservation[] }>>();
  for (const g of linked.values()) linksPerKey.set(g.key, [...(linksPerKey.get(g.key) ?? []), g]);

  const groups: UsageAllowanceGroup[] = [];
  for (const [key, siblings] of [...linksPerKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const g of siblings) {
      const provider = g.observations[0]!.row.provider;
      const hosts = new Set(g.observations.map((o) => o.hostId));
      const notes: string[] = [];
      let linkage: UsageLinkage = hosts.size > 1 ? "same" : "single";
      const others = siblings.filter((s) => s !== g).flatMap((s) => s.observations);
      if (others.length > 0) {
        // The link to those other hosts is unknown; the hosts inside this group still share one login and id.
        if (hosts.size === 1) linkage = "unknown";
        const email = (row: ProviderUsageAllowance) => (row.identity as UsageAllowanceIdentity).email;
        const how = !email(g.observations[0]!.row)
          ? "; no login email was reported here"
          : others.some((o) => !email(o.row)) ? " under another login email or with none reported" : " under another login email";
        notes.push(`the same Codex ${idLabel(g.observations[0]!.row)} is also observed on ${[...new Set(others.map((o) => o.hostId))].join(", ")}`
          + `${how}; the source can't tell one allowance from a workspace whose members have their own limits, so these `
          + "observations are not merged");
      }
      const conflict = conflicts(g.observations);
      if (conflict.length > 0) {
        linkage = "conflict";
        notes.push(...conflict);
      }
      groups.push({ provider, key, linkage, observations: g.observations, notes });
    }
  }
  return [...groups, ...unlinked];
}

// ——— Reading the hosts ———

export interface UsageHostsDeps {
  loadRegistry: () => HostRegistryLoadResult;
  selfHostId: string | null;
  /** Narrow the remote hosts to these registry ids (this daemon is always included). */
  only?: string[];
  lastRefresh?: (hostId: string) => Partial<Record<ProviderKind, UsageRefreshLeg>> | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  readTimeoutMs?: number;
  viewDeadlineMs?: number;
  concurrency?: number;
  now?: () => string;
}

export type HostSelection =
  | { ok: true; remotes: HostEntry[]; skipped: UsageAcrossHosts["skipped"]; registry: UsageAcrossHosts["registry"] }
  | { ok: false; error: string };

/** The registry hosts a call covers: every entry (ssh ones are reported, not read), minus this daemon itself. */
export function selectUsageHosts(deps: Pick<UsageHostsDeps, "loadRegistry" | "selfHostId" | "only">): HostSelection {
  const loaded = deps.loadRegistry();
  if (!loaded.ok) {
    if (deps.only && deps.only.length > 0) return { ok: false, error: `no host registry to select hosts from: ${loaded.error}` };
    const absent = loaded.error.startsWith("host registry not found");
    return {
      ok: true,
      remotes: [],
      skipped: [],
      registry: absent
        ? { state: "absent", note: "no hosts.yaml: this host only" }
        : { state: "unreadable", note: loaded.error },
    };
  }
  const all = loaded.registry.hosts;
  if (deps.only && deps.only.length > 0) {
    const unknown = deps.only.filter((id) => !all.some((h) => h.id === id));
    if (unknown.length > 0) return { ok: false, error: `unknown host ids: ${unknown.join(", ")}` };
  }
  const wanted = deps.only && deps.only.length > 0 ? all.filter((h) => deps.only!.includes(h.id)) : all;
  const skipped: UsageAcrossHosts["skipped"] = [];
  const remotes: HostEntry[] = [];
  for (const h of wanted) {
    if (resolvesToLocalHost(h.id, deps.selfHostId) || (deps.selfHostId !== null && h.hostId === deps.selfHostId)) {
      skipped.push({ hostId: h.id, reason: "this entry names this daemon, which is read once as local" });
    } else remotes.push(h);
  }
  return { ok: true, remotes, skipped, registry: { state: "read" } };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// The checks below cover every field the CLI (`rig provider status --all-hosts`) and the TUI draw from a host's rows
// and seats, by the types in provider-types.ts. A field a renderer reads is a typed primitive, null or absent where the
// type allows, or an array or record of them, so nothing that reaches a template string or a join can throw or print
// "undefined". Fields no renderer reads aren't checked; they're served as the host sent them (scrubbed, bounded).
type Check = (v: unknown) => boolean;
const str: Check = (v) => typeof v === "string";
const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
const bool: Check = (v) => typeof v === "boolean";
const nullable = (c: Check): Check => (v) => v === null || c(v);
const optional = (c: Check): Check => (v) => v === undefined || c(v);
const oneOf = (...values: unknown[]): Check => (v) => values.includes(v);
const listOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const record = (fields: Record<string, Check>): Check => (v) =>
  isRecord(v) && Object.entries(fields).every(([k, c]) => c(v[k]));

const FRESHNESS = ["fresh", "stale", "unavailable"];
const LEVELS = ["ok", "nearing", "exhausted", "unknown"];

const disagreeingSeat = record({ seatSession: str, usedPercent: num, resetsAt: nullable(str), observedAt: str });
const usageWindow = record({
  window: str,
  durationMins: nullable(num),
  usedPercent: nullable(num),
  remainingPercent: nullable(num),
  resetsAt: nullable(str),
  observedAt: str,
  seatSession: optional(str),
  disagreeingSeats: optional(listOf(disagreeingSeat)),
  level: oneOf(...LEVELS),
  levelReason: optional(str),
  freshness: oneOf(...FRESHNESS),
  freshnessReason: optional(str),
});
const codexIdentity = record({
  accountId: nullable(str), workspaceId: nullable(str), limitId: str, email: nullable(str), planType: nullable(str), source: str,
});
const claudeIdentity = record({
  orgId: nullable(str), limitId: str, email: nullable(str), orgName: nullable(str), subscriptionType: nullable(str), source: str,
});
/** The views' identity label reads keys of both providers' identities, whatever the row's provider, so every one of
 *  them is checked on every identity: absent, or the type the label expects. */
const anyIdentityKeys = record({
  accountId: optional(nullable(str)),
  workspaceId: optional(nullable(str)),
  orgId: optional(nullable(str)),
  orgName: optional(nullable(str)),
  email: optional(nullable(str)),
  limitId: optional(str),
  planType: optional(nullable(str)),
  subscriptionType: optional(nullable(str)),
  source: optional(str),
});
const usageRowFields = {
  observedAt: nullable(str),
  seats: optional(str),
  windows: listOf(usageWindow),
  limitEvidence: nullable(str),
  latestFromSource: bool,
  lastRefresh: nullable(record({ at: str, outcome: oneOf("ok", "failed"), reason: optional(str), detail: optional(str) })),
  currentAvailability: oneOf("known", "unknown"),
  unavailableReason: optional(str),
  identityNote: optional(str),
  unresolved: optional(record({ note: str, keptReads: num, droppedReads: num })),
  savedProfiles: optional(record({ names: listOf(str), note: str })),
};

/** A served row with every field the grouping and the views read, typed as provider-types.ts says. */
export function isUsageRow(v: unknown): v is ProviderUsageAllowance {
  if (!isRecord(v) || (v["provider"] !== "codex" && v["provider"] !== "claude")) return false;
  const identity = v["provider"] === "codex" ? codexIdentity : claudeIdentity;
  return nullable((id) => identity(id) && anyIdentityKeys(id))(v["identity"]) && record(usageRowFields)(v);
}

const seatConfiguration: Check = (v) =>
  record({ source: oneOf("registry"), profileRef: str, recordedAt: str, profileSaved: nullable(bool) })(v)
  || record({ source: oneOf("default_login"), home: nullable(str), homeNote: str })(v)
  || record({ source: oneOf("unknown"), reason: str })(v);

/** A served seat account with every field the views read, typed as provider-types.ts says. */
export const isSeat = record({
  seatSession: str,
  rigName: str,
  runtime: str,
  configured: seatConfiguration,
  registryNotes: optional(listOf(str)),
  allowance: record({ linked: oneOf(false), reason: str }),
  observed: optional(record({
    windowsSampled: optional(bool),
    lastSampledAt: optional(str),
    differsFrom: optional(listOf(str)),
    withheld: optional(oneOf(true)),
    note: optional(str),
  })),
});

/**
 * A host's answer with any string that contains the bearer configured for that host replaced, and any key that
 * contains it dropped, so a host echoing it can't put it in the view, the CLI or the kept refresh record (the same
 * rule as the Pi charge lookup's key echo). The bearer is resolved by the transport's own resolver and never logged.
 */
export function scrubBearer(value: unknown, bearer: string | undefined, depth = 0): unknown {
  // The walk is also the depth bound, with or without a bearer: past it the answer is malformed (contained by the caller).
  if (depth > USAGE_HOSTS_MAX_DEPTH) throw new AnswerTooDeep();
  if (typeof value === "string") return bearer && value.includes(bearer) ? BEARER_REDACTED : value;
  if (Array.isArray(value)) return value.map((v) => scrubBearer(v, bearer, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !(bearer && k.includes(bearer)))
      .map(([k, v]) => [k, scrubBearer(v, bearer, depth + 1)]));
  }
  return value;
}

/** A host's answer nested past USAGE_HOSTS_MAX_DEPTH. */
export class AnswerTooDeep extends Error {
  constructor() {
    super(`answer nested deeper than ${USAGE_HOSTS_MAX_DEPTH} levels`);
  }
}

/** The transport options every call to a host makes here: bounded bytes, redirects not followed. */
const HOST_CALL = { maxBytes: USAGE_HOSTS_MAX_BYTES, redirect: "manual" as const };

/**
 * One call to a host, scrubbed with the bearer that call sent: the bearer is resolved by the transport's own resolver
 * right before the call, handed to the transport to send, and the same token scrubs the answer. A rotated bearer file
 * is read again on the next call; nothing is cached.
 */
async function exchange(host: HttpHostEntry, path: string, opts: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  deps: Pick<UsageHostsDeps, "fetchImpl" | "env" | "readFile">): Promise<RemoteJsonResult> {
  const resolvedBearer = resolveBearer(host, { env: deps.env, readFile: deps.readFile });
  const res = await remoteJsonRequest(host, path, {
    ...opts,
    ...HOST_CALL,
    resolvedBearer,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  const sent = resolvedBearer.ok ? resolvedBearer.token : undefined;
  return res.ok ? { ...res, payload: scrubBearer(res.payload, sent) } : { ...res, detail: scrubBearer(res.detail, sent) as string };
}
const isRedirect = (res: RemoteJsonResult): boolean => !res.ok && res.kind === "http" && res.status !== undefined && res.status >= 300 && res.status < 400;

/** A transport failure as a host status. A bearer that can't be resolved is named, never its env var or file. */
function transportFailure(hostId: string, res: Exclude<RemoteJsonResult, { ok: true }>, timeoutMs: number): UsageHostStatus {
  const base = { hostId, usage: "unavailable" as const, readAt: null };
  switch (res.kind) {
    case "bearer":
      return { ...base, status: "auth-failed", error: "the bearer configured for this host couldn't be resolved", usageReason: "not read" };
    case "timeout":
      return {
        ...base,
        status: "unreachable",
        error: res.phase === "body"
          ? `read timed out: response headers arrived (HTTP ${res.status}) but the body never completed`
          : `read timed out after ${timeoutMs} ms`,
        usageReason: "not read",
      };
    case "network":
      return { ...base, status: "unreachable", error: res.detail, usageReason: "not read" };
    case "http":
      return { ...base, status: "unreachable", error: `HTTP ${res.status}`, usageReason: "not read" };
  }
}

interface HostRead {
  status: UsageHostStatus;
  rows: ProviderUsageAllowance[];
  seats: SeatConfiguredAccount[] | null;
}

async function readHost(host: HostEntry, deps: UsageHostsDeps, now: () => string): Promise<HostRead> {
  const hostId = host.id;
  if (host.transport !== "http") {
    return {
      status: {
        hostId,
        status: "unsupported-transport",
        error: `host '${hostId}' is ssh-declared; usage across hosts needs an http registry entry (url; bearer optional)`,
        usage: "unavailable",
        usageReason: "not read",
        readAt: null,
      },
      rows: [],
      seats: null,
    };
  }
  const timeoutMs = deps.readTimeoutMs ?? USAGE_HOSTS_READ_TIMEOUT_MS;
  const get = (path: string) => exchange(host as HttpHostEntry, path, { method: "GET", timeoutMs }, deps);
  const res = await get("/api/provider/status");
  const readAt = now();
  const ok = (usage: HostUsageCoverage, usageReason?: string): UsageHostStatus =>
    ({ hostId, status: "ok", usage, ...(usageReason ? { usageReason } : {}), readAt });
  if (!res.ok) {
    if (isRedirect(res)) return { status: ok("unavailable", `redirected (HTTP ${res.status}); not followed`), rows: [], seats: null };
    if (res.tooLarge) return { status: ok("unavailable", res.detail), rows: [], seats: null };
    if (res.kind === "http" && (res.status === 401 || res.status === 403)) {
      return { status: { hostId, status: "auth-failed", error: `HTTP ${res.status}`, usage: "unavailable", usageReason: "not read", readAt: null }, rows: [], seats: null };
    }
    if (res.kind === "http" && res.status === 404) {
      return { status: ok("older", "this host has no provider status route (its daemon predates it)"), rows: [], seats: null };
    }
    if (res.kind === "http" && res.status === 503) {
      return { status: ok("unavailable", "the provider service is unavailable on this host"), rows: [], seats: null };
    }
    return { status: transportFailure(hostId, res, timeoutMs), rows: [], seats: null };
  }
  const model = isRecord(res.payload) ? res.payload : {};
  if (Array.isArray(model["usage"])) {
    if (!model["usage"].every(isUsageRow)) {
      return { status: ok("unavailable", "this host served usage rows in a shape this daemon doesn't recognize"), rows: [], seats: null };
    }
    const seats = model["seatAccounts"];
    if (seats !== undefined && !(Array.isArray(seats) && seats.every(isSeat))) {
      return { status: ok("unavailable", "this host served seat accounts in a shape this daemon doesn't recognize"), rows: [], seats: null };
    }
    return { status: ok("served"), rows: model["usage"], seats: (seats as SeatConfiguredAccount[] | undefined) ?? null };
  }
  // No usage key: off, or a daemon that predates usage windows. The host's own settings tell which (the TUI's rule).
  const config = await get("/api/config?view=browser");
  if (isRedirect(config)) return { status: ok("unavailable", `this host served no usage windows, and its settings read was redirected (HTTP ${(config as { status?: number }).status}); not followed`), rows: [], seats: null };
  const entries = config.ok && isRecord(config.payload) && Array.isArray(config.payload["entries"])
    ? (config.payload["entries"] as unknown[]).filter(isRecord)
    : null;
  if (!entries) {
    return { status: ok("unavailable", "this host served no usage windows, and its settings couldn't be read to say whether they are off"), rows: [], seats: null };
  }
  const entry = entries.find((e) => e["key"] === "provider.usage_windows");
  if (!entry) return { status: ok("older", "this host doesn't know the provider.usage_windows setting (its daemon predates usage windows)"), rows: [], seats: null };
  if (entry["value"] === true) return { status: ok("unavailable", "provider.usage_windows is on there, but it served no usage windows"), rows: [], seats: null };
  const value = entry["value"];
  const shown = value === null || ["string", "number", "boolean"].includes(typeof value) ? String(value) : "an unrecognized value";
  return { status: ok("off", `usage windows are off on this host (provider.usage_windows = ${shown})`), rows: [], seats: null };
}

/** A host's read with anything it throws (reading, checking or scrubbing its answer) kept to that host. The thrown text
 *  isn't shown: it can carry the host's own content. */
async function readHostContained(host: HostEntry, deps: UsageHostsDeps, now: () => string): Promise<HostRead> {
  try {
    return await readHost(host, deps, now);
  } catch (error) {
    return {
      status: {
        hostId: host.id,
        status: "ok",
        usage: "unavailable",
        usageReason: error instanceof AnswerTooDeep ? `this host's answer is nested deeper than ${USAGE_HOSTS_MAX_DEPTH} levels` : "this host's answer couldn't be read",
        readAt: now(),
      },
      rows: [],
      seats: null,
    };
  }
}

/** The view across hosts. The caller has checked that this daemon serves usage windows (`local.usage` present). */
export async function readUsageAcrossHosts(
  local: FourBlockReadModel,
  selection: Extract<HostSelection, { ok: true }>,
  deps: UsageHostsDeps,
): Promise<UsageAcrossHosts> {
  const now = deps.now ?? (() => new Date().toISOString());
  const asOf = now();
  const remotes = selection.remotes;
  const reads = new Array<HostRead | undefined>(remotes.length);
  const deadlineMs = deps.viewDeadlineMs ?? USAGE_HOSTS_VIEW_DEADLINE_MS;
  let expired = false;
  let next = 0;
  const cap = Math.max(1, Math.min(deps.concurrency ?? USAGE_HOSTS_READ_CONCURRENCY, remotes.length));
  const work = Promise.all(Array.from({ length: remotes.length === 0 ? 0 : cap }, async () => {
    while (!expired && next < remotes.length) {
      const i = next;
      next += 1;
      const read = await readHostContained(remotes[i]!, deps, now);
      if (!expired) reads[i] = read;
    }
  }));
  // The view answers by its deadline with what it has; a read still running finishes on its own bound, unused.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(() => { expired = true; resolve(); }, deadlineMs); })]);
  clearTimeout(timer);
  const late = (host: HostEntry): HostRead => ({
    status: {
      hostId: host.id,
      status: "unreachable",
      error: `not heard from within the view's ${deadlineMs / 1000} s`,
      usage: "unavailable",
      usageReason: `not heard from within the view's ${deadlineMs / 1000} s`,
      readAt: null,
    },
    rows: [],
    seats: null,
  });

  const withRefresh = (s: UsageHostStatus): UsageHostStatus => {
    const last = deps.lastRefresh?.(s.hostId);
    return last && Object.keys(last).length > 0 ? { ...s, lastRefresh: last } : s;
  };
  const localRead: HostRead = {
    status: { hostId: LOCAL_HOST_ID, status: "ok", usage: "served", readAt: asOf },
    rows: local.usage ?? [],
    seats: local.seatAccounts ?? null,
  };
  const all = [localRead, ...remotes.map((host, i) => reads[i] ?? late(host))];
  const observations = all.flatMap((r) => r.rows.map((row) => ({ hostId: r.status.hostId, readAt: r.status.readAt!, row })));
  return {
    items: groupUsageAcrossHosts(observations),
    hosts: all.map((r) => withRefresh(r.status)),
    skipped: selection.skipped,
    registry: selection.registry,
    seatAccounts: all.filter((r) => r.seats !== null).map((r) => ({ hostId: r.status.hostId, seats: r.seats! })),
    asOf,
  };
}

// ——— Refreshing across hosts ———

type LegResult = Omit<UsageRefreshLeg, "hostId" | "provider" | "coalesced"> & { coalesced?: boolean };

/** Maps a host's answer to its refresh route into a leg. The host keeps its own reading on its own failure. */
export function remoteRefreshLeg(res: RemoteJsonResult, provider: ProviderKind, deadlineMs: number, at: string): LegResult {
  if (isRedirect(res)) return { at, outcome: "failed", reason: "redirected", detail: `redirected (HTTP ${(res as { status?: number }).status}); not followed` };
  if (!res.ok && res.tooLarge) return { at, outcome: "failed", reason: "too_large", detail: res.detail };
  if (res.ok) {
    const refresh = isRecord(res.payload) && isRecord(res.payload["refresh"]) ? res.payload["refresh"] : null;
    if (!refresh || (refresh["outcome"] !== "ok" && refresh["outcome"] !== "failed")) {
      return { at, outcome: "failed", reason: "unrecognized_answer", detail: "the host's refresh answer has an unrecognized shape" };
    }
    return {
      at: typeof refresh["at"] === "string" ? refresh["at"] : at,
      outcome: refresh["outcome"],
      coalesced: refresh["coalesced"] === true,
      ...(typeof refresh["reason"] === "string" ? { reason: refresh["reason"] } : {}),
      ...(typeof refresh["detail"] === "string" ? { detail: refresh["detail"] } : {}),
    };
  }
  const failed = (reason: string, detail: string): LegResult => ({ at, outcome: "failed", reason, detail });
  switch (res.kind) {
    case "bearer":
      return failed("auth_failed", "the bearer configured for this host couldn't be resolved");
    case "timeout":
      return failed("timeout", `no answer within ${deadlineMs} ms; the host may still finish its read, and its next served reading will show it`);
    case "network":
      return failed("unreachable", res.detail);
    case "http":
      if (res.status === 409) return failed("usage_windows_off", "usage windows are off on this host");
      if (res.status === 400) return failed("not_available", `${provider} usage windows are not available on this host`);
      if (res.status === 404) return failed("older", "this host has no usage refresh route (its daemon predates it)");
      if (res.status === 401 || res.status === 403) return failed("auth_failed", `HTTP ${res.status}`);
      if (res.status === 503) return failed("provider_service_unavailable", "the provider service is unavailable on this host");
      return failed("http_error", `HTTP ${res.status}`);
  }
}

/**
 * Refresh legs, one per (host, provider) at a time: a request that overlaps a running leg joins it. The last leg per
 * host and provider is kept in memory (a daemon restart forgets it, as each host's own last refresh is forgotten).
 */
export class UsageRefreshLegs {
  private readonly inflight = new Map<string, Promise<UsageRefreshLeg>>();
  private readonly last = new Map<string, Partial<Record<ProviderKind, UsageRefreshLeg>>>();

  constructor(private readonly opts: { deadlineMs?: Partial<Record<ProviderKind, number>>; now?: () => string } = {}) {}

  deadlineFor(provider: ProviderKind): number {
    return this.opts.deadlineMs?.[provider] ?? REMOTE_USAGE_REFRESH_DEADLINE_MS[provider];
  }

  lastFor(hostId: string): Partial<Record<ProviderKind, UsageRefreshLeg>> | undefined {
    return this.last.get(hostId);
  }

  async run(hostId: string, provider: ProviderKind, start: () => Promise<LegResult>): Promise<UsageRefreshLeg> {
    const id = `${hostId}\u0000${provider}`;
    const running = this.inflight.get(id);
    if (running) return { ...(await running), coalesced: true };
    const now = this.opts.now ?? (() => new Date().toISOString());
    const leg = (async (): Promise<UsageRefreshLeg> => {
      let result: LegResult;
      try {
        result = await start();
      } catch (error) {
        // The thrown text isn't kept or shown: it can carry the host's own content.
        result = error instanceof AnswerTooDeep
          ? { at: now(), outcome: "failed", reason: "too_deep", detail: `the host's answer is nested deeper than ${USAGE_HOSTS_MAX_DEPTH} levels` }
          : { at: now(), outcome: "failed", reason: "leg_failed", detail: "this leg's answer couldn't be read" };
      }
      const done: UsageRefreshLeg = { hostId, provider, ...result, coalesced: result.coalesced ?? false };
      this.last.set(hostId, { ...this.last.get(hostId), [provider]: done });
      return done;
    })();
    this.inflight.set(id, leg);
    try {
      return await leg;
    } finally {
      if (this.inflight.get(id) === leg) this.inflight.delete(id);
    }
  }

  /** One leg to a registry host's own refresh route, bounded by the provider's refresh deadline. */
  remote(host: HostEntry, provider: ProviderKind, deps: Pick<UsageHostsDeps, "fetchImpl" | "env" | "readFile">): Promise<UsageRefreshLeg> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    return this.run(host.id, provider, async () => {
      if (host.transport !== "http") {
        return { at: now(), outcome: "failed", reason: "unsupported_transport", detail: "ssh-declared host; a refresh across hosts needs an http registry entry" };
      }
      const deadlineMs = this.deadlineFor(provider);
      // Scrubbed with the bearer this call sent, before it's mapped, so neither the answer nor the kept record carries it.
      const res = await exchange(host, "/api/provider/usage/refresh", { method: "POST", body: { provider }, timeoutMs: deadlineMs }, deps);
      return remoteRefreshLeg(res, provider, deadlineMs, now());
    });
  }
}
