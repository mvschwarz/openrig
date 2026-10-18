// Slice 01 (OPR.0.7.0.1) — Codex usage windows for the provider view: the Codex normalizer and
// identity rule over the shared usage-windows core (usage-windows.ts), which holds the last reading in
// memory, refreshes only on request (coalesced) and projects rows.

import type { CodexUsageReader } from "./codex-usage-reader.js";
import type { UsageAllowanceIdentity } from "./provider-types.js";
import { UsageWindows, type UsageReadWindow, type UsageReading } from "./usage-windows.js";

export {
  UNRESOLVED_READS_KEPT,
  USAGE_CLOCK_TOLERANCE_MS,
  USAGE_FRESH_FOR_MS,
  usageFreshness,
  usageLevel,
  type UsageRefreshResult,
} from "./usage-windows.js";

type ReadWindow = UsageReadWindow;
type Reading = UsageReading<UsageAllowanceIdentity>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function readWindow(window: "primary" | "secondary", raw: unknown): ReadWindow | null | "bad" {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw) || typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent)) return "bad";
  const resetsAt = typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
    ? new Date(raw.resetsAt * 1000).toISOString()
    : null;
  const durationMins = typeof raw.windowDurationMins === "number" && Number.isFinite(raw.windowDurationMins)
    ? raw.windowDurationMins
    : null;
  return { window, durationMins, usedPercent: raw.usedPercent, resetsAt };
}

/**
 * The workspace `account/read` reports, when it reports one: `workspaceRouting.chatgptAccountId` at the top
 * level of the result (a sibling of `account`). Path and types from Codex 0.162.1's generated schema
 * (GetAccountResponse.json), relayed by Build's reviewer: `workspaceRouting` is optional and nullable, and
 * when present `chatgptAccountId` is a non-null string. Its siblings (backendOrigin, accountRoutingOverride)
 * are not identity. Codex 0.153.4's answer has no `workspaceRouting`, so it yields null there.
 */
export function accountReadWorkspaceId(account: unknown): string | null {
  if (!isRecord(account) || !isRecord(account.workspaceRouting)) return null;
  return stringOrNull(account.workspaceRouting.chatgptAccountId);
}

/**
 * Normalize the two app-server answers (shapes from Codex 0.153.4's protocol: `GetAccountResponse`,
 * `GetAccountRateLimitsResponse`). One reading per metered bucket (`rateLimitsByLimitId`, else the
 * single-bucket `rateLimits`). Identity is the usage answer's `accountId`, else the workspace
 * `account/read` reports, else unresolved; email and plan are labels and never part of identity.
 */
export function normalizeCodexUsage(account: unknown, rateLimits: unknown, observedAt: string):
  { ok: true; readings: Reading[] } | { ok: false; detail: string } {
  if (!isRecord(rateLimits)) return { ok: false, detail: "account/rateLimits/read returned an unrecognized shape" };
  const accountInfo = isRecord(account) && isRecord(account.account) ? account.account : null;
  const email = accountInfo ? stringOrNull(accountInfo.email) : null;
  const accountPlan = accountInfo ? stringOrNull(accountInfo.planType) : null;
  const accountId = stringOrNull(rateLimits.accountId);
  const workspaceId = accountId === null ? accountReadWorkspaceId(account) : null;
  const source: UsageAllowanceIdentity["source"] = accountId !== null
    ? "account/rateLimits/read accountId"
    : workspaceId !== null ? "account/read workspace routing" : "unresolved";
  const buckets: Array<[string, unknown]> = isRecord(rateLimits.rateLimitsByLimitId)
    ? Object.entries(rateLimits.rateLimitsByLimitId)
    : isRecord(rateLimits.rateLimits)
      ? [[stringOrNull(rateLimits.rateLimits.limitId) ?? "codex", rateLimits.rateLimits]]
      : [];
  if (buckets.length === 0) return { ok: false, detail: "account/rateLimits/read returned no rate-limit buckets" };
  const readings: Reading[] = [];
  for (const [limitId, snapshot] of buckets) {
    if (!isRecord(snapshot)) return { ok: false, detail: `bucket ${limitId} has an unrecognized shape` };
    const windows: ReadWindow[] = [];
    for (const key of ["primary", "secondary"] as const) {
      const w = readWindow(key, snapshot[key]);
      if (w === "bad") return { ok: false, detail: `bucket ${limitId} ${key} window has an unrecognized shape` };
      if (w) windows.push(w);
    }
    readings.push({
      identity: {
        accountId,
        workspaceId,
        limitId,
        email,
        planType: stringOrNull(snapshot.planType) ?? accountPlan,
        source,
      },
      windows,
      limitEvidence: stringOrNull(snapshot.rateLimitReachedType),
      observedAt,
    });
  }
  return { ok: true, readings };
}

/** The replacement key of a resolved identity. Email is never part of it; an unresolved identity has none. */
export const codexUsageIdentityKey = (i: UsageAllowanceIdentity): string | null =>
  i.accountId !== null ? `codex:account:${i.accountId}:${i.limitId}`
    : i.workspaceId !== null ? `codex:workspace:${i.workspaceId}:${i.limitId}`
      : null;

export interface CodexUsageWindowsDeps {
  read: CodexUsageReader;
  now?: () => string;
}

export class CodexUsageWindows extends UsageWindows<UsageAllowanceIdentity, { account: unknown; rateLimits: unknown }> {
  constructor(deps: CodexUsageWindowsDeps) {
    super({
      provider: "codex",
      sourceKind: "codex_app_server",
      read: deps.read,
      normalize: (answer) => normalizeCodexUsage(answer.account, answer.rateLimits, answer.observedAt),
      key: codexUsageIdentityKey,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }
}
