import { sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { CostBody, CostRead } from "./cost-read.js";

// Slice 02 — System → Cost: what each seat's harness reports about cost, beside its tokens, from the daemon's cost
// view (the same body `rig usage cost` prints). Each seat's first line is the line `rig usage cost` prints for it;
// the lines under it spell out the served kind, source, window and coverage, and every count and reason the daemon
// served. A provider charge sits beside the estimate it matches and is never added to it. Nothing is summed across
// seats, matched, or re-timed here, and a missing figure reads as missing, never as $0.

type Row = Record<string, unknown>;
type Seat = CostBody["seats"][number];

export const COST_HEADER = "this host's daemon only · not fleet-wide · what each harness reports, not an invoice";
export const COST_READ_HINT = "This view reads what the daemon already holds and starts no lookup. The same lines: rig usage cost";

const str = (v: unknown, fallback = "unknown"): string => (v === null || v === undefined || v === "" ? fallback : String(v));

/** A real amount below a cent prints as "<$0.01", never "$0.00" (which reads as zero). As `rig usage cost` prints it. */
export function formatUsd(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`;
}

const tok = (t: unknown): string => {
  const v = t as { input?: number | null; output?: number | null } | undefined;
  return `tokens in ${v?.input ?? "?"} / out ${v?.output ?? "?"}`;
};

/** OpenRouter's actual charge, beside the estimate, as `rig usage cost` words it. */
function providerChargeText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const c = raw as { status?: string; costUsd?: number; estimateForChargedUsd?: number | null;
    requests?: { covered?: number; charged?: number; pending?: number; unavailable?: { count: number; reasons: Record<string, number> };
      notCovered?: { count: number } }; accountContext?: { credentialSources?: string[]; workspaceIds?: string[] } };
  const q = c.requests ?? {};
  const top = (reasons: Record<string, number> | undefined) => Object.entries(reasons ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  const notCovered = q.notCovered?.count ? `, ${q.notCovered.count} not covered` : "";
  switch (c.status) {
    case "reported":
    case "partial": {
      const beside = c.estimateForChargedUsd !== null && c.estimateForChargedUsd !== undefined ? `, Pi estimate for them ${formatUsd(c.estimateForChargedUsd)}` : "";
      const rest = [q.pending ? `${q.pending} pending` : "", q.unavailable?.count ? `${q.unavailable.count} unavailable (${top(q.unavailable.reasons)})` : ""].filter(Boolean).join(", ");
      const who = c.accountContext?.credentialSources?.length ? ` via ${c.accountContext.credentialSources.join(", ")}` : "";
      return `OpenRouter charge ${formatUsd(Number(c.costUsd))} USD for ${q.charged} of ${q.covered} requests${who}${beside}${rest ? `; ${rest}` : ""}${notCovered} (provider-reported, not added to the estimate)`;
    }
    case "pending": return `OpenRouter charge pending for ${q.pending} request${q.pending === 1 ? "" : "s"}${notCovered}`;
    case "unavailable": return `OpenRouter charge unavailable (${top(q.unavailable?.reasons)})${notCovered}`;
    case "none": return q.covered ? `OpenRouter charge not looked up (usage.pi_openrouter_charge off, or not run yet)${notCovered}` : (q.notCovered?.count ? `OpenRouter charge: ${q.notCovered.count} request${q.notCovered.count === 1 ? "" : "s"} not covered` : "");
    default: return "";
  }
}

function piHeadLine(seat: Seat): string {
  const w = (seat["window"] ?? {}) as { piSessionId?: string; since?: string | null; asOf?: string | null };
  const e = (seat["entries"] ?? {}) as { own?: number; ownWithoutCost?: number; errorOrAborted?: number;
    inherited?: { count: number; costUsd: number | null }; unknownOrigin?: { count: number; costUsd: number | null } };
  const t = (seat["tokens"] ?? {}) as { input?: number; output?: number };
  const extras = [
    e.ownWithoutCost ? `${e.ownWithoutCost} entr${e.ownWithoutCost === 1 ? "y" : "ies"} without a cost` : "",
    e.errorOrAborted ? `${e.errorOrAborted} error/aborted turn${e.errorOrAborted === 1 ? "" : "s"} included` : "",
    e.inherited?.count ? `${e.inherited.count} inherited from the fork, not counted${e.inherited.costUsd !== null ? ` (${formatUsd(e.inherited.costUsd)})` : ""}` : "",
    e.unknownOrigin?.count ? `${e.unknownOrigin.count} of unknown origin, not counted${e.unknownOrigin.costUsd !== null ? ` (${formatUsd(e.unknownOrigin.costUsd)})` : ""}` : "",
  ].filter(Boolean).join("; ");
  const head = seat.status === "reported"
    ? `${formatUsd(Number(seat["costUsd"]))} model-priced estimate (Pi persisted entries, ${e.own ?? 0} own entries) for Pi session ${w.piSessionId}${w.since ? ` since ${w.since}` : ""}${w.asOf ? `, last ${w.asOf}` : ""}`
    : `cost: not reported (${seat["reason"]}) for Pi session ${w.piSessionId}`;
  const charge = providerChargeText(seat["providerCharge"]);
  return `${seat.seatSession}  ${head}${extras ? `; ${extras}` : ""}${charge ? `; ${charge}` : ""}  tokens in ${t.input ?? "?"} / out ${t.output ?? "?"}`;
}

/** The line `rig usage cost` prints for this seat. */
export function costHeadLine(seat: Seat): string {
  if (seat["runtime"] === "pi") return piHeadLine(seat);
  const w = (seat["window"] ?? {}) as { nativeSessionId?: string | null; since?: string; asOf?: string | null };
  if (seat.status === "reported") {
    const stale = seat["stale"] ? `, STALE (${seat["ageSeconds"] ?? "?"}s old; kept as history)` : "";
    const resets = Number(seat["resets"]) > 0 ? `, ${seat["resets"]} reset${seat["resets"] === 1 ? "" : "s"}` : "";
    return `${seat.seatSession}  ${formatUsd(Number(seat["costUsd"]))} client-side estimate (Claude statusline) for session ${w.nativeSessionId} since ${w.since}, as of ${w.asOf}${resets}${stale}  ${tok(seat["tokens"])}`;
  }
  if (seat.status === "absent") return `${seat.seatSession}  cost: not reported (${seat["reason"]})  ${tok(seat["tokens"])}`;
  if (seat.status === "no-cost-method") return `${seat.seatSession}  ${tok(seat["tokens"])}  cost: ${seat["note"]}`;
  return `${seat.seatSession}  cost: unknown (${seat["reason"]})`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const reasons = (label: string, rs: Record<string, number> | undefined): ContentLine[] =>
  Object.entries(rs ?? {}).map(([reason, n]) => ({ text: `      ${label}: ${reason} (${n})` }));

/** The served provider-charge block, in full: never added to the estimate it sits beside. */
function chargeLines(raw: unknown): ContentLine[] {
  if (!raw || typeof raw !== "object") return [];
  const c = raw as Row;
  const q = (c["requests"] ?? {}) as { openRouter?: number; covered?: number; charged?: number; pending?: number;
    unavailable?: { count: number; reasons: Record<string, number> }; notCovered?: { count: number; reasons: Record<string, number> } };
  const a = (c["accountContext"] ?? {}) as { credentialSources?: string[]; workspaceIds?: string[]; byokRequests?: number };
  const money = typeof c["costUsd"] === "number"
    ? `${formatUsd(c["costUsd"] as number)} USD${typeof c["estimateForChargedUsd"] === "number" ? ` (Pi's estimate for the same requests: ${formatUsd(c["estimateForChargedUsd"] as number)})` : ""}`
    : "no charge established";
  const lines: ContentLine[] = [
    { text: `    ${str(c["kind"], "provider charge")}, beside the estimate and never added to it: ${str(c["status"])} · ${money}` },
    { text: `      source: ${str(c["source"])}` },
    { text: `      requests: ${q.openRouter ?? "?"} OpenRouter · ${q.covered ?? "?"} covered · ${q.charged ?? 0} charged · ${q.pending ?? 0} pending · ${q.unavailable?.count ?? 0} unavailable · ${q.notCovered?.count ?? 0} not covered` },
    ...reasons("unavailable", q.unavailable?.reasons),
    ...reasons("not covered", q.notCovered?.reasons),
    { text: `      account context: credential ${a.credentialSources?.length ? a.credentialSources.join(", ") : "not established"} · workspace ${a.workspaceIds?.length ? a.workspaceIds.join(", ") : "not reported"} · BYOK requests ${a.byokRequests ?? 0}` },
  ];
  if (c["coverage"]) lines.push({ text: `      coverage: ${c["coverage"]}` });
  return lines;
}

/** Everything the daemon served for this seat beyond its `rig usage cost` line. */
function detailLines(seat: Seat): ContentLine[] {
  const lines: ContentLine[] = [];
  const w = (seat["window"] ?? {}) as Row;
  if (seat["kind"] || seat["source"]) lines.push({ text: `    ${str(seat["kind"])} · source: ${str(seat["source"])}` });
  if (seat["runtime"] === "pi") {
    lines.push({ text: `    window: Pi session ${str(w["piSessionId"])} · first own entry ${str(w["since"], "none")} · last ${str(w["asOf"], "none")}` });
    const k = (seat["kinds"] ?? {}) as Record<string, number>;
    if (Object.keys(k).length) lines.push({ text: `    own entries by kind: ${Object.entries(k).map(([kind, n]) => `${kind} ${n}`).join(" · ")}` });
    const e = (seat["entries"] ?? {}) as { own?: number; ownWithoutCost?: number; errorOrAborted?: number;
      inherited?: { count: number; costUsd: number | null }; unknownOrigin?: { count: number; costUsd: number | null } };
    const apart = (n: { count: number; costUsd: number | null } | undefined) =>
      `${n?.count ?? 0}${n?.costUsd !== null && n?.costUsd !== undefined ? ` (${formatUsd(n.costUsd)})` : ""}`;
    lines.push({ text: `    own ${e.own ?? 0} (counted; ${e.ownWithoutCost ?? 0} without a cost, ${e.errorOrAborted ?? 0} error/aborted) · inherited ${apart(e.inherited)} and unknown origin ${apart(e.unknownOrigin)}: shown apart, not counted` });
    const t = (seat["tokens"] ?? {}) as Row;
    lines.push({ text: `    tokens: in ${str(t["input"], "?")} · out ${str(t["output"], "?")} · cache read ${str(t["cacheRead"], "?")} · cache write ${str(t["cacheWrite"], "?")}` });
  } else if (seat["runtime"] === "claude-code" || seat["runtime"] === "codex") {
    const since = w["since"] ? ` · since ${w["since"]}` : "";
    lines.push({ text: `    window: native session ${str(w["nativeSessionId"], "not reported")}${since} · as of ${str(w["asOf"], "not reported")}` });
    if (seat["status"] === "reported") {
      lines.push({ text: `    resets in this session: ${str(seat["resets"], "0")} · ${seat["stale"] ? `stale: ${str(seat["ageSeconds"], "?")}s old, kept as history` : `fresh (${str(seat["ageSeconds"], "?")}s old)`}` });
    }
  }
  if (seat["coverage"]) lines.push({ text: `    coverage: ${seat["coverage"]}` });
  lines.push(...chargeLines(seat["providerCharge"]));
  return lines;
}

export function costLines(read: CostRead | undefined, width: number): ContentLine[] {
  const lines: ContentLine[] = [{ text: "System · Cost beside tokens" }, { text: `  ${COST_HEADER}` }, { text: `  ${COST_READ_HINT}` }];
  if (!read) return wrapDetailLines([...lines, { text: "" }, { text: "  Not read yet." }], width);
  if (!("body" in read.status)) {
    const failure = read.status;
    lines.push({ text: "" }, failure.status === 404
      ? { text: "  This daemon doesn't serve the cost view (no /api/telemetry/usage/cost: HTTP 404)." }
      : { text: `  Cost unavailable: ${failure.error}. Nothing is inferred from the missing read.` });
    return wrapDetailLines(lines, width);
  }
  const body = read.status.body;
  lines.push(sectionRule(`Seats · ${count(body.seats.length, "seat")}`, width));
  if (body.seats.length === 0) lines.push({ text: "  no usage samples yet: no seat has reported tokens or cost" });
  for (const seat of body.seats) lines.push({ text: `  ${costHeadLine(seat)}` }, ...detailLines(seat));
  if (body.note) lines.push({ text: "" }, { text: `  ${body.note}` });
  return wrapDetailLines(lines, width);
}
