import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { Action, FleetSnapshot, HealthEvidenceReference, HealthRecord } from "../types.js";
import type { Token } from "../theme.js";

export type HealthDisplayScope =
  | { kind: "instance"; local: boolean }
  | { kind: "rig"; rigId: string; rigName: string; local: boolean }
  | { kind: "seat"; rigId: string; seatId: string | null; seatName: string; local: boolean };

function scopeMatches(record: HealthRecord, scope: HealthDisplayScope): boolean {
  if (scope.kind === "instance") return true;
  if (scope.kind === "rig") {
    return (record.scope.type === "rig" && record.scope.rigId === scope.rigId)
      || (record.scope.type === "seat" && record.scope.rigId === scope.rigId);
  }
  return record.scope.type === "seat"
    && record.scope.rigId === scope.rigId
    && scope.seatId !== null
    && record.scope.seatId === scope.seatId;
}

export function healthRecordsForScope(snap: FleetSnapshot, scope: HealthDisplayScope): HealthRecord[] {
  return [...(snap.health?.records ?? [])].filter((record) => scopeMatches(record, scope)).sort(compareHealthRecords);
}

function compareHealthRecords(a: HealthRecord, b: HealthRecord): number {
  const status = { active: 0, indeterminate: 1, cleared: 2 } as const;
  const severity = { critical: 0, warning: 1, info: 2 } as const;
  return status[a.status] - status[b.status]
    || severity[a.severity] - severity[b.severity]
    || Date.parse(b.lastObservedAt ?? "") - Date.parse(a.lastObservedAt ?? "")
    || a.id.localeCompare(b.id, "en-US");
}

function tokenFor(record: HealthRecord): Token {
  if (record.status === "indeterminate" || record.freshness.state !== "fresh") return "warn";
  if (record.status === "cleared") return "dim";
  if (record.severity === "critical") return "error";
  if (record.severity === "warning") return "warn";
  return "info";
}

function conditionLabel(record: HealthRecord): string | null {
  if (record.freshness.state === "stale") return "STALE";
  if (record.status === "indeterminate" || record.freshness.state === "unavailable" || record.freshness.state === "contradictory") return "Unknown";
  if (record.status === "cleared") return "CLEARED";
  return null;
}

function stateLabel(record: HealthRecord): string {
  const condition = conditionLabel(record);
  return `${record.severity.toUpperCase()}${condition ? ` ${condition}` : ""}`;
}

function signalLabel(record: HealthRecord): string {
  const condition = conditionLabel(record);
  return `${condition ? `${condition} · ` : ""}${record.summary}`;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function cell(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - clipped.length));
}

function fitLine(parts: Array<{ text: string; token?: Token; bold?: boolean }>, width: number, action?: Action): ContentLine {
  const out: NonNullable<ContentLine["segs"]> = [];
  let room = Math.max(0, width);
  for (const part of parts) {
    if (room <= 0) break;
    const text = clip(part.text, room);
    out.push({ ...part, text });
    room -= text.length;
    if (text.length < part.text.length) break;
  }
  return { text: out.map((part) => part.text).join(""), segs: out, ...(action ? { action } : {}) };
}

function scopeName(record: HealthRecord, snap: FleetSnapshot): string {
  const recordScope = record.scope;
  switch (recordScope.type) {
    case "instance": return recordScope.instanceId;
    case "rig": return snap.hosts.flatMap((host) => host.rigs).find((rig) => rig.id === recordScope.rigId)?.name ?? recordScope.rigId;
    case "seat": {
      for (const host of snap.hosts) for (const rig of host.rigs) for (const pod of rig.pods) {
        const agent = pod.agents.find((candidate) => candidate.nodeId === recordScope.seatId);
        if (agent) return agent.name;
      }
      return recordScope.seatId;
    }
    case "mission": return recordScope.missionId;
    case "slice": return recordScope.sliceId;
  }
}

