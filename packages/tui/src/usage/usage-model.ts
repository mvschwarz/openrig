import { sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { FleetSnapshot } from "../types.js";

// Slice 01 — System → Usage: this daemon's usage windows and configured seat accounts, from the provider read
// model the daemon serves (the same body `rig provider status --json` prints). Passive: the daemon answers that
// read from memory, and this view never asks for a refresh. Fields and the daemon's own strings (notes, reasons,
// levelReason, freshnessReason, times) are shown as served; nothing is matched, summed, thresholded or re-timed here.

export type Row = Record<string, unknown>;

export interface UsageRead {
  /** The served read model, or why it couldn't be read (status null: no HTTP answer). */
  status: { model: Row } | { status: number | null; error: string };
  /**
   * Read only when the model has no `usage` key, to say why: the daemon's provider.usage_windows setting entry,
   * "absent" when the daemon doesn't know the key (it predates usage windows), or null when that read failed.
   */
  switchSetting?: { value: unknown; source?: string } | "absent" | null;
}

export const USAGE_HEADER = "this host's daemon only · not fleet-wide · not proof of the login a running session uses";
export const USAGE_REFRESH_HINT = "This view shows what this daemon already holds and never reads the logins itself. To read them now: rig provider status --refresh [--provider codex|claude]";

export const str = (v: unknown, fallback = "unknown"): string => (v === null || v === undefined || v === "" ? fallback : String(v));

function windowName(w: Row): string {
  const mins = w["durationMins"];
  const label = mins === 300 ? "5h" : mins === 10080 ? "weekly" : typeof mins === "number" ? `${mins} min` : null;
  return label ? `${label} (${str(w["window"])})` : str(w["window"]);
}

/** A failure's reason and detail as served, worded as `rig provider status` words them. Both are optional in the read
 *  model: an absent reason reads "no reason given" and an absent detail drops its clause. When both are served, as this
 *  daemon always serves them, the text is "reason (detail)". */
export function failureText(f: Row): string {
  return `${f["reason"] ?? "no reason given"}${f["detail"] !== undefined ? ` (${f["detail"]})` : ""}`;
}

/** Codex: account, else the workspace account/read reported; Claude: the organisation; else unresolved. */
export function identityLabel(id: Row): string {
  return id["accountId"] ? `account ${id["accountId"]}`
    : id["workspaceId"] ? `workspace ${id["workspaceId"]} (from account/read; no usage account id)`
      : id["source"] !== "unresolved" && id["orgId"] ? `organisation ${id["orgName"] ? `${id["orgName"]} (${id["orgId"]})` : id["orgId"]}`
        : "identity unresolved";
}

/** One served allowance row, as served (also drawn per host by System → Usage across hosts). */
/** The row's sign-in fact, as served; null when an older daemon doesn't serve it. */
export function signInText(r: Row): string | null {
  const s = r["signIn"] as Row | undefined;
  if (!s) return null;
  const state = s["state"] === "needs_sign_in" ? "needs sign-in" : str(s["state"]);
  return `sign-in: ${state} (${str(s["evidence"])}${s["at"] ? `; as of ${str(s["at"])}` : ""})`;
}

/** The row's retained history: last observed exhaustion, the account link, and an inactive account's profile. */
function historyLines(r: Row): ContentLine[] {
  const lines: ContentLine[] = [];
  const ex = r["lastObservedExhausted"] as Row | null | undefined;
  if (ex) lines.push({ text: `    last observed exhausted at ${str(ex["at"])} (${ex["window"] ? str(ex["window"]) : "account-level"}: ${str(ex["evidence"])})` });
  if (r["accountHistory"] === "unknown") lines.push({ text: "    account history unknown" });
  if (r["savedProfile"] === "not linked") lines.push({ text: "    saved profile: not linked (OpenRig doesn't record which saved profile was active at this read)" });
  return lines;
}

export function allowanceLines(r: Row): ContentLine[] {
  const lines: ContentLine[] = [];
  const id = r["identity"] as Row | null | undefined;
  if (!id) {
    lines.push({ text: `  ${str(r["provider"])}  unavailable: ${str(r["unavailableReason"], "no reading")}` });
    // A row with no identity yet can still carry history (Claude's before its first identity refresh): before sign-in,
    // as on an identified row.
    lines.push(...historyLines(r));
    const last = r["lastRefresh"] as Row | null | undefined;
    if (last?.["outcome"] === "failed") lines.push({ text: `    refresh failed at ${str(last["at"])}: ${failureText(last)}` });
    const signIn = signInText(r);
    if (signIn) lines.push({ text: `    ${signIn}` });
    return lines;
  }
  const labels = [identityLabel(id), `bucket ${str(id["limitId"])}`, id["email"] ?? "email not reported", id["planType"], id["subscriptionType"], `seats ${str(r["seats"])}`]
    .filter((x) => x !== null && x !== undefined);
  const earlier = r["latestFromSource"] ? ""
    : r["retained"] === "before_restart" ? "  [kept from before the daemon restarted; not a current reading]"
    : id["source"] === "unresolved" ? "  [from an earlier read; possibly this same login]"
      : "  [from an earlier read; the latest read didn't match this row]";
  lines.push({ text: `  ${str(r["provider"])}  ${labels.join(" · ")}${earlier}` });
  if (r["identityNote"]) lines.push({ text: `    ${r["identityNote"]}` });
  const unresolved = r["unresolved"] as Row | undefined;
  if (unresolved) {
    const dropped = Number(unresolved["droppedReads"] ?? 0);
    lines.push({ text: `    ${str(unresolved["note"])}` },
      { text: `    kept from the ${str(unresolved["keptReads"])} most recent unresolved reads${dropped > 0 ? ` (${dropped} older dropped)` : ""}` });
  }
  for (const w of (r["windows"] as Row[] | undefined) ?? []) {
    const left = w["remainingPercent"] === null || w["remainingPercent"] === undefined ? "?% left" : `${w["remainingPercent"]}% left`;
    const level = w["levelReason"] ? `${str(w["level"])} (${w["levelReason"]})` : str(w["level"]);
    const fresh = w["freshnessReason"] ? `${str(w["freshness"])}: ${w["freshnessReason"]}` : str(w["freshness"]);
    const seat = w["seatSession"] ? ` · by seat ${w["seatSession"]}` : "";
    lines.push({ text: `    ${windowName(w)}  ${left}` },
      { text: `      level: ${level}` },
      { text: `      freshness: ${fresh}` },
      { text: `      resets ${str(w["resetsAt"])} · observed ${str(w["observedAt"])}${seat}` });
    for (const d of (w["disagreeingSeats"] as Row[] | undefined) ?? []) {
      lines.push({ text: `      seat ${str(d["seatSession"])} reports ${str(d["usedPercent"])}% used · resets ${str(d["resetsAt"])} · observed ${str(d["observedAt"])}` });
    }
    const expect = w["expectation"] as Row | undefined;
    if (expect) lines.push({ text: `      expected full since ${str(expect["expectedFullSince"])}, not yet observed (${str(expect["note"])})` });
  }
  lines.push(...historyLines(r));
  // Whenever availability is unknown, say why (with windows too).
  if ((((r["windows"] as unknown[] | undefined) ?? []).length === 0 || r["currentAvailability"] === "unknown") && r["unavailableReason"]) lines.push({ text: `    ${r["unavailableReason"]}` });
  if (r["limitEvidence"]) lines.push({ text: `    limit evidence: ${r["limitEvidence"]}` });
  const last = r["lastRefresh"] as Row | null | undefined;
  if (last?.["outcome"] === "failed") {
    lines.push({ text: r["provider"] === "claude"
      ? `    identity refresh failed at ${str(last["at"])}: ${failureText(last)}; the identity shown is from the last refresh that worked, if any`
      : `    refresh failed at ${str(last["at"])}: ${failureText(last)}; last reading kept, marked old` });
  }
  lines.push({ text: `    current availability: ${str(r["currentAvailability"])}` });
  const signIn = signInText(r);
  if (signIn) lines.push({ text: `    ${signIn}` });
  return lines;
}

/** One served seat account, as served (also drawn per host by System → Usage across hosts). `differsFirst` (only the
 *  all-hosts page passes it) draws a seat's difference under the CLI's condition: whenever one is served, whatever
 *  `windowsSampled` or `withheld` say. Without it the single-host page draws as before. */
export function seatLines(r: Row, opts: { differsFirst?: boolean } = {}): ContentLine[] {
  const c = (r["configured"] ?? {}) as Row;
  const configured = c["source"] === "registry"
    ? `configured: profile ${str(c["profileRef"])} (registry, recorded ${str(c["recordedAt"])}${c["profileSaved"] === false ? "; profile not saved on this host" : c["profileSaved"] === null ? "; whether the profile is saved: unknown" : ""})`
    : c["source"] === "default_login"
      ? `configured: default login${c["home"] ? ` (${c["home"]})` : ""}`
      : `configured: unknown (${str(c["reason"])})`;
  const lines: ContentLine[] = [{ text: `  ${str(r["seatSession"])}  ${str(r["runtime"])}  ${configured} · allowance not linked` }];
  if (c["source"] === "default_login" && c["homeNote"]) lines.push({ text: `    ${c["homeNote"]}` });
  for (const note of (r["registryNotes"] as string[] | undefined) ?? []) lines.push({ text: `    ${note}` });
  const observed = r["observed"] as Row | undefined;
  const differs = (observed?.["differsFrom"] as string[] | undefined) ?? [];
  const differsLine = (): ContentLine => ({ text: `    observed: differs from ${differs.join(", ")}${observed?.["note"] !== undefined ? ` (${observed["note"]})` : ""}` });
  if (opts.differsFirst && differs.length) lines.push(differsLine());
  else if (observed?.["withheld"] === true) lines.push({ text: `    observed: ${str(observed["note"], "withheld")}` });
  else if (observed?.["windowsSampled"] === true) {
    lines.push({ text: `    observed: this seat's status line last reported windows at ${str(observed["lastSampledAt"], "an unknown time")}` });
    if (differs.length) lines.push(differsLine());
  } else if (observed?.["windowsSampled"] === false) lines.push({ text: "    observed: no status-line windows from this seat yet" });
  else if (observed?.["note"]) lines.push({ text: `    observed: ${observed["note"]}` });
  const allowance = (r["allowance"] ?? {}) as Row;
  if (allowance["reason"]) lines.push({ text: `    allowance not linked: ${allowance["reason"]}` });
  return lines;
}

/** Why the model has no usage rows: off on this daemon, or a daemon that doesn't serve them. */
function absentLines(read: UsageRead): ContentLine[] {
  const s = read.switchSetting;
  if (s === "absent") return [{ text: "  This daemon doesn't serve usage windows (it doesn't know the provider.usage_windows setting)." }];
  if (s === null || s === undefined) return [{ text: "  No usage windows served. Whether they're off or not supported by this daemon couldn't be read." }];
  if (s.value === true) return [{ text: `  provider.usage_windows is on (${str(s.source)}), but this daemon served no usage windows.` }];
  return [{ text: `  Usage windows are off on this daemon (provider.usage_windows = ${str(s.value)}${s.source ? `, ${s.source}` : ""}).` },
    { text: "  Turn them on with: rig config set provider.usage_windows true" }];
}

export function usageLines(snap: FleetSnapshot, width: number): ContentLine[] {
  const lines: ContentLine[] = [{ text: "System · Usage windows and seat accounts" }, { text: `  ${USAGE_HEADER}` }, { text: `  ${USAGE_REFRESH_HINT}` }];
  const read = snap.usage;
  if (!read) return wrapDetailLines([...lines, { text: "" }, { text: "  Not read yet." }], width);
  if (!("model" in read.status)) {
    const failure = read.status;
    lines.push({ text: "" }, failure.status === 404
      ? { text: "  This daemon doesn't serve usage windows (no provider read model: HTTP 404)." }
      : { text: `  Usage windows unavailable: ${failure.error}. Nothing is inferred from the missing read.` });
    return wrapDetailLines(lines, width);
  }
  const model = read.status.model;
  lines.push(sectionRule("Usage windows", width));
  if (Array.isArray(model["usage"])) {
    const rows = model["usage"] as Row[];
    if (rows.length === 0) lines.push({ text: "  No usage rows served." });
    for (const r of rows) lines.push(...allowanceLines(r));
    const saved = rows.find((r) => r["savedProfiles"])?.["savedProfiles"] as Row | undefined;
    if (saved) lines.push({ text: `  ${str(saved["note"])}: ${((saved["names"] as string[] | undefined) ?? []).join(", ")}` });
  } else {
    lines.push(...absentLines(read));
  }
  lines.push(sectionRule("Seats · configured account (not proof of the login a running session uses)", width));
  if (Array.isArray(model["seatAccounts"])) {
    const seats = model["seatAccounts"] as Row[];
    if (seats.length === 0) lines.push({ text: "  No seats served." });
    for (const r of seats) lines.push(...seatLines(r));
  } else if (Array.isArray(model["usage"])) {
    lines.push({ text: "  This daemon doesn't serve seat accounts." });
  } else {
    lines.push({ text: "  Seat accounts are served only while usage windows are." });
  }
  return wrapDetailLines(lines, width);
}
