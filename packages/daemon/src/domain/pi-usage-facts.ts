/**
 * OPR.0.7.0.2 (cost reporting, Pi atom): usage facts from Pi's PERSISTED session entries.
 *
 * Read against Pi 0.87.1 (`@earendil-works/pi-coding-agent`, OpenRig's tested baseline), session format v3.
 * Every entry has `{ type, id, parentId, timestamp }`. The usage-bearing kinds are exactly the ones Pi's own
 * totals count (`core/usage-totals.js` getUsageCostBreakdown):
 *   - `message` with `message.role === "assistant"`: `message.usage` (kept for error and aborted turns too);
 *   - `usage` entries: `usage` (a standalone usage category, with `kind`, `provider`, `model`);
 *   - `message` with `message.role === "toolResult"` and `message.usage`;
 *   - `compaction` and `branch_summary` entries with `usage`.
 * A Pi `Usage` carries `input`, `output`, `cacheRead`, `cacheWrite` and `cost.total`, which is Pi's
 * model-priced estimate from catalog rates (not a provider charge).
 *
 * Live `message_update` usage is cumulative and display-only, so it never comes here: only entries Pi has
 * persisted and returned from `get_entries` do. Each fact is keyed by the Pi session id and the entry id, so the
 * consumer stores it once however often it is fetched again.
 */

export type PiUsageFactKind = "assistant" | "usage" | "tool_result" | "compaction" | "branch_summary";

/** Where an entry's spend belongs. A fork or branch copies the source session's entries into a new session
 *  file unchanged (same ids, original timestamps); those are `inherited`. `unknown`: the session header that
 *  tells them apart couldn't be read. */
export type PiUsageOrigin = "own" | "inherited" | "unknown";

export interface PiUsageFact {
  entryId: string;
  parentEntryId: string | null;
  entryTimestamp: string;
  kind: PiUsageFactKind;
  /** A `usage` entry's own category (e.g. "cache_warm"); null otherwise. */
  usageCategory: string | null;
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Pi's model-priced estimate (`usage.cost.total`); null when the entry carries no cost (absent, never zero). */
  costTotal: number | null;
  /** An assistant turn's stop reason ("stop", "error", "aborted", ...), kept so error and abort usage is visible. */
  stopReason: string | null;
  origin: PiUsageOrigin;
}

/** The session header boundary that separates inherited entries from the occupant's own. */
export interface PiSessionBoundary {
  /** The session header's creation time. */
  createdAt: string;
  /** Set when the session was forked or branched from another. */
  parentSession: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function originOf(timestamp: string, boundary: PiSessionBoundary | null): PiUsageOrigin {
  if (!boundary) return "unknown";
  if (!boundary.parentSession) return "own";
  const at = Date.parse(timestamp);
  const created = Date.parse(boundary.createdAt);
  if (Number.isNaN(at) || Number.isNaN(created)) return "unknown";
  return at < created ? "inherited" : "own";
}

/**
 * The usage facts in `entries` (Pi `get_entries` data). An entry whose usage can't be read is counted in
 * `malformed` and skipped; nothing here throws, so a bad entry never blocks the seat's work.
 */
export function extractPiUsageFacts(entries: unknown[], boundary: PiSessionBoundary | null): { facts: PiUsageFact[]; malformed: number } {
  const facts: PiUsageFact[] = [];
  let malformed = 0;
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const message = entry["message"] && typeof entry["message"] === "object" ? entry["message"] as Record<string, unknown> : null;
    let kind: PiUsageFactKind | null = null;
    let usage: unknown;
    let provider: string | null = null;
    let model: string | null = null;
    let usageCategory: string | null = null;
    let stopReason: string | null = null;
    if (entry["type"] === "message" && message?.["role"] === "assistant") {
      kind = "assistant";
      usage = message["usage"];
      provider = str(message["provider"]);
      model = str(message["responseModel"]) ?? str(message["model"]);
      stopReason = str(message["stopReason"]);
    } else if (entry["type"] === "usage") {
      kind = "usage";
      usage = entry["usage"];
      provider = str(entry["provider"]);
      model = str(entry["model"]);
      usageCategory = str(entry["kind"]);
    } else if (entry["type"] === "message" && message?.["role"] === "toolResult" && message["usage"] !== undefined) {
      kind = "tool_result";
      usage = message["usage"];
    } else if ((entry["type"] === "compaction" || entry["type"] === "branch_summary") && entry["usage"] !== undefined) {
      kind = entry["type"] as "compaction" | "branch_summary";
      usage = entry["usage"];
    }
    if (!kind) continue;
    const id = str(entry["id"]);
    const timestamp = str(entry["timestamp"]);
    const u = usage && typeof usage === "object" ? usage as Record<string, unknown> : null;
    const input = num(u?.["input"]);
    const output = num(u?.["output"]);
    if (!id || !timestamp || !u || input === null || output === null) {
      malformed += 1;
      continue;
    }
    const cost = u["cost"] && typeof u["cost"] === "object" ? num((u["cost"] as Record<string, unknown>)["total"]) : null;
    facts.push({
      entryId: id,
      parentEntryId: str(entry["parentId"]),
      entryTimestamp: timestamp,
      kind,
      usageCategory,
      provider,
      model,
      input,
      output,
      cacheRead: num(u["cacheRead"]) ?? 0,
      cacheWrite: num(u["cacheWrite"]) ?? 0,
      costTotal: cost,
      stopReason,
      origin: originOf(timestamp, boundary),
    });
  }
  return { facts, malformed };
}

/** The boundary from a Pi session file's first line (its header). null when it can't be read as one. */
export function parsePiSessionHeader(firstLine: string): PiSessionBoundary | null {
  try {
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    if (header["type"] !== "session" || typeof header["timestamp"] !== "string") return null;
    return { createdAt: header["timestamp"], parentSession: str(header["parentSession"]) };
  } catch {
    return null;
  }
}