function age(record: HealthRecord): string {
  const seconds = record.freshness.ageSeconds;
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function evidenceSummary(record: HealthRecord): string {
  if (record.evidence.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const evidence of record.evidence) counts.set(evidence.type, (counts.get(evidence.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => `${type}${count > 1 ? ` ×${count}` : ""}`).join(", ");
}

function scopedEmptyLabel(scope: HealthDisplayScope): string {
  return scope.kind === "instance" ? "EMPTY" : `EMPTY FOR ${scope.kind.toUpperCase()}`;
}

function unavailableLine(width: number, reason = "canonical health records could not be read"): ContentLine {
  return fitLine([
    { text: "HEALTH  ", token: "bright", bold: true },
    { text: "Unknown", token: "warn", bold: true },
    { text: ` · ${reason}`, token: "dim" },
  ], width);
}

function unavailableReason(snap: FleetSnapshot, scope: HealthDisplayScope): string | null {
  if (!scope.local) return "Unavailable · remote instance findings are not served";
  if (!snap.health) return "Not assessed · health has not been loaded in this view";
  if (snap.health.availability !== "loaded") return "Unavailable · canonical health records could not be read";
  if (scope.kind === "seat" && scope.seatId === null) return "Unavailable · stable seat identity was not served; findings cannot be scoped";
  return null;
}

/** A source evaluated only part of its input; its omitted items are unevaluated. */
function partialCoverage(snap: FleetSnapshot) {
  return (snap.health?.coverage ?? []).filter((c) => c.partial);
}

function emptyLine(scope: HealthDisplayScope, width: number, snap: FleetSnapshot): ContentLine {
  return fitLine([
    { text: "HEALTH  ", token: "bright", bold: true },
    { text: scopedEmptyLabel(scope), token: "dim", bold: true },
    { text: " · no findings served; not a healthy verdict", token: "dim" },
    ...(partialCoverage(snap).length ? [{ text: " · PARTIAL", token: "warn" as const, bold: true }] : []),
  ], width);
}

export function healthSummaryLine(snap: FleetSnapshot, scope: HealthDisplayScope, width: number): ContentLine {
  const unavailable = unavailableReason(snap, scope);
  if (unavailable) return unavailableLine(width, unavailable);
  const records = healthRecordsForScope(snap, scope);
  if (records.length === 0) return emptyLine(scope, width, snap);
  const active = records.filter((record) => record.status === "active");
  const counts = {
    critical: active.filter((record) => record.severity === "critical").length,
    warning: active.filter((record) => record.severity === "warning").length,
    info: active.filter((record) => record.severity === "info").length,
  };
  const categories = new Map<string, number>();
  for (const record of active) categories.set(record.category, (categories.get(record.category) ?? 0) + 1);
  const categoryText = [...categories].sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([name, count]) => `${name} ${count}`).join(" ");
  const indeterminate = records.filter((record) => record.status === "indeterminate").length;
  const top = records[0]!;
  const compact = width < 80;
  return fitLine([
    { text: "HEALTH  ", token: "bright", bold: true },
    { text: compact ? "ACTIVE " : "ACTIVE · ", token: "bright", bold: true },
    { text: `CRIT ${counts.critical}`, token: counts.critical ? "error" : "dim", bold: counts.critical > 0 },
    { text: `  WARN ${counts.warning}`, token: counts.warning ? "warn" : "dim", bold: counts.warning > 0 },
    ...(!compact ? [{ text: `  INFO ${counts.info}`, token: counts.info ? "info" as const : "dim" as const }] : []),
    ...(indeterminate > 0 ? [{ text: ` · Unknown ${indeterminate}`, token: "warn" as const, bold: true }] : []),
    ...(categoryText ? [{ text: compact ? ` · TYPE ${categoryText}` : ` · BY TYPE ${categoryText}`, token: "bright" as const }] : []),
    { text: ` · ${stateLabel(top)} ${top.summary}`, token: tokenFor(top) },
    ...(snap.health?.truncated || partialCoverage(snap).length ? [{ text: " · PARTIAL", token: "warn" as const, bold: true }] : []),
  ], width, { type: "tab", tab: "health" });
}

function healthColumnWidths(width: number) {
  const wide = width >= 100;
  const sevWidth = 13;
  const scopeWidth = wide ? 18 : 12;
  const ageWidth = wide ? 7 : 5;
  const confWidth = 6;
  const evidenceWidth = wide ? Math.min(22, Math.max(14, Math.floor(width * 0.24))) : 0;
  const fixed = sevWidth + scopeWidth + ageWidth + (wide ? confWidth + evidenceWidth + 5 : 3);
  const signalWidth = Math.max(12, width - fixed);
  return { wide, sevWidth, signalWidth, scopeWidth, ageWidth, confWidth, evidenceWidth };
}

function healthTableRow(record: HealthRecord, snap: FleetSnapshot, width: number): ContentLine {
  const { wide, sevWidth, signalWidth, scopeWidth, ageWidth, confWidth, evidenceWidth } = healthColumnWidths(width);
  const values = [
    cell(record.severity.toUpperCase(), sevWidth),
    cell(signalLabel(record), signalWidth),
    cell(scopeName(record, snap), scopeWidth),
    cell(age(record), ageWidth),
    ...(wide ? [cell(record.confidence, confWidth), cell(evidenceSummary(record), evidenceWidth)] : []),
  ];
  const text = values.join(" ").trimEnd();
  return {
    text,
    segs: [{ text: values[0]!, token: tokenFor(record), bold: record.status === "active" }, { text: text.slice(values[0]!.length), token: "bright" }],
    action: { type: "health-open", findingId: record.id },
  };
}

export function healthListLines(snap: FleetSnapshot, scope: HealthDisplayScope, width: number): ContentLine[] {
  const unavailable = unavailableReason(snap, scope);
  if (unavailable) return wrapDetailLines([{ text: `HEALTH  Unknown · ${unavailable}` }], width);
  const records = healthRecordsForScope(snap, scope);
  // Wrap the complete page explanation; compact summary callers still fit one line.
  if (records.length === 0) return wrapDetailLines([emptyLine(scope, Infinity, snap)], width);
  const { wide, sevWidth, signalWidth, scopeWidth, ageWidth, confWidth, evidenceWidth } = healthColumnWidths(width);
  const columns = [
    cell("SEV", sevWidth),
    cell("SIGNAL", signalWidth),
    cell("SCOPE", scopeWidth),
    cell("AGE", ageWidth),
    ...(wide ? [cell("CONF", confWidth), cell("EVIDENCE", evidenceWidth)] : []),
  ].join(" ").trimEnd();
  const heading = fitLine([{ text: columns, token: "dim", bold: true }], width);
  const lines: ContentLine[] = [sectionRule(`HEALTH · ${scope.kind} · canonical findings`, width), heading, { text: "─".repeat(Math.min(width, Math.max(1, heading.text.length))) }];
  lines.push(...records.map((record) => healthTableRow(record, snap, width)));
  if (snap.health?.truncated) lines.push(fitLine([{ text: "PARTIAL · daemon result limit reached", token: "warn", bold: true }], width));
  for (const c of partialCoverage(snap)) lines.push(fitLine([{ text: `PARTIAL · ${c.source} evaluated ${c.evaluated} of ${c.total} ${c.unit}; ${c.omitted} omitted were not evaluated and are not healthy`, token: "warn", bold: true }], width));
  lines.push(fitLine([{ text: "Enter opens explanation and typed evidence · Escape returns", token: "dim" }], width));
  return lines;
}

function value(evidence: HealthEvidenceReference, key: string): string {
  const item = evidence[key];
  if (item === null || item === undefined) return "—";
  if (Array.isArray(item)) return item.join(", ");
  return String(item);
}

function evidenceText(evidence: HealthEvidenceReference): string {
  switch (evidence.type) {
    case "queue-transition": return `qitem ${value(evidence, "qitemId")} · transition ${value(evidence, "transitionId")} · ${value(evidence, "state")} · actor ${value(evidence, "actorSession")}`;
    case "watchdog-history": return `job ${value(evidence, "jobId")} · history ${value(evidence, "historyId")} · ${value(evidence, "outcome")} · delivery ${value(evidence, "deliveryStatus")}`;
    case "work-graph": return `${value(evidence, "nodeType")} ${value(evidence, "nodeId")} · mission ${value(evidence, "missionId")} · stage ${value(evidence, "stage")} · depends on ${value(evidence, "dependsOn")}`;
    case "topology-activity": return `node ${value(evidence, "nodeId")} · session ${value(evidence, "sessionName")} · activity ${value(evidence, "activity")} · sequence ${value(evidence, "activitySequence")}`;
    case "context-usage": return `node ${value(evidence, "nodeId")} · session ${value(evidence, "sessionId")} · used ${value(evidence, "usedPercentage")}% · available ${value(evidence, "available")} · fresh ${value(evidence, "fresh")}`;
    case "occupant-model": return `node ${value(evidence, "nodeId")} · generation ${value(evidence, "occupantGeneration")} · runtime ${value(evidence, "runtime")} · model ${value(evidence, "model")}`;
    case "lifecycle-receipt": return `receipt ${value(evidence, "receiptId")} · ${value(evidence, "operation")} · ${value(evidence, "outcome")}`;
  }
}

function wrap(label: string, text: string, width: number, token: Token = "bright"): ContentLine[] {
  const prefix = `  ${`${label}:`.padEnd(12)} `;
  return wrapDetailLines([{ text: prefix + (text.trim() || "—") }], width).map((line, index) => ({
    ...line, segs: index === 0 && line.text.startsWith(prefix)
      ? [{ text: prefix, token: "dim" }, { text: line.text.slice(prefix.length), token }]
      : [{ text: line.text, token }],
  }));
}

export function healthDetailLines(snap: FleetSnapshot, findingId: string, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  const record = snap.health?.records.find((candidate) => candidate.id === findingId);
  if (!record) return [fitLine([{ text: `HEALTH finding ${findingId} is no longer in the bounded canonical read`, token: "warn" }], width)];
  const lines: ContentLine[] = [
    fitLine([{ text: `${stateLabel(record)}  `, token: tokenFor(record), bold: true }, { text: record.detector, token: "bright", bold: true }, { text: " · Escape returns", token: "dim" }], width),
    { text: "" },
    sectionRule("SIGNAL", width),
    ...wrap("summary", record.summary, width),
    ...wrap("assessment", record.status === "indeterminate" || record.freshness.state !== "fresh" ? "Unknown" : record.status, width),
    ...(record.indeterminateReason ? wrap("reason", record.indeterminateReason, width, "warn") : []),
    ...wrap("finding id", record.id, width),
    ...wrap("scope", scopeName(record, snap), width),
    ...wrap("category", record.category, width),
    ...wrap("severity", record.severity, width, tokenFor(record)),
    ...wrap("status", record.status, width),
    ...(record.ceremony ? wrap("diagnosis stage", record.ceremony.stage, width) : []),
    ...wrap("confidence", record.confidence, width),
    ...wrap("freshness", `${record.freshness.state} · source age ${age(record)}`, width),
    ...wrap("started", displayTime(record.startedAt, timeZone), width),
    ...wrap("observed", displayTime(record.lastObservedAt, timeZone), width),
    { text: "" },
    sectionRule("EXPLANATION", width),
    ...wrap("why", record.explanation, width),
    ...wrap("threshold", record.threshold, width),
    ...wrap("policy", record.policyVersion ?? "not reported by source", width),
    ...(record.operatingPosture ? [
      ...wrap("posture", `${record.operatingPosture.posture} · ${record.operatingPosture.source}${record.operatingPosture.binding ? " · " + record.operatingPosture.binding.id : ""}`, width),
      ...wrap("work phase", `${record.operatingPosture.context?.phase.value ?? "unknown"} · ${record.operatingPosture.context?.phase.source ?? "unavailable"}`, width),
      ...wrap("oversight", record.operatingPosture.reason, width),
    ] : []),
    ...wrap("inspect", record.suggestedInspection, width),
    ...(record.indeterminateReason ? wrap("unknown", record.indeterminateReason, width, "warn") : []),
    { text: "" },
    sectionRule(`EVIDENCE · ${record.evidence.length}`, width),
  ];
  if (record.ceremony) {
    for (const ref of record.ceremony.context) lines.push(...wrap("normal context", `${ref.role}: ${ref.path} (${ref.state}${ref.sha256 ? ` sha256:${ref.sha256}` : ""})`, width));
    lines.push(...wrap("assessment basis", record.ceremony.basis, width));
  }
  if (record.evidence.length === 0) lines.push(...wrap("evidence", "none served", width, "warn"));
  for (const evidence of record.evidence) {
    lines.push(...wrap(evidence.type, evidenceText(evidence), width));
    lines.push(...wrap("observed", displayTime(evidence.observedAt, timeZone), width, evidence.observedAt ? "dim" : "warn"));
  }
  return lines;
}

export function healthAgentLines(snap: FleetSnapshot, scope: Extract<HealthDisplayScope, { kind: "seat" }>, width: number): ContentLine[] {
  const unavailable = unavailableReason(snap, scope);
  if (unavailable) return [unavailableLine(width, unavailable)];
  const records = healthRecordsForScope(snap, scope);
  if (records.length === 0) return [emptyLine(scope, width, snap)];
  return records.map((record) => fitLine([
    { text: `${stateLabel(record).padEnd(13)} `, token: tokenFor(record), bold: record.status === "active" },
    { text: record.summary, token: "bright" },
  ], width, { type: "health-open", findingId: record.id }));
}
