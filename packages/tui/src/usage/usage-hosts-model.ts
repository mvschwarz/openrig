import { sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { FleetSnapshot } from "../types.js";
import { allowanceLines, failureText, identityLabel, seatLines, str, type Row } from "./usage-model.js";

// Slice 01 — System → Usage across hosts: usage windows on the registered hosts, as this daemon reads them
// (GET /api/provider/usage/hosts, the same body `rig provider status --all-hosts --json` prints). Each host's rows are
// drawn as that host served them, with the per-row lines of System → Usage; the grouping by allowance, the linkage,
// the notes and every host's status come from the daemon. Nothing is grouped, summed, thresholded or re-timed here,
// and this view never asks for a refresh.

export interface UsageHostsRead {
  /** The served view, or why it couldn't be read (status null: no HTTP answer; message: the daemon's own text). */
  status: { view: Row } | { status: number | null; error: string; message?: string };
}

export const USAGE_HOSTS_HEADER = "registered hosts, as this daemon reads them · not proof of the login a running session uses";
export const USAGE_HOSTS_HINT = "This view shows what the hosts already hold. It never starts a refresh or reads the logins. To read them now: rig provider status --all-hosts --refresh [--provider codex|claude]";

const indent = (lines: ContentLine[], pad: string): ContentLine[] => lines.map((l) => ({ ...l, text: pad + l.text }));

function hostLines(h: Row): ContentLine[] {
  const transport = h["status"] === "ok" ? "answered" : `${str(h["status"])}${h["error"] ? ` (${h["error"]})` : ""}`;
  const usage = h["usage"] === "served" ? "usage windows served" : `usage ${str(h["usage"])}${h["usageReason"] ? `: ${h["usageReason"]}` : ""}`;
  const lines: ContentLine[] = [{ text: `  ${str(h["hostId"])}  ${transport} · ${usage}${h["readAt"] ? ` · read ${h["readAt"]}` : ""}` }];
  for (const leg of Object.values((h["lastRefresh"] ?? {}) as Record<string, Row>)) {
    lines.push({ text: leg["outcome"] === "failed"
      ? `    refresh from here (${str(leg["provider"])}) failed at ${str(leg["at"])}: ${failureText(leg)}; this host's earlier observations are kept`
      : `    refresh from here (${str(leg["provider"])}) answered at ${str(leg["at"])}` });
  }
  return lines;
}

function groupLines(g: Row): ContentLine[] {
  const observations = (g["observations"] as Row[] | undefined) ?? [];
  const hosts = [...new Set(observations.map((o) => str(o["hostId"])))];
  const id = (observations[0]?.["row"] as Row | undefined)?.["identity"] as Row | null | undefined;
  const linkage = g["linkage"] === "same" ? `the same allowance on ${hosts.length} hosts: ${hosts.join(", ")}`
    : g["linkage"] === "conflict" ? `the same allowance on ${hosts.length} hosts, disagreeing: ${hosts.join(", ")}`
      : g["linkage"] === "single" ? `observed on ${hosts[0] ?? "unknown"}`
        : `linkage unknown; observed on ${hosts.join(", ")}`;
  const lines: ContentLine[] = [{ text: `  ${str(g["provider"])}  ${id ? `${identityLabel(id)} · bucket ${str(id["limitId"])}` : "not read yet"}  [${linkage}]` }];
  for (const note of (g["notes"] as string[] | undefined) ?? []) lines.push({ text: `    ! ${note}` });
  for (const o of observations) {
    lines.push({ text: `    on ${str(o["hostId"])} (read ${str(o["readAt"])}):` });
    lines.push(...indent(allowanceLines((o["row"] ?? {}) as Row), "    "));
  }
  return lines;
}

export function usageHostsLines(snap: FleetSnapshot, width: number): ContentLine[] {
  const lines: ContentLine[] = [{ text: "System · Usage across hosts" }, { text: `  ${USAGE_HOSTS_HEADER}` }, { text: `  ${USAGE_HOSTS_HINT}` }];
  const read = snap.usageHosts;
  if (!read) return wrapDetailLines([...lines, { text: "" }, { text: "  Not read yet." }], width);
  if (!("view" in read.status)) {
    const failure = read.status;
    lines.push({ text: "" }, failure.status === 404
      ? { text: "  This daemon doesn't serve usage across hosts (HTTP 404)." }
      : failure.status === 409 && failure.message
        ? { text: `  ${failure.message}` }
        : { text: `  Usage across hosts unavailable: ${failure.error}. Nothing is inferred from the missing read.` });
    return wrapDetailLines(lines, width);
  }
  const view = read.status.view;
  lines.push(sectionRule("Hosts", width));
  for (const h of (view["hosts"] as Row[] | undefined) ?? []) lines.push(...hostLines(h));
  for (const s of (view["skipped"] as Row[] | undefined) ?? []) lines.push({ text: `  ${str(s["hostId"])}  skipped: ${str(s["reason"])}` });
  const registry = (view["registry"] ?? {}) as Row;
  if (registry["state"] !== "read") lines.push({ text: `  host registry ${str(registry["state"])}${registry["note"] ? `: ${registry["note"]}` : ""}` });
  lines.push(sectionRule("Allowances · one entry per allowance; each host's observation as that host served it, never summed", width));
  const groups = (view["items"] as Row[] | undefined) ?? [];
  if (groups.length === 0) lines.push({ text: "  No usage rows served." });
  for (const g of groups) lines.push(...groupLines(g));
  for (const s of (view["seatAccounts"] as Row[] | undefined) ?? []) {
    lines.push(sectionRule(`Seats on ${str(s["hostId"])} · configured account (not proof of the login a running session uses)`, width));
    const seats = (s["seats"] as Row[] | undefined) ?? [];
    if (seats.length === 0) lines.push({ text: "  No seats served." });
    for (const r of seats) lines.push(...seatLines(r, { differsFirst: true }));
  }
  return wrapDetailLines(lines, width);
}
