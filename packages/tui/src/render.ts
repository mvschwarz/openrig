import { helpScreen } from "./commands/help.js";
import { commandFocusVisible } from "./motion.js";
import { attentionLines } from "./attention/attention-model.js";
import { fileLines, externalLines, fileTargetForPath, referenceLines, referenceAction } from "./reading.js";
import { DEFAULT_TIME_ZONE, displayTime } from "./time.js";
import { startupLines, type StartupState } from "./startup.js";
import { configLines } from "./config/config-model.js";
import { connectionsLines } from "./connections/connections-model.js";
// Hand-rolled ANSI renderer (Phase-0 substrate decision). Pure function:
// (state, snapshot) → {lines, hitMap, explorerRows}. BOTH panes emit hit
// targets — explorer rows AND content-pane surfaces (table rows, view tabs,
// agent-refs, Needs-You items) — so a mouse click anywhere resolves to the
// SAME semantic actions commands produce (PIN 1). Isolated seam: a substrate
// swap touches only this module (spike verdict revisit trigger).
import { computeExplorerRows, findAgent, findSpec, findAgentBySession, agentsRunningSpec, agentsRunningSpecTargets, specDetailArrowsScroll } from "./state.js";
import { scopesContentLines } from "./scopes/scopes-model.js";
import { executionContentLines, executionSliceStripLines } from "./execution/execution-model.js";
import { navigatorDisplay } from "./navigator.js";
import { renderGraphStyle } from "./topology/render-graph.js";
import { buildPulseModel } from "./pulse/pulse-model.js";
import { renderPulseView, pulseLaneTargets } from "./pulse/render-pulse.js";
import { renderCrashCartView, renderUnverifiedView, renderRestoreLifecycleView, renderConfirmBanner } from "./crash-cart/render-crash-cart.js";
import type { RestoreLifecycleVM } from "./crash-cart/restore-lifecycle.js";
import { buildLedgerExplorer } from "./crash-cart/ledger-explorer.js";
import type { CrashCartModel } from "./crash-cart/crash-cart-model.js";
import type { DaemonState, DaemonUnverifiedEvidence } from "./crash-cart/contract.js";
import { runtimeMarkSegs } from "./topology/runtime-marks.js";
import { barCells, flashActive, reducedMotion, spinnerFrame } from "./motion.js";
import { explorerWidth, MOTION_FRAME_MS } from "./visual-layout.js";
import type { ColorMode, Token } from "./theme.js";
import { terminalLines } from "./terminals/terminal-model.js";
import { detailPage, fieldLine, sectionRule, listItem, alignedRow, LABEL_W, wrapDetailLines } from "./detail.js";
import { healthAgentLines, healthDetailLines, healthListLines, healthSummaryLine } from "./health/health-model.js";
import type { Action, FleetSnapshot, LoadState, NeedsItem, RecentTransitionSnap, RowFlash, Screen, ViewState } from "./types.js";

interface ContentLine {
  text: string;
  /** dispatched when this line is clicked (open/navigate class only) */
  action?: Action;
  /** sub-line click zones (content-relative indices); matched before `action`.
   * BR-9: zone actions are drive-structure only (lifecycle + navigation). */
  zones?: Array<{ start: number; end: number; action: Action }>;
  /** slice-17: token segments for canvas-rendered rows (graph view) */
  segs?: Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean; bg?: import("./theme.js").Token }>;
}

function pad(text: string | number | null | undefined, width: number): string {
  const t = String(text ?? "");
  if (t.length <= width) return t + " ".repeat(width - t.length);
  // never hard-clip mid-word: any truncation reads as an ellipsis (glance honesty)
  return t.slice(0, Math.max(width - 1, 0)) + "…";
}

function padLeft(text: string | number | null | undefined, width: number): string {
  const t = String(text ?? "");
  if (t.length <= width) return " ".repeat(width - t.length) + t;
  return t.slice(0, Math.max(width - 1, 0)) + "…";
}

type Align = "left" | "right";
type AgentColumnKey = "rig" | "pod" | "seat" | "runtime" | "model" | "context" | "status" | "queue" | "work" | "now" | "actions";
type AgentColumn = [key: AgentColumnKey, name: string, width: number, align: Align];

function columnsWidth(columns: AgentColumn[]): number {
  return columns.reduce((total, [, , width]) => total + width + 1, -1);
}

function agentColumns(contentWidth: number): AgentColumn[] {
  if (contentWidth >= 110) return [
    ["pod", "POD", 8, "left"], ["seat", "SEAT", 15, "left"], ["runtime", "RT", 4, "left"],
    ["model", "MODEL", 12, "left"], ["context", "CTX", 8, "right"], ["status", "STATE", 11, "left"],
    ["queue", "Q", 3, "right"], ["work", "WORK", 15, "left"], ["now", "NOW", 27, "left"],
    ["actions", "ACTIONS", 14, "left"],
  ];
  if (contentWidth >= 88) return [
    ["pod", "POD", 6, "left"], ["seat", "SEAT", 12, "left"], ["runtime", "RT", 3, "left"],
    ["model", "MODEL", 8, "left"], ["context", "CTX", 6, "right"], ["status", "STATE", 9, "left"],
    ["queue", "Q", 2, "right"], ["work", "WORK", 8, "left"], ["now", "NOW", 11, "left"],
    ["actions", "ACTIONS", 14, "left"],
  ];
  // At 84x28 the L2 content pane is 58 cells. The three explicitly deferred
  // columns (MODEL/NOW/ACTIONS) move to drill; identity, state and work remain.
  const fixed = 6 + 12 + 3 + 5 + 9 + 2 + 6; // widths + separators, excluding WORK
  return [
    ["pod", "POD", 6, "left"], ["seat", "SEAT", 12, "left"], ["runtime", "RT", 3, "left"],
    ["context", "CTX", 5, "right"], ["status", "STATE", 9, "left"], ["queue", "Q", 2, "right"],
    ["work", "WORK", Math.max(4, contentWidth - fixed), "left"],
  ];
}

function instanceAgentColumns(contentWidth: number): AgentColumn[] {
  if (contentWidth >= 110) return [
    ["rig", "RIG", 13, "left"], ["pod", "POD", 8, "left"], ["seat", "SEAT", 14, "left"],
    ["runtime", "RT", 3, "left"], ["context", "CTX", 7, "right"], ["status", "STATE", 10, "left"],
    ["queue", "Q", 2, "right"], ["work", "WORK", 12, "left"], ["now", "NOW", Math.max(18, contentWidth - 78), "left"],
  ];
  if (contentWidth >= 78) return [
    ["rig", "RIG", 10, "left"], ["pod", "POD", 6, "left"], ["seat", "SEAT", 12, "left"],
    ["runtime", "RT", 3, "left"], ["context", "CTX", 5, "right"], ["status", "STATE", 9, "left"],
    ["queue", "Q", 2, "right"], ["work", "WORK", Math.max(8, contentWidth - 54), "left"],
  ];
  const fixed = 8 + 5 + 11 + 2 + 5 + 8 + 2 + 7;
  return [
    ["rig", "RIG", 8, "left"], ["pod", "POD", 5, "left"], ["seat", "SEAT", 11, "left"],
    ["runtime", "RT", 2, "left"], ["context", "CTX", 5, "right"], ["status", "STATE", 8, "left"],
    ["queue", "Q", 2, "right"], ["work", "WORK", Math.max(4, contentWidth - fixed), "left"],
  ];
}

function tableRow(columns: AgentColumn[], cells: Partial<Record<AgentColumnKey, string | number | null>>): string {
  return columns.map(([key, , width, align]) => align === "right" ? padLeft(cells[key], width) : pad(cells[key], width)).join(" ");
}

function runtimeShort(runtime: string): string {
  if (/claude/i.test(runtime)) return "cl";
  if (/codex/i.test(runtime)) return "cx";
  if (/terminal/i.test(runtime)) return ">_";
  if (/human/i.test(runtime)) return "hu";
  return runtime.slice(0, 2) || "—";
}

/** Tables optimize for glance width; details retain the canonical model id. */
function tableModel(model: string | null | undefined): string {
  return model?.replace(/^claude-/i, "") || "—";
}

function contextCompact(value: number | null, narrow: boolean): string {
  if (value == null) return "—";
  if (narrow) return `${value}%`;
  const filled = Math.max(0, Math.min(3, Math.round(value / 33.4)));
  return `${value}%${"▪".repeat(filled)}${"▫".repeat(3 - filled)}`;
}

function seatName(pod: string, name: string): string {
  for (const prefix of [`${pod}.`, `${pod}-`]) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

function operationalState(status: string, motion: MotionCtx): { mark: string; word: string } {
  const key = status.toLowerCase().replaceAll("_", "-");
  if (key === "active" || key === "working" || key === "running") {
    if (!motion.reduced) motion.used = true;
    return { mark: motion.reduced ? "●" : motion.frame, word: "working" };
  }
  if (key === "attention-required" || key === "needs-attention" || key === "needs-input")
    return { mark: "◐", word: "needs you" };
  if (key === "blocked") return { mark: "⚑", word: "blocked" };
  if (key === "failed" || key === "down") return { mark: "✕", word: "failed" };
  if (key === "idle") return { mark: "·", word: "idle" };
  if (key === "detached" || key === "stopped") return { mark: "○", word: "detached" };
  return { mark: "?", word: "unknown" };
}

function queueFacts(snap: FleetSnapshot, session: string | null | undefined): { count: number; work: string; now: string } {
  if (!session) return { count: 0, work: "—", now: "—" };
  const sources: Array<["needs you" | "blocked" | "working" | "queued", FleetSnapshot["attention"]]> = [
    ["needs you", snap.attention], ["blocked", snap.blocked], ["working", snap.inProgress], ["queued", snap.pending],
  ];
  const rows: Array<{ role: string; row: FleetSnapshot["attention"][number] }> = [];
  const seen = new Set<string>();
  for (const [role, items] of sources) for (const row of items) {
    if (row.destinationSession !== session || seen.has(row.qitemId)) continue;
    seen.add(row.qitemId);
    rows.push({ role, row });
  }
  const primary = rows[0];
  if (!primary) return { count: 0, work: "—", now: "—" };
  const slice = primary.row.tags?.find((tag) => tag.startsWith("slice:"))?.slice("slice:".length);
  const work = slice?.match(/^OPR(?:\.\d+){3}\.(\d+)$/)?.[1]
    ? `S${slice.slice(slice.lastIndexOf(".") + 1)}`
    : slice ?? "—";
  const summary = primary.row.summary?.trim() || primary.row.body.split("\n").find((line) => line.trim())?.trim() || primary.row.qitemId;
  const now = primary.role === "working" ? summary : `${primary.role} · ${summary}`;
  return { count: rows.length, work, now };
}

function number(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("en-US");
}

function wrapDetailValue(label: string, value: string, width: number): ContentLine[] {
  const prefix = `  ${`${label}:`.padEnd(LABEL_W)} `;
  const continuation = " ".repeat(prefix.length);
  const room = Math.max(8, width - prefix.length);
  const words = value.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let line = "";
  for (const raw of words) {
    let word = raw;
    while (word.length > room) {
      if (line) { chunks.push(line); line = ""; }
      chunks.push(word.slice(0, room));
      word = word.slice(room);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + word.length + 1 <= room) line += ` ${word}`;
    else { chunks.push(line); line = word; }
  }
  if (line) chunks.push(line);
  return (chunks.length ? chunks : [""]).map((chunk, index) => ({ text: `${index === 0 ? prefix : continuation}${chunk}` }));
}

function rowsForAgent(snap: FleetSnapshot, session: string, sources: Array<FleetSnapshot["attention"]>): FleetSnapshot["attention"] {
  const rows: FleetSnapshot["attention"] = [];
  const seen = new Set<string>();
  for (const source of sources) for (const row of source) {
    if (row.destinationSession !== session || seen.has(row.qitemId)) continue;
    seen.add(row.qitemId);
    rows.push(row);
  }
  return rows;
}

function workRows(rows: FleetSnapshot["attention"], width: number): ContentLine[] {
  if (rows.length === 0) return [fieldLine({ label: "rows", value: "none in the served bounded lists" })];
  return rows.flatMap((row) => {
    const summary = row.summary?.trim() || row.body.split("\n").find((line) => line.trim())?.trim() || "no summary served";
    return [
      ...wrapDetailValue("qitem", `${row.qitemId} · ${row.state}`, width),
      ...wrapDetailValue("work", summary, width),
      ...(row.blockedOn ? wrapDetailValue("blocker", `blocked on ${row.blockedOn}`, width) : []),
    ];
  });
}

function agentDetailLines(
  snap: FleetSnapshot,
  found: NonNullable<ReturnType<typeof findAgent>>,
  contentWidth: number,
  timeZone = DEFAULT_TIME_ZONE,
): ContentLine[] {
  const { agent, rig, pod } = found;
  const session = agent.session;
  const specInLibrary = !!agent.spec && !!findSpec(snap, agent.spec);
  const currentRows = session ? rowsForAgent(snap, session, [snap.attention, snap.blocked, snap.inProgress]) : [];
  const pendingRows = session ? rowsForAgent(snap, session, [snap.pending]) : [];
  const recentRows = session ? rowsForAgent(snap, session, [snap.recentlyFinished]) : [];
  const needs = session ? snap.needs.filter((item) => item.target === session) : [];
  const visibleAssigned = currentRows.length + pendingRows.length;
  const assigned = agent.assignedWorkCount ?? visibleAssigned;
  const pending = agent.pendingWorkCount ?? pendingRows.length;
  const inProgress = agent.inProgressWorkCount ?? currentRows.filter((row) => row.state === "in-progress").length;
  const blocked = agent.blockedWorkCount ?? currentRows.filter((row) => row.state === "blocked").length;
  const context = agent.context;
  const meterWidth = Math.max(10, Math.min(36, contentWidth - 24));
  const rtName = agent.runtime ?? "unknown";
  const rtSegs = [
    { text: "  " },
    { text: "runtime:", token: "dim" as const },
    { text: " ".repeat(LABEL_W - "runtime:".length + 1) },
    { text: rtName },
    { text: "  " },
    ...runtimeMarkSegs(agent.runtime),
  ];
  const runtimeLine: ContentLine = { text: rtSegs.map((segment) => segment.text).join(""), segs: rtSegs };
  const activityReason = agent.activity?.needsInput?.reason ?? agent.activity?.signalReason ?? null;
  const needsRows = needs.length > 0
    ? needs.flatMap((item) => [
      ...wrapDetailValue("qitem", item.qitemId ?? "no actionable qitem id served", contentWidth),
      ...wrapDetailValue("reason", item.detail, contentWidth),
      ...(item.unblocks ? wrapDetailValue("action", `unblocks ${item.unblocks}`, contentWidth) : []),
      ...(item.evidenceRef ? wrapDetailValue("evidence", item.evidenceRef, contentWidth) : []),
    ])
    : agent.activity?.needsInput && agent.activity.needsInput.count > 0
      ? wrapDetailValue("reason", agent.activity.needsInput.reason ?? "input required; no reason served", contentWidth)
      : [fieldLine({ label: "state", value: "none on the served projections" })];

  return [
    ...detailPage({ text: `agent ${agent.name} · ${agent.status}` }, [
      {
        title: `CONTEXT · ${context == null ? "unknown" : `${context}%`}`,
        lines: [
          fieldLine({ label: "meter", value: context == null ? "— (not yet known)" : `${context}% used  ${barCells(context / 100, meterWidth)}` }),
          fieldLine({ label: "tokens", value: `${number(agent.totalInputTokens)} input · ${number(agent.totalOutputTokens)} output · ${number(agent.contextWindowSize)} window` }),
          runtimeLine,
          ...(agent.attach ? [fieldLine({ label: "attach", value: agent.attach })] : []),
          fieldLine({ label: "terminal", value: `term ▸ pod ${pod.name}`, link: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${pod.name}` } }),
        ],
      },
      {
        title: "CURRENT ACTIVITY",
        fields: [
          { label: "activity", value: agent.activity?.activity ?? agent.status },
          ...(activityReason ? [{ label: "reason", value: activityReason }] : []),
          ...(agent.activity?.decidedBy ? [{ label: "decided by", value: agent.activity.decidedBy }] : []),
          ...(agent.activity?.signalSource || agent.activity?.signalReason ? [{ label: "signal", value: `${agent.activity.signalSource ?? "unknown"} · ${agent.activity.signalReason ?? "no reason"}` }] : []),
          ...(agent.activity?.eventAt ? [{ label: "changed", value: displayTime(agent.activity.eventAt, timeZone) }] : []),
        ],
      },
      {
        title: "HEALTH",
        lines: healthAgentLines(snap, {
          kind: "seat",
          rigId: rig.id ?? rig.name,
          seatId: agent.nodeId ?? null,
          seatName: agent.name,
          local: found.host === snap.hosts[0],
        }, contentWidth),
      },
      { title: `CURRENT WORK · ${currentRows.length}`, lines: workRows(currentRows, contentWidth) },
      {
        title: "QUEUE",
        lines: [
          ...wrapDetailValue("depth", `${assigned} assigned · ${pending} pending · ${inProgress} in progress · ${blocked} blocked`, contentWidth),
          ...(agent.assignedWorkCount == null ? wrapDetailValue("basis", `${visibleAssigned} rows visible in bounded list reads; complete count not served`, contentWidth) : []),
        ],
      },
      { title: `UP NEXT · ${pending}`, lines: workRows(pendingRows, contentWidth) },
      { title: `NEEDS YOU · ${needs.length || agent.activity?.needsInput?.count || 0}`, lines: needsRows },
      ...(recentRows.length ? [{ title: "RECENTLY FINISHED · bounded window", lines: workRows(recentRows, contentWidth) }] : []),
      {
        title: "SEAT",
        fields: [
          { label: "host", value: found.host.name },
          { label: "rig", value: rig.name },
          { label: "pod", value: pod.name },
        ],
        lines: [
          fieldLine({ label: "cwd", value: agent.cwd ?? "— (not served)" }),
        ],
      },
      {
        title: "SPEC · effective seat binding",
        fields: [specInLibrary
          ? { label: "spec", value: agent.spec, link: { type: "cross", kind: "spec-of", name: agent.name, target: { host: found.host.name, rig: rig.name, pod: pod.name } } }
          : { label: "spec", value: agent.spec ? `${agent.spec}  (not in library)` : "—" }],
        lines: [
          ...wrapDetailValue("profile", agent.profile ?? "not served", contentWidth),
          ...wrapDetailValue("version", agent.specVersion ?? "not served", contentWidth),
          ...wrapDetailValue("source hash", agent.specHash ?? "not served", contentWidth),
          ...wrapDetailValue("basis", "Served seat binding; the authored library may have changed since launch.", contentWidth),
        ],
      },
    ]),
  ];
}

function tabsLine(state: ViewState, suffix: string): ContentLine[] {
  // Each topology tab is its own click zone (the first zone starts at
  // content col 0, preserving the focus-marker floor); `tab graph` = the
  // topology graph view (frame-01 hatchet mainline)
  const labels: Array<[Extract<ViewState["viewTab"], "table" | "recent" | "overview" | "graph" | "health">, string]> = [
    ["table", state.viewTab === "table" ? "[ TABLE ]" : "  TABLE  "],
    ["recent", state.viewTab === "recent" ? "[ RECENT ]" : "  RECENT  "],
    ["overview", state.viewTab === "overview" ? "[ OVERVIEW ]" : "  OVERVIEW  "],
    ["graph", state.viewTab === "graph" ? "[ GRAPH ]" : "  GRAPH  "],
    ["health", state.viewTab === "health" ? "[ HEALTH ]" : "  HEALTH  "],
  ];
  const text = `${labels.map(([, label]) => label).join("")}   ${suffix}`;
  const zones: ContentLine["zones"] = [];
  let at = 0;
  for (const [tab, label] of labels) {
    zones.push({ start: at, end: at + label.length, action: { type: "tab", tab } });
    at += label.length;
  }
  return [{ text, zones }];
}

function queueRows(snap: FleetSnapshot): FleetSnapshot["attention"] {
  return [...snap.attention, ...snap.blocked, ...snap.inProgress, ...snap.pending, ...snap.recentlyFinished];
}

function recentWorkText(snap: FleetSnapshot, row: RecentTransitionSnap): string {
  const qitem = queueRows(snap).find((candidate) => candidate.qitemId === row.qitemId);
  const work = qitem?.summary?.trim() || qitem?.body.split("\n").find((line) => line.trim())?.trim();
  return row.summary?.trim() || work || "no work served";
}

function agentDrillForSession(snap: FleetSnapshot, session: string): Action | undefined {
  const found = findAgentBySession(snap, session);
  return found
    ? { type: "drill", resource: "agent", name: found.agent.name, target: { host: found.host.name, rig: found.rig.name, pod: found.pod.name } }
    : undefined;
}

function recentTargetAction(snap: FleetSnapshot, row: RecentTransitionSnap): Action | undefined {
  if (row.targetKind === "mission") {
    if (snap.scopes?.some((mission) => mission.mission === row.target))
      return { type: "scopes-mission-open", mission: row.target };
  }
  if (row.targetKind === "slice") {
    for (const mission of snap.scopes ?? []) {
      const slice = mission.slices.find((candidate) => candidate.id === row.target || candidate.dirName === row.target);
      if (slice) return { type: "scopes-open", mission: mission.mission, slice: slice.dirName };
    }
  }
  const qitem = queueRows(snap).find((candidate) => candidate.qitemId === row.qitemId || candidate.qitemId === row.target);
  return (qitem ? agentDrillForSession(snap, qitem.destinationSession) : undefined)
    ?? agentDrillForSession(snap, row.actorSession)
    ?? (row.rig && snap.hosts.some((host) => host.rigs.some((rig) => rig.name === row.rig))
      ? { type: "drill", resource: "rig", name: row.rig }
      : undefined);
}

type RecentScope = { kind: "instance" } | { kind: "rig"; rig: string };

function recentScopeMatches(snap: FleetSnapshot, scope: RecentScope): boolean {
  const served = snap.recentTransitionsScope
    ?? (snap.recentTransitionsRig ? { kind: "rig" as const, rig: snap.recentTransitionsRig } : null);
  if (!served || served.kind !== scope.kind) return false;
  return scope.kind === "instance" || (served.kind === "rig" && served.rig === scope.rig);
}

function recentLines(snap: FleetSnapshot, scope: RecentScope, width: number, expanded: boolean, timeZone: string): ContentLine[] {
  if (!recentScopeMatches(snap, scope) || snap.recentTransitions == null) return [];
  const rows = expanded ? snap.recentTransitions : snap.recentTransitions.slice(-5);
  const lines: ContentLine[] = [
    ...(expanded ? [] : [{ text: "" }]),
    sectionRule(`RECENT · ${scope.kind === "instance" ? "instance" : `rig ${scope.rig}`}`, width),
    { text: "  Recorded queue changes · oldest to newest · Enter inspects" },
  ];
  if (rows.length === 0) return [...lines, { text: "  No recorded transitions in the current window." }];
  for (const row of rows) {
    lines.push(listItem(`${displayTime(row.ts, timeZone)} · #${row.transitionId}`, { type: "recent-open", transitionId: row.transitionId }),
      { text: `    ${row.actorSession || "actor unknown"} · ${row.change || "change unknown"}` },
      { text: `    ${recentWorkText(snap, row)}` },
      { text: `    ${row.targetKind}: ${row.target}${scope.kind === "instance" ? ` · rig ${row.rig ?? "unknown"}` : ""}` },
      { text: "" });
  }
  return wrapDetailLines(lines, width);
}

function recentDetailLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const row = state.recentOpen!;
  const target = recentTargetAction(snap, row);
  return wrapDetailLines([
    { text: `Recent event #${row.transitionId} · Esc returns` },
    fieldLine({ label: "when", value: displayTime(row.ts, state.timeZone) }),
    fieldLine({ label: "actor", value: row.actorSession || "unknown" }),
    fieldLine({ label: "change", value: row.change || "unknown" }),
    fieldLine({ label: "work", value: recentWorkText(snap, row) }),
    fieldLine({ label: "target", value: `${row.targetKind}: ${row.target}` }),
    fieldLine({ label: "rig", value: row.rig ?? "not served" }),
    fieldLine({ label: "queue item", value: row.qitemId }),
    fieldLine({ label: "raw time", value: row.ts }),
    { text: "  This is the recorded change, not an independent check of its outcome." },
    ...(target ? [listItem("Related work / owner", target)] : [{ text: "  Related work is outside the current snapshot." }]),
    listItem("Back · Esc", { type: "back" }),
  ], width);
}

function timeZoneLines(state: ViewState, width: number): ContentLine[] {
  return wrapDetailLines([
    { text: "Local time · presentation setting" },
    fieldLine({ label: "timezone", value: state.timeZone }),
    ...(state.timeZoneWarning ? [{ text: `  ${state.timeZoneWarning}` }] : []),
    { text: "  Absolute times include date and zone. Daylight saving follows the named zone. Elapsed ages stay relative; source timestamps are unchanged." },
    { text: "" },
    { text: "  Change the persistent setting from the shell, then reopen this TUI:" },
    { text: "  rig config set ui.timezone Europe/London" },
    { text: "  rig config reset ui.timezone" },
    { text: "  rig config get ui.timezone --show-source" },
    { text: "  Default: America/Los_Angeles. OPENRIG_UI_TIMEZONE overrides the file setting on this TUI's instance." },
    listItem("Back · Esc", { type: "back" }),
  ], width);
}

function specTabsLine(state: ViewState): ContentLine {
  const active = state.viewTab === "topology" || state.viewTab === "yaml" ? state.viewTab : "configuration";
  const labels = ["topology", "configuration", "yaml"] as const;
  const parts = labels.map((tab) => (tab === active ? `[ ${tab.toUpperCase()} ]` : `  ${tab.toUpperCase()}  `));
  const text = parts.join(" ");
  return {
    text,
    zones: labels.map((tab, index) => {
      const label = parts[index]!;
      const start = text.indexOf(label);
      return { start, end: start + label.length, action: { type: "tab", tab } };
    }),
  };
}

function needsLine(prefix: string, item: NeedsItem, snap: FleetSnapshot): ContentLine {
  // aligned columns (glance speed): kind · host · target · detail — same fact,
  // same visual place, every row
  const found = findAgentBySession(snap, item.target, item.hostId);
  const cols = alignedRow([
    [item.kind, 16],
    [item.hostId ? `[${item.hostId}]` : "", 11],
    [item.target, 34],
  ]);
  return {
    text: `${prefix}${cols} ${item.detail}${found ? "  (open ▸)" : ""}`,
    ...(found ? { action: { type: "drill", resource: "agent", name: found.agent.name, target: { host: found.host.name, rig: found.rig.name, pod: found.pod.name } } as const } : {}),
  };
}

function sourceProvenance(spec: FleetSnapshot["specs"][number]): string {
  if (spec.sourceType === "builtin") return "built-in library";
  if (spec.sourceType === "user_file") return "user library";
  return spec.sourceState === "library_item" ? "library" : "source unknown";
}

function specSourceLines(spec: FleetSnapshot["specs"][number], snap: FleetSnapshot): ContentLine[] {
  if (!spec.sourcePath) return [{ text: "Source path unavailable; no current-file claim." }];
  const target = fileTargetForPath(spec.resolvedSourcePath ?? spec.sourcePath, snap.fileRoots ?? []) ?? { root: "", path: spec.sourcePath };
  const lines = [fieldLine({ label: "source", value: `${displayPath(spec.sourcePath, 56)} · ${sourceProvenance(spec)}` }), listItem("View current source", { type: "file-open", target })];
  if (!target.root) lines.push({ text: "Source is not mapped to a configured readable root." });
  if (target.root) {
    lines.push({ text: `Readable root: ${target.root}` }, ...referenceLines(spec.description ?? "", target));
    const markdownLinks = new Set([...((spec.description ?? "").matchAll(/\[[^\]\n]+\]\(<?([^\s)>]+)/g))].map((match) => match[1]));
    // Prose paths stay relative to the named source, not an inferred checkout.
    for (const match of (spec.description ?? "").matchAll(/(?:[\w.-]+\/)+[\w.-]+\.(?:md|txt|ya?ml)(?:#[\w-]+)?/g)) {
      if (markdownLinks.has(match[0])) continue;
      lines.push(listItem(`Reference: ${match[0]} · relative to source`, referenceAction(target, match[0])));
    }
  }
  return lines;
}

function displayPath(path: string, max = 68): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  const kept: string[] = [];
  while (parts.length > 0) {
    const candidate = [parts.at(-1)!, ...kept];
    if (`…/${candidate.join("/")}`.length > max) break;
    kept.unshift(parts.pop()!);
  }
  return `…/${kept.join("/")}`;
}

function wrappedList(prefix: string, values: string[], max = 84): ContentLine[] {
  if (values.length === 0) return [{ text: `${prefix}(none)` }];
  const lines: ContentLine[] = [];
  const indent = " ".repeat(prefix.length);
  let current = prefix;
  for (const value of values) {
    const addition = `${current === prefix ? "" : ", "}${value}`;
    if (current !== prefix && current.length + addition.length > max) {
      lines.push({ text: current });
      current = `${indent}${value}`;
    } else {
      current += addition;
    }
  }
  lines.push({ text: current });
  return lines;
}

/** field row whose value list wraps at the value column (label rhythm kept) */
function fieldWrapped(label: string, values: string[]): ContentLine[] {
  if (values.length === 0) return [fieldLine({ label, value: "(none)" })];
  const valueCol = 2 + 12 + 1; // indent + LABEL_W + gap — where field values start
  const wrapped = wrappedList(" ".repeat(valueCol), values, 92);
  const first = wrapped[0]!.text.slice(valueCol);
  return [fieldLine({ label, value: first }), ...wrapped.slice(1)];
}

/** S19 round-5 (guard): the loading spinner's frame for this render pass +
 * a used-flag so the entry loop knows the frame is time-driven and must keep
 * redrawing. `loading` is the refresh OWNER's explicit lifecycle — the ONLY
 * state the spinner may ride; settled absence (proven-empty or a NAMED read
 * failure) renders static honest text, never a fabricated pending claim. */
interface MotionCtx {
  frame: string;
  reduced: boolean;
  used: boolean;
  loading: boolean;
}

function instanceContentLines(
  state: ViewState,
  snap: FleetSnapshot,
  host: FleetSnapshot["hosts"][number],
  contentWidth: number,
  motion: MotionCtx,
): ContentLine[] {
  const lines = tabsLine(state, `instance ${host.name}`);
  const scope = { kind: "instance", local: host === snap.hosts[0] } as const;
  if (state.viewTab === "health") return [...lines, { text: "" }, ...healthListLines(snap, scope, contentWidth)];
  if (state.viewTab === "recent") {
    const recent = recentLines(snap, scope, contentWidth, true, state.timeZone);
    return recent.length > 0
      ? [...lines, ...recent]
      : [...lines, { text: "" }, { text: motion.loading ? `${motion.frame} instance RECENT read pending` : "(instance RECENT window not served)" }];
  }
  if (state.viewTab === "overview") {
    return [
      ...lines,
      ...detailPage({ text: `instance ${host.name}` }, [
        {
          title: "instance",
          fields: [
            { label: "identity", value: host.name },
            { label: "transport", value: host.id ?? "local" },
            { label: "shape", value: host.rigs.some(r => r.inventoryUnavailable) ? `${host.rigs.length} rigs · seat inventory incomplete` : `${host.rigs.length} rigs · ${host.rigs.reduce((n, rig) => n + rig.pods.reduce((m, pod) => m + pod.agents.length, 0), 0)} seats` },
          ],
        },
        {
          title: "rigs",
          lines: host.rigs.length > 0
            ? host.rigs.map((rig) => listItem(
                alignedRow([[rig.name, 20], [rig.lifecycleState ?? "unknown", 20], [rig.inventoryUnavailable ? "inventory unavailable" : `${rig.pods.length} pods · ${rig.pods.reduce((n, pod) => n + pod.agents.length, 0)} seats`, 24]]),
                { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } },
              ))
            : [{ text: "  (no local rigs served — proven empty)" }],
        },
      ]),
    ];
  }
  if (state.viewTab === "graph") {
    for (const rig of host.rigs) {
      lines.push({ text: "" }, sectionRule(`rig ${rig.name} · ${rig.lifecycleState ?? "unknown"}`, contentWidth));
      if (!rig.graph) {
        if (motion.loading) {
          if (!motion.reduced) motion.used = true;
          lines.push({ text: `  ${motion.frame} topology graph read pending` });
        } else if (snap.readErrors.some((error) => error.startsWith(`graph(${rig.name})`))) {
          lines.push({ text: "  ✕ topology graph read failed — named in the status line" });
        } else {
          lines.push({ text: "  (no topology graph served)" });
        }
        continue;
      }
      const canvas = renderGraphStyle(state.graphStyle, rig.graph, { host: host.name, rig: rig.name, selected: null }, contentWidth);
      const plain = canvas.plainLines();
      const segs = canvas.segLines();
      for (let row = 0; row < plain.length; row++) lines.push({
        text: plain[row]!,
        segs: segs[row]!,
        zones: canvas.zones.filter((zone) => zone.y === row).map((zone) => ({ start: zone.start, end: zone.end, action: zone.action })),
      });
    }
    if (host.rigs.length === 0) lines.push({ text: "" }, { text: "  (no local rigs served — proven empty)" });
    lines.push({ text: "" }, { text: `  style: ${state.graphStyle} · style hatchet|braille|braille-fallback rides the command bar` });
    return lines;
  }

  lines.push(healthSummaryLine(snap, scope, contentWidth));
  lines.push({ text: state.filter ? `/ filter instance rows: ${state.filter} · / replace · esc clear` : "/ filter instance rows…" });
  const columns = instanceAgentColumns(contentWidth);
  lines.push({ text: tableRow(columns, { rig: "RIG", pod: "POD", seat: "SEAT", runtime: "RT", context: "CTX", status: "STATE", queue: "Q", work: "WORK", now: "NOW" }) });
  lines.push({ text: "━".repeat(columnsWidth(columns)) });
  let seatCount = 0;
  let workingCount = 0;
  let attentionCount = 0;
  let openCount = 0;
  for (const rig of host.rigs) {
    const agents = rig.pods.flatMap((pod) => pod.agents.map((agent) => ({ pod: pod.name, agent })))
      .filter(({ pod, agent }) => !state.filter || rig.name.includes(state.filter) || pod.includes(state.filter) || agent.name.includes(state.filter));
    if (state.filter && agents.length === 0 && !rig.name.includes(state.filter)) continue;
    const rigAction: Action = { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } };
    if (agents.length === 0) {
      lines.push({
        text: tableRow(columns, { rig: rig.name, pod: "—", seat: rig.inventoryUnavailable ? "(read failed)" : "(no seats)", status: rig.lifecycleState ?? "unknown" }),
        action: rigAction,
      });
      continue;
    }
    let previousPod: string | null = null;
    for (const { pod, agent } of agents) {
      const firstInPod = pod !== previousPod;
      if (firstInPod && previousPod != null) lines.push({ text: "┈".repeat(columnsWidth(columns)) });
      previousPod = pod;
      const stateCell = operationalState(agent.status, motion);
      const queue = queueFacts(snap, agent.session);
      seatCount += 1;
      if (["active", "working", "running"].includes(agent.status)) workingCount += 1;
      if (/attention|needs|blocked|unknown|failed/.test(agent.status)) attentionCount += 1;
      openCount += queue.count;
      lines.push({
        text: tableRow(columns, {
          rig: rig.name,
          pod: firstInPod ? pod : "",
          seat: `${stateCell.mark} ${seatName(pod, agent.name)}`,
          runtime: runtimeShort(agent.runtime),
          context: contextCompact(agent.context, contentWidth < 110),
          status: stateCell.word,
          queue: queue.count || "·",
          work: queue.work,
          now: queue.now,
        }),
        action: { type: "drill", resource: "agent", name: agent.name, target: { host: host.name, rig: rig.name, pod } },
        zones: [{ start: 0, end: columns[0]![2], action: rigAction }],
      });
    }
  }
  lines.push({ text: "" }, { text: host.rigs.some(r => r.inventoryUnavailable) ? `${host.rigs.length} rigs · inventory incomplete · ${seatCount} seats read` : `${host.rigs.length} rigs · ${seatCount} seats · ${workingCount} working · ${attentionCount} need attention · ${openCount} open rows` });
  lines.push(...recentLines(snap, scope, contentWidth, false, state.timeZone));
  return lines;
}

function contentLines(state: ViewState, snap: FleetSnapshot, contentWidth: number, motion: MotionCtx): ContentLine[] {
  if (state.file) {
    const read = JSON.stringify(snap.fileRead?.target) === JSON.stringify(state.file) ? snap.fileRead?.result : null;
    return [...(state.project ? wrapDetailLines([{ text: `Project ${state.project.id} · ${state.project.root}` }], contentWidth) : []), ...fileLines(read, state.file, contentWidth)];
  }
  if (state.externalUrl) return externalLines(state.externalUrl, contentWidth);
  const contentWidthForGraph = contentWidth;
  void contentWidthForGraph;
  const lines: ContentLine[] = [];
  if (state.timeZoneHelp) return timeZoneLines(state, contentWidth);
  if (state.recentOpen) return recentDetailLines(state, snap, contentWidth);
  if (state.section === "terminals") return terminalLines(state, snap, contentWidth);
  if (state.section === "config") return configLines(state, snap, contentWidth);
  if (state.section === "connections") return connectionsLines(snap, contentWidth, state.timeZone, state.expanded);
  if (state.healthOpen) return healthDetailLines(snap, state.healthOpen, contentWidth, state.timeZone);
  if (state.section === "system") return [{ text: "System · Instance health" }, { text: "" }, ...healthListLines(snap, { kind: "instance", local: true }, contentWidth)];
  // PULSE is a FULL-WIDTH view handled by an early return in renderScreen
  // (renderPulseScreen) — it never reaches the sidebar+content layout below.
  if (state.section === "topology") {
    if (state.runningOf) {
      const seats = agentsRunningSpecTargets(snap, state.runningOf);
      return detailPage({ text: `seats running spec ${state.runningOf}` }, [
        {
          lines:
            seats.length === 0
              ? [{ text: "  (no seats currently run it)" }]
              : seats.map((seat) =>
                  listItem(`${seat.agent.name}  ·  ${seat.rig.name} / ${seat.pod.name}  ·  ${seat.agent.status}`, {
                    type: "drill",
                    resource: "agent",
                    name: seat.agent.name,
                    target: { host: seat.host.name, rig: seat.rig.name, pod: seat.pod.name },
                  }),
                ),
        },
      ]);
    }
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "agent") {
      const hostName = state.drill.find((part) => part.kind === "host")?.name;
      const rigName = state.drill.find((part) => part.kind === "rig")?.name;
      const podName = state.drill.find((part) => part.kind === "pod")?.name;
      const found = hostName ? findAgent(snap, leaf.name, { host: hostName, rig: rigName, pod: podName }) : findAgent(snap, leaf.name);
      if (!found) return [{ text: `agent "${leaf.name}" not in the current snapshot` }];
      return agentDetailLines(snap, found, contentWidth, state.timeZone);
    }
    const hostName = state.drill.find((d) => d.kind === "host")?.name;
    const host = (hostName ? snap.hosts.find((candidate) => candidate.name === hostName) : snap.hosts[0]);
    if (leaf?.kind === "host" && host) return instanceContentLines(state, snap, host, contentWidth, motion);
    if (!leaf && host?.rigs.length) return wrapDetailLines([
      { text: `TOPOLOGY · ${host.name}` }, { text: "Choose a rig to read its seats and work." },
      { text: `${host.rigs.length} rig${host.rigs.length === 1 ? "" : "s"} · select one in Explorer` },
      { text: "Bright ▦ live agents · gray ▦ none · ? unknown" },
    ], contentWidth);
    const rigName = state.drill.find((d) => d.kind === "rig")?.name ;
    const rig = host?.rigs.find((candidate) => candidate.name === rigName);
    if (!rig || !host) {
      const notLoaded = snap.readErrors.find((error) => error.startsWith("Live data not loaded"));
      if (notLoaded) return [{ text: notLoaded }];
      // round-6 (guard): the ROOT topology branch consumes the OWNER's load
      // truth like every other read surface — a real in-flight cold start
      // renders the spinner; after settlement only a NAMED rigs-summary
      // failure or the proven no-rigs truth may render, never "waiting"
      if (motion.loading) {
        if (!motion.reduced) motion.used = true;
        return [{ text: `${motion.frame} topology read pending — waiting on the daemon rigs read (honest-empty, not fabricated)` }];
      }
      if (snap.readErrors.some((e) => e.startsWith("rigs-summary"))) {
        return [{ text: "✕ rigs read failed — named in the status line (honest-empty, not fabricated)" }];
      }
      return [{ text: "(no rigs served — proven empty, not fabricated)" }];
    }
    if (rig.inventoryNotLoaded) return [{ text: `Reading ${rig.name}…` }];
    if (rig.inventoryUnavailable) return [{ text: `Inventory unavailable for ${rig.name} · refresh to Retry` }];
    const podFilter = leaf?.kind === "pod" ? leaf.name : null;
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })));
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter));
    const suffix = `rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ""}${state.filter ? ` · filter "${state.filter}"` : ""}`;
    lines.push(...tabsLine(state, suffix));
    // OPR.0.6.0.8: open every live seat of the rig as terminal tiles (Herdr: 4×4 per tab).
    if (!podFilter) lines.push(fieldLine({ label: "terminal", value: `term ▸ rig ${rig.name}`, link: { type: "act", act: "open-terminal", view: `rig:${rig.name}` } }));
    const healthScope = { kind: "rig" as const, rigId: rig.id ?? rig.name, rigName: rig.name, local: host === snap.hosts[0] };
    if (state.viewTab === "health") return [...lines, { text: "" }, ...healthListLines(snap, healthScope, contentWidth)];
    if (state.viewTab === "recent") {
      const recent = recentLines(snap, { kind: "rig", rig: rig.name }, contentWidth, true, state.timeZone);
      return recent.length > 0
        ? [...lines, ...recent]
        : [...lines, { text: "" }, { text: motion.loading ? `${motion.frame} rig RECENT read pending` : "(rig RECENT window not served)" }];
    }
    if (state.viewTab === "graph") {
      // slice-17 topology view (frame-01): the rig's SERVED /graph projection
      // rendered by the style registry; honest-empty until the read answers.
      if (!rig.graph) {
        lines.push({ text: "" });
        // round-5 (guard): the spinner rides the OWNER's in-flight state only;
        // settled absence renders the honest static truth — a NAMED failure or
        // a proven-empty read — and never spins
        if (motion.loading) {
          if (!motion.reduced) motion.used = true;
          lines.push({ text: `  ${motion.frame} topology graph read pending (honest-empty, never fabricated)` });
        } else if (snap.readErrors.some((e) => e.startsWith(`graph(${rig.name})`))) {
          lines.push({ text: "  ✕ topology graph read failed — named in the status line (honest-empty, never fabricated)" });
        } else {
          lines.push({ text: "  (no topology graph served — honest-empty, never fabricated)" });
        }
        return lines;
      }
      // PER-VIEW zoom (PM b7f95c4b): a pod drill scopes the SAME projection to
      // that pod's containment subgraph — nodes clipped at rig scale become
      // visible AND eligible here; eligibility is always the current view's
      // clipped hit-zone truth, never a global filter.
      let graphView = rig.graph;
      if (podFilter) {
        const podGroup = rig.graph.nodes.find((n) => n.type === "podGroup" && (n.data.podNamespace ?? n.data.logicalId) === podFilter);
        const memberIds = new Set(rig.graph.nodes.filter((n) => n.parentId && n.parentId === podGroup?.id).map((n) => n.id));
        graphView = {
          nodes: rig.graph.nodes.filter((n) => n === podGroup || memberIds.has(n.id)),
          edges: rig.graph.edges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target)),
        };
      }
      const canvas = renderGraphStyle(state.graphStyle, graphView, { host: host.name, rig: rig.name, selected: null }, contentWidth);
      const plain = canvas.plainLines();
      const segs = canvas.segLines();
      for (let row = 0; row < plain.length; row++) {
        lines.push({
          text: plain[row]!,
          segs: segs[row]!,
          zones: canvas.zones.filter((z) => z.y === row).map((z) => ({ start: z.start, end: z.end, action: z.action })),
        });
      }
      lines.push({ text: "" });
      lines.push({ text: `  style: ${state.graphStyle} · style hatchet|braille|braille-fallback rides the command bar` });
      return lines;
    }
    lines.push(listItem("CONFIG · instance settings", { type: "jump", section: "config" }));
    lines.push(healthSummaryLine(snap, healthScope, contentWidth));
    lines.push({ text: state.filter ? `/ filter agents: ${state.filter} · / replace · esc clear` : "/ filter agents…" });
    if (state.viewTab === "overview") {
      lines.push(
        ...detailPage({ text: `rig ${rig.name}` }, [
          {
            title: "rig",
            fields: [
              { label: "host", value: host.name },
              { label: "shape", value: `${rig.pods.length} pods · ${all.length} agents` },
              ...(rig.lifecycleState ? [{ label: "state", value: rig.lifecycleState }] : []),
            ],
          },
          {
            title: "pods",
            lines: rig.pods.map((pod) =>
              listItem(
                alignedRow([[pod.name, 14], [`${pod.agents.length} agents`, 10], [pod.agents.map((a) => a.status).filter((s, i, arr) => arr.indexOf(s) === i).join(" · "), 40]]),
                { type: "drill", resource: "pod", name: pod.name, target: { host: host.name, rig: rig.name } },
              ),
            ),
          },
        ]),
      );
      return lines;
    }
    const agentCols = agentColumns(contentWidth);
    const narrowFactory = !agentCols.some(([key]) => key === "model");
    if (narrowFactory) lines.push({ text: "MODEL/NOW/ACTIONS on drill (enter)" });
    lines.push({
      text: tableRow(agentCols, {
        pod: "POD", seat: "SEAT", runtime: "RT", model: "MODEL", context: "CTX",
        status: "STATE", queue: "Q", work: "WORK", now: "NOW", actions: "ACTIONS",
      }),
    });
    lines.push({ text: "━".repeat(columnsWidth(agentCols)) });
    const actionsIndex = agentCols.findIndex(([key]) => key === "actions");
    const actionsColStart = actionsIndex < 0 ? -1 : agentCols.slice(0, actionsIndex).reduce((n, [, , width]) => n + width + 1, 0);
    let previousPod: string | null = null;
    for (const a of rows) {
      const firstInPod = a.pod !== previousPod;
      if (firstInPod && previousPod != null && !narrowFactory) lines.push({ text: "┈".repeat(columnsWidth(agentCols)) });
      previousPod = a.pod;
      // ACTIONS = drive-structure ONLY (BR-9), each mapped to an EXISTING
      // write contract: `run ▸` = the rig-restore write (rendered only where
      // it applies — the seat is not running); `term ▸` = the terminal-open
      // view contract (pod-scoped, the web's granularity). No false affordance.
      const canRun = a.canRun ?? !a.live;
      const actionsCell = canRun ? "run ▸ · term ▸" : "term ▸";
      const zones: ContentLine["zones"] = [];
      if (actionsColStart >= 0) {
        const termOffset = actionsColStart + actionsCell.indexOf("term ▸");
        zones.push({ start: termOffset, end: termOffset + "term ▸".length, action: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${a.pod}` } });
      }
      if (canRun && actionsColStart >= 0)
        zones.push({
          start: actionsColStart,
          end: actionsColStart + "run ▸".length,
          action: { type: "act", act: "run", rigId: rig.id ?? rig.name, agent: a.name },
        });
      const stateCell = operationalState(a.status, motion);
      const queue = queueFacts(snap, a.session);
      lines.push({
        // the WHOLE row is the hit surface (not a testid'd control): clicking
        // any visible cell opens the agent; the ACTIONS zones override.
        text: tableRow(agentCols, {
          pod: firstInPod ? a.pod : "",
          seat: `${stateCell.mark} ${seatName(a.pod, a.name)}`,
          runtime: runtimeShort(a.runtime),
          model: tableModel(a.model),
          context: contextCompact(a.context, narrowFactory),
          status: stateCell.word,
          queue: queue.count || "·",
          work: queue.work,
          now: queue.now,
          actions: actionsCell,
        }),
        action: { type: "drill", resource: "agent", name: a.name, target: { host: host.name, rig: rig.name, pod: a.pod } },
        zones,
      });
    }
    lines.push({ text: "" });
    const working = rows.filter((agent) => ["active", "working", "running"].includes(agent.status)).length;
    const attention = rows.filter((agent) => /attention|needs|blocked|unknown|failed/.test(agent.status)).length;
    lines.push({ text: `${rows.length} seats · ${working} working · ${attention} need attention · ${rows.reduce((n, agent) => n + queueFacts(snap, agent.session).count, 0)} open rows` });
    if (!podFilter) lines.push(...recentLines(snap, { kind: "rig", rig: rig.name }, contentWidth, false, state.timeZone));
    return lines;
  }
  if (state.section === "specs") {
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "spec") {
      const spec = findSpec(snap, leaf.name);
      if (!spec) return [{ text: snap.readErrors.find((error) => error.startsWith("specs-library")) ?? (!snap.specsLoaded ? "Specs catalog read pending" : `spec "${leaf.name}" not in the current catalog`) }];
      if (spec.kind === "rig") lines.push(specTabsLine(state));
      lines.push({ text: `${spec.kind} spec ${spec.name}` });
      lines.push(fieldLine({ label: "purpose", value: spec.description ?? "not declared in the available source" }));
      lines.push(fieldLine({ label: "provenance", value: `${sourceProvenance(spec)} · ${spec.sourceState ?? "source state not served"}` }));
      lines.push(...specSourceLines(spec, snap));
      lines.push({ text: "  Authored declaration. Resource availability is not the effective loadout of a running seat." });
      lines.push(sectionRule("Observed consumers · open for effective runtime/configuration", contentWidth));
      for (const consumer of spec.consumers ?? []) {
        const resource = consumer.agent ? "agent" : "rig";
        lines.push(listItem(`${consumer.agent ?? consumer.rig} · ${consumer.status ?? "unknown"}${consumer.runtime ? ` · ${consumer.runtime}` : ""}${consumer.model ? ` · ${consumer.model}` : ""}`, { type: "drill", resource, name: consumer.agent ?? consumer.rig, target: { host: consumer.host, rig: consumer.rig } }));
      }
      if (spec.consumers && !spec.consumers.length) lines.push({ text: "  No consumers observed in the available local inventory (remote seats are not enumerated)." });
      if (spec.consumers === undefined) lines.push({ text: "  Consumer projection unavailable." });
      for (const error of snap.readErrors.filter((error) => error.startsWith("nodes(") || error.startsWith("rig-spec(") || error.startsWith("rigs-summary:"))) lines.push({ text: `  Inventory incomplete: ${error}` });
      lines.push(listItem("Back · Esc", { type: "back" }));
      if (spec.sourceUnavailable) return wrapDetailLines([...lines, { text: `  Source unavailable: ${spec.sourceUnavailable}` }], contentWidth);
      if (spec.kind === "rig") {
        if (state.viewTab === "topology") {
          // ROUND-4 item 1: the established table treatment, not unformatted rows
          const nodes = spec.graph?.nodes ?? [];
          const graphEdges = spec.graph?.edges ?? [];
          const NODE_COLS: Array<[string, number]> = [["NODE", 16], ["LABEL", 24], ["POD", 12], ["RUNTIME", 14]];
          lines.push(fieldLine({ label: "shape", value: `${nodes.length} nodes · ${graphEdges.length} edges` }));
          lines.push({ text: "" });
          if (nodes.length === 0) {
            lines.push({ text: "  (topology projection is empty)" });
            return wrapDetailLines(lines, contentWidth);
          }
          lines.push({ text: `  ${alignedRow(NODE_COLS)}` });
          lines.push({ text: `  ${"─".repeat(NODE_COLS.reduce((n, [, w]) => n + w + 1, -1))}` });
          for (const node of nodes)
            lines.push({ text: `  ${alignedRow([[node.id, 16], [node.label, 24], [node.pod ?? "—", 12], [node.runtime, 14]])}` });
          if (graphEdges.length > 0) {
            lines.push({ text: "" });
            lines.push(sectionRule("edges"));
            for (const edge of graphEdges) lines.push({ text: `  ${alignedRow([[edge.source, 16], ["→", 2], [edge.target, 20]])} (${edge.kind})` });
          }
          return wrapDetailLines(lines, contentWidth);
        }
        if (state.viewTab === "yaml") {
          for (const rawLine of (spec.raw ?? "# raw YAML unavailable").split("\n")) lines.push({ text: `  ${rawLine}` });
          return wrapDetailLines(lines, contentWidth);
        }
        const members = spec.pods?.reduce((count, pod) => count + pod.members.length, 0) ?? spec.legacyNodes?.length ?? 0;
        const edges = (spec.edges?.length ?? 0) + (spec.pods?.reduce((count, pod) => count + pod.edges.length, 0) ?? 0);
        lines.push(
          ...detailPage({ text: "" }, [
            {
              fields: [
                ...(spec.format ? [{ label: "format", value: spec.format.replace("_", "-") }] : []),
                { label: "shape", value: `${spec.pods?.length ?? 0} pods · ${members} members · ${edges} edges` },
              ],
            },
            ...(spec.pods ?? []).map((pod) => ({
              title: `pod ${pod.namespace ?? pod.id}${pod.label ? ` — ${pod.label}` : ""}`,
              lines: [
                ...pod.members.map((member) =>
                  listItem(
                    `${alignedRow([[member.id, 12], [member.agentRef, 34], [member.runtime, 12]])}${member.profile ? ` profile ${member.profile}` : ""}`,
                    { type: "drill", resource: "spec", name: member.agentRef },
                  ),
                ),
                ...pod.edges.map((edge) => ({ text: `    ${edge.from} → ${edge.to}  (${edge.kind})` })),
                // an empty pod still exists — render it honestly, never skip it
                ...(pod.members.length === 0 && pod.edges.length === 0 ? [{ text: "  (no members)" }] : []),
              ],
            })),
            ...(spec.legacyNodes?.length
              ? [{ title: "nodes", lines: spec.legacyNodes.map((node) => listItem(`${alignedRow([[node.id, 16], [node.runtime, 12]])}${node.role ? ` ${node.role}` : ""}`)) }]
              : []),
            ...((spec.edges?.length ?? 0) > 0
              ? [{ title: "cross-pod edges", lines: (spec.edges ?? []).map((edge) => ({ text: `  ${edge.from} → ${edge.to}  (${edge.kind})` })) }]
              : []),
          ]).slice(1),
        );
      } else if (spec.kind === "workflow") {
        lines.push(
          ...detailPage({ text: `workflow spec ${spec.name}${spec.version ? `  ·  v${spec.version}` : ""}` }, [
            {
              title: "workflow",
              fields: [
                { label: "roles", value: spec.rolesCount != null ? String(spec.rolesCount) : "—" },
                { label: "steps", value: spec.stepsCount != null ? String(spec.stepsCount) : "—" },
                { label: "status", value: spec.workflowStatus ?? "—" },
              ],
            },
            {
              title: "source",
              fields: [{ label: "source", value: spec.sourcePath ? `${displayPath(spec.sourcePath)} · ${sourceProvenance(spec)}` : "—" }],
            },
          ]),
        );
      } else {
        // the mockup's agent-spec frame IS the field-grid reference — recreate it
        const seats = agentsRunningSpec(snap, spec.name);
        const resources = [
          spec.resources?.guidance.length ? `guidance ${spec.resources.guidance.join(", ")}` : "",
          spec.resources?.plugins.length ? `plugins ${spec.resources.plugins.join(", ")}` : "",
          spec.resources?.subagents.length ? `subagents ${spec.resources.subagents.join(", ")}` : "",
        ].filter(Boolean);
        lines.push(
          ...detailPage({ text: `agent spec ${spec.name}${spec.version ? `  ·  v${spec.version}` : ""}` }, [
            {
              title: "spec",
              fields: [
                ...(spec.description ? [{ label: "about", value: spec.description }] : []),
                { label: "runtime", value: spec.runtime ?? "—" },
              ],
              lines: spec.skills ? fieldWrapped("skills", spec.skills) : [],
            },
            {
              title: "startup",
              fields: [
                ...(spec.hasGuidance != null ? [{ label: "guidance", value: spec.hasGuidance ? "yes" : "no" }] : []),
                ...(spec.startupFiles ?? []).map((f) => ({ label: "startup", value: `${f.path}${f.required ? "  (required)" : ""}` })),
                ...(spec.profiles?.length ? [{ label: "profiles", value: spec.profiles.join(", ") }] : []),
                ...(spec.resources ? [{ label: "resources", value: resources.join(" · ") || "(none beyond skills)" }] : []),
              ],
            },
            {
              title: "source",
              fields: [{ label: "source", value: spec.sourcePath ? `${displayPath(spec.sourcePath, 56)} · ${sourceProvenance(spec)}` : "—" }],
            },
            {
              title: "Declared rig references",
              fields: [
                ...((spec.usedByRigs?.length ?? 0) === 0
                  ? [{ label: "declared by", value: "—" }]
                  : (spec.usedByRigs ?? []).map((rig) => ({
                      label: "declared by",
                      value: `rig ${rig}`,
                      link: { type: "drill", resource: "spec", name: rig } as Action,
                    }))),
                {
                  label: "seats now",
                  value: seats.join(", ") || "(none)",
                  link: { type: "cross", kind: "running", name: spec.name },
                },
              ],
            },
          ]),
        );
      }
      return wrapDetailLines(lines, contentWidth);
    }
    if (state.filter) lines.push({ text: `/ filter specs: ${state.filter} · / replace · esc clear` });
    const selected = computeExplorerRows(state, snap)[state.selection]?.action;
    const spec = selected?.type === "drill" && selected.resource === "spec" ? findSpec(snap, selected.name) : null;
    if (spec) {
      lines.push({ text: `${spec.name} · ${spec.kind} · ${sourceProvenance(spec)}` });
      lines.push({ text: "" }, { text: spec.description?.trim() || "Purpose not declared in the available source." });
      if (spec.kind === "rig") lines.push(fieldLine({ label: "contents", value: `${spec.pods?.length ?? 0} pods · ${spec.pods?.reduce((n, p) => n + p.members.length, 0) ?? spec.legacyNodes?.length ?? 0} members · ${spec.agentRefs?.join(", ") || "no member references served"}` }));
      else if (spec.kind === "agent") lines.push(fieldLine({ label: "contents", value: `${spec.runtime ?? "runtime not declared"} · ${(spec.skills ?? []).length} skills · ${(spec.startupFiles ?? []).length} startup files` }));
      else lines.push(fieldLine({ label: "contents", value: `${spec.rolesCount ?? "unknown"} roles · ${spec.stepsCount ?? "unknown"} steps` }));
      lines.push({ text: "" }, listItem("Read details · Enter", { type: "drill", resource: "spec", name: spec.name }), ...specSourceLines(spec, snap));
      if (spec.sourceUnavailable) lines.push({ text: `Source unavailable: ${spec.sourceUnavailable}` });
    } else {
      lines.push({ text: "SPEC LIBRARY" }, { text: "Choose a spec at left to preview its purpose, contents and source." },
        { text: "Enter reads details · / filters · source opens current disk content" }, { text: "" });
      if (snap.specsLoaded !== false && !snap.readErrors.some(e => e.startsWith("specs-library"))) for (const kind of ["rig", "agent", "workflow"] as const) lines.push({ text: `${kind}: ${snap.specs.filter((spec) => spec.kind === kind).length} available` });
      if (!snap.specs.length) {
        if (motion.loading) {
          if (!motion.reduced) motion.used = true;
          lines.push({ text: `  ${motion.frame} library read pending` });
        } else {
          const failure = snap.readErrors.find((error) => error.startsWith("specs-library"));
          const notLoaded = snap.readErrors.find((error) => error.startsWith("Live data not loaded"));
          lines.push({ text: failure ? `  ✕ library read failed: ${failure}` : notLoaded ?? (snap.specsLoaded === false ? "Specs catalog read unavailable" : "  (library empty — proven, no specs served)") });
        }
      }
    }
    return wrapDetailLines(lines, contentWidth);
  }

  if (state.section === "needs") return attentionLines(state, snap, contentWidth);
  if (state.section === "scopes") {
    const catalog = snap.projects;
    if (!state.project && catalog !== undefined) return wrapDetailLines([
      { text: "PROJECTS · select a project" },
      { text: catalog ? `Catalog: ${catalog.catalogPath}` : "Project catalog unavailable or loading" },
      ...(snap.readErrors ?? []).map(text => ({ text })),
      ...(catalog?.projects ?? []).flatMap(p => [listItem(`${p.name} · ${p.id}`, { type: "project-select", id: p.id }), { text: p.root }, ...(p.error ? [{ text: `Unavailable: ${p.error}` }] : [])]),
      ...(catalog?.projects.length === 0 ? [{ text: "No projects declared in this catalog." }] : []),
    ], contentWidth);
    const identity = state.project ? wrapDetailLines([{ text: `PROJECT ${state.project.id}` }, { text: state.project.root }], contentWidth) : [];
    if (state.project && (snap.projectRead?.id !== state.project.id || snap.projectRead?.root !== state.project.root)) return [...identity, { text: "Reading selected project…" }];
    const entry = catalog?.projects.find(p => p.id === state.project!.id && p.root === state.project!.root);
    const errors = (snap.readErrors ?? []).map(text => ({ text: `Unavailable: ${text}` }));
    const missionOverview = !!state.scopesMission && !state.scopesSelected && !state.executionOpen;
    const projectHeader = state.project ? missionOverview
      ? [{ text: `PROJECT ${state.project.id}`, action: { type: "project-source" as const } }, ...wrapDetailLines(errors, contentWidth)]
      : [...identity, listItem("Read current source", { type: "project-source" }), ...wrapDetailLines(errors, contentWidth)] : [];
    if (state.project && (!entry || entry.error)) return [...projectHeader, { text: "Choose a project again or go Back." }];
    if (state.project && !state.scopesMission) return [...projectHeader, { text: "Choose a mission" }, ...(snap.scopes ?? []).map(m => listItem(m.mission + (m.error ? " · source unavailable" : ""), { type: "scopes-mission-open", mission: m.mission })), ...(!snap.scopes?.length && !errors.length ? [{ text: "No missions found in this project." }] : [])];
    // SCOPES owns both levels. Both mission-graph and Explorer slice routes land
    // on the same execution-backed canonical detail; store-direct content is
    // composed into that page instead of surviving as a competing destination.
    const sel = state.scopesSelected;
    const missionName = state.scopesMission;
    const mission = snap.scopes?.find(m => m.mission === missionName);
    if (mission?.error) return [...projectHeader, ...wrapDetailLines([{ text: `${missionName} · Source unavailable` }, { text: mission.error }, { text: "Correct the source and refresh; Back returns to other missions." }], contentWidth)];
    const execution = snap.execution?.mission === missionName ? snap.execution : null;
    const detail = sel
      ? (snap.scopes ?? []).find((m) => m.mission === sel.mission)?.slices.find((sl) => sl.dirName === sel.slice) ?? null
      : null;
    if (detail?.error) return [...projectHeader, ...wrapDetailLines([{ text: `${missionName}/${detail.dirName} · Source unavailable` }, { text: detail.error }, { text: "Correct the source and refresh; Back returns to other slices." }], contentWidth)];
    if (!sel && !state.executionOpen) projectHeader.push(...(mission?.slices.filter(s => s.error) ?? []).map(s => listItem(`${s.dirName} · source unavailable`, { type: "scopes-open", mission: missionName!, slice: s.dirName })));
    if (state.executionOpen && execution) {
      return [...projectHeader, ...executionContentLines(execution, snap.scopes, snap.readErrors, state.executionOpen, contentWidth, false, snap.sliceDetail, {
        collapseReqs: state.scopesCollapseReqs,
        narrative: state.scopesNarrative,
      }, state.timeZone)];
    }
    if (detail && execution) {
      return [...projectHeader, ...executionContentLines(execution, snap.scopes, snap.readErrors, `slice:${detail.id ?? detail.dirName}`, contentWidth, false, snap.sliceDetail, {
        collapseReqs: state.scopesCollapseReqs,
        narrative: state.scopesNarrative,
      }, state.timeZone)];
    }
    if (!detail && missionName) {
      const lines = executionContentLines(execution, snap.scopes, snap.readErrors, state.executionOpen, contentWidth, !snap.hydratedAt || snap.executionMission !== missionName, undefined, undefined, state.timeZone);
      return [...projectHeader, ...(execution ? lines : [{ text: `  ${missionName} EXECUTION` }, ...lines])];
    }
    return [...projectHeader, ...scopesContentLines(detail, missionName, {
      collapseReqs: state.scopesCollapseReqs,
      narrative: state.scopesNarrative,
      width: contentWidth,
      executionStrip: detail ? executionSliceStripLines(null, detail.id ?? detail.dirName, detail.dirName, contentWidth, detail.status) : undefined,
    })];
  }
  return [{ text: `(${state.section})` }];
}

export interface RenderOptions {
  /** First visit: preserve the prior frame with its original label and no effect targets. */
  previousPage?: { state: ViewState; snapshot: FleetSnapshot };
  startup?: StartupState;
  /** I5 — the live command context (from the C3 detector); default "standard". */
  commandContext?: string;
  completion?: { candidates: string[]; message: string } | null;
  cols?: number;
  rows?: number;
  /** wall-clock ms for time-driven motion (spinner frames, flash windows);
   * renderScreen stays pure — the caller supplies time (round-4 wiring) */
  nowMs?: number;
  /** the active Style's color mode — picks braille vs line spinner frames */
  colorMode?: ColorMode;
  /** S19 round-5 (guard): the refresh owner's honest load lifecycle — the
   * spinner renders ONLY while un-settled/in-flight; omitted = settled
   * (demo/fixtures: the data given IS the answer, nothing is loading) */
  load?: LoadState;
  /** S19 round-5 (guard): per-seat fresh pane-output events from the refresh
   * owner — renderScreen targets each agent's explorer row while its one-shot
   * window is open; omitted = no flashes */
  rowFlashes?: RowFlash[];
  /** 5.2 crash-cart: the resolved daemon-down signal. Present ⇒ the whole screen is the daemon-down
   *  path — the normal fleet views have no data when the daemon isn't serving. */
  daemonState?: DaemonState;
  unavailable?: string;
  unavailableExpanded?: boolean;
  starting?: string;
  /** the cockpit model — rendered when daemonState === "down". */
  crashCart?: CrashCartModel;
  /** evidence for the UNVERIFIED screen — rendered when daemonState === "unverified". */
  daemonEvidence?: DaemonUnverifiedEvidence;
  /** B1 ROUND 2 — the live fleet-restore lifecycle; when present it renders (progress → rollup+triage)
   *  and takes precedence over the cockpit, so restore progress and the triage list are visible. */
  restore?: RestoreLifecycleVM;
  /** B1 ROUND 3 (HIGH-2) — vertical scroll offset into the restore content, so a triage list longer
   *  than the viewport stays keyboard-walkable (the shell reports contentMaxOffset for clamping). */
  restoreScroll?: number;
  /** B1 ROUND 10 — the ⏎ confirm banner text (non-zero-generation restore). Rendered IN the cockpit so
   *  the confirm is visible where the operator looks (ViewState.notice is not shown in the cockpit). */
  confirm?: string;
}

/** replace ONE character at a plain-text position inside a token-segment row
 * with the keyboard focus marker (accent, bold) — keeps plain(segs) equal to
 * the spliced content text (R2 HIGH-3) */
function spliceMarkerIntoSegs(
  segs: NonNullable<ContentLine["segs"]>,
  pos: number,
): NonNullable<ContentLine["segs"]> {
  const out: NonNullable<ContentLine["segs"]> = [];
  let at = 0;
  for (const seg of segs) {
    const end = at + seg.text.length;
    if (pos >= at && pos < end) {
      const off = pos - at;
      if (off > 0) out.push({ ...seg, text: seg.text.slice(0, off) });
      out.push({ text: "›", token: "accent", bold: true });
      if (off + 1 < seg.text.length) out.push({ ...seg, text: seg.text.slice(off + 1) });
    } else {
      out.push(seg);
    }
    at = end;
  }
  return out;
}

function paneRule(cols: number, explW: number, joint: "top" | "bottom", leftTitle?: string, rightTitle?: string): string {
  void joint;
  const left = leftTitle ? `━ ${leftTitle} ` : "";
  const right = rightTitle ? `━ ${rightTitle} ` : "";
  const leftPart = (left + "━".repeat(explW)).slice(0, explW);
  const rightPart = (right + "━".repeat(cols)).slice(0, Math.max(cols - explW - 1, 0));
  return `${leftPart}╋${rightPart}`;
}

function keybindHints(state: ViewState): string {
  if (state.copyMode) return "drag to select/copy · v resume mouse · q quit";
  // Affordance surfaces on REAL scrollability (contentMaxOffset), never gated
  // behind already-being-content-focused — that gate was the catch-22 (the
  // hint hid exactly where it was needed). When ↑↓ themselves scroll (a
  // scrollable spec detail), the nav label says so; otherwise ↑↓ move and the
  // page keys carry the scroll.
  if (state.section === "config") return state.configKey
    ? `${specDetailArrowsScroll(state) ? "↑↓ scroll" : "↑↓ move"} · esc back · v select/copy · refresh · q quit`
    : "↑↓ move · ←→ pane · ⏎ open · / search · esc back · refresh · q quit";
  const arrowsScroll = specDetailArrowsScroll(state);
  const nav = arrowsScroll ? "↑↓ scroll" : "↑↓ move";
  const pageScroll = state.contentMaxOffset > 0 && !arrowsScroll ? "⇞⇟ scroll · " : "";
  const filter = state.filter ? "/ replace · esc clear" : "/ filter";
  return `${nav} · ←→ pane · ⏎ open · ${pageScroll}: command · ${filter} · S startup · v select/copy · f footer · q quit`;
}

/** The PULSE view renders FULL-WIDTH with NO explorer sidebar (increment 2). A
 * minimal self-contained screen: cmd bar + a full-width titled rule + the pulse
 * lines laid across all `cols` + the bottom chrome. Skips computeExplorerRows
 * and the left│content paint entirely. */
/** Truncate a seg list to a column budget, cutting the final seg mid-text if
 * needed — keeps plain(segs) === the truncated content prefix (strip-invariant). */
function truncateSegs(
  segs: NonNullable<Screen["segRows"]>[number],
  width: number,
): NonNullable<Screen["segRows"]>[number] {
  const out: NonNullable<Screen["segRows"]>[number] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= width) break;
    const room = width - used;
    if (s.text.length <= room) {
      out.push(s);
      used += s.text.length;
    } else {
      out.push({ ...s, text: s.text.slice(0, room) });
      break;
    }
  }
  return out;
}

/** The disclosure cell is a distinct control from the row body. Hit lookup is
 * first-match, so register this one-cell target before the row-wide target. */
function pushExplorerTargets(
  hitMap: Screen["hitMap"],
  row: import("./types.js").ExplorerRow,
  display: string,
  y: number,
  explorerWidth: number,
): void {
  if (row.disclosureAction) {
    const at = display.search(/[⌄›]/);
    if (at >= 0) hitMap.push({ y, x1: at + 2, x2: at + 2, action: row.disclosureAction });
  }
  hitMap.push({ y, x1: 1, x2: explorerWidth, action: row.action });
}

function readStatus(load: import("./types.js").LoadState, zone: string): string {
  const at = load.retainedAt ?? load.lastSuccessAt;
  const basis = at === undefined ? "" : ` · last ${displayTime(new Date(at).toISOString(), zone)}`;
  if (load.inFlight) return `${load.settled ? "Refreshing" : "Loading"}…${basis} · ? Help`;
  if (load.stale) return `${at === undefined ? "Read failed" : "Could not refresh"}${basis} · refresh to Retry`;
  return `Tab complete · ? help${basis}`;
}

function renderPulseScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions, inputLine: string): Screen {
  const { cols = 120, rows = 32, nowMs = 0 } = options;
  const explW = explorerWidth(cols);
  // FOUNDER OPTION-B (supersedes the earlier full-width ruling): PULSE renders as
  // a content-pane view INSIDE the normal chrome — the EXPLORER sidebar STAYS (it
  // is the founder's action path: from a needs-you row, mouse to the sidebar and
  // navigate). So this builds the same explorer│content split every other view
  // uses; the lanes truncate to the content width (trade accepted by the founder).
  // The per-cell selection highlight + fresh-output flash paint through the NORMAL
  // split-pane segRows path — no full-width stylize bypass (that special-case is
  // gone). incr-5's refresh-seam/motion/reader-clock ride along unchanged.
  //
  // WHY a dedicated renderer + custom cell targets instead of the generic content
  // zone machinery (reviewer: the documented reason parity-with-native yields):
  // the approved mock's `.sel` row is a HIGHLIGHTED CELL — an affordance the
  // native "›"-marker zone selection cannot express. The mock BINDS that
  // affordance, so selection stays incr-4's per-cell accent-bg, walked
  // COLUMN-MAJOR by pulseLaneTargets. The sidebar half is the normal split (same
  // helpers), so the founder's navigator behaves identically to every other view.
  const reduced = reducedMotion();
  const load = options.load ?? { inFlight: false, settled: true };
  const loading = load.inFlight || !load.settled;
  const frame = spinnerFrame(Math.floor(nowMs / MOTION_FRAME_MS), options.colorMode ?? "truecolor", reduced);
  const liveFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, reduced));
  const ackFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, false));

  const lines: string[] = [];
  const hitMap: Screen["hitMap"] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  const explorerRows: Screen["explorerRows"] = [];
  const explorerMeta: NonNullable<Screen["explorerMeta"]> = {};
  const contentTargets: Screen["contentTargets"] = [];
  const flashRows: number[] = [];
  let flashAck = false;

  lines.push(pad(`cmd ▸ ${inputLine}▊${inputLine ? "" : "  " + readStatus(load, state.timeZone)}`, cols));
  if (load.stale && !inputLine) hitMap.push({ y: 1, x1: 9, x2: cols, action: { type: "noop" } });
  if (options.completion) {
    lines.push(pad(options.completion.message, cols));
    for (const candidate of options.completion.candidates.slice(0, 4)) lines.push(pad(`  ${candidate}`, cols));
    if (options.completion.candidates.length > 4) lines.push(pad("  … keep typing to narrow matches", cols));
  }

  const explorerTitle = state.focusedPane === "explorer" ? "{ EXPLORER }" : "EXPLORER";
  const contentTitle = state.focusedPane === "content" ? "{ PULSE }" : "PULSE";
  lines.push(paneRule(cols, explW, "top", explorerTitle, contentTitle));

  const contentWidth = Math.max(cols - explW - 2, 0);
  const model = buildPulseModel(snap, nowMs);
  const chromeRows = 3; // bottom rule + hint bar + status line
  const bodyRows = Math.max(rows - lines.length - chromeRows, 1);

  const maxContentOffset = Math.max(renderPulseView(model).length - bodyRows, 0);
  const contentStart = Math.min(state.contentOffset, maxContentOffset);

  // Lane cells (column-major), CLIPPED to the content width: a cell whose column
  // span starts past the content edge is not rendered → not a target (no
  // invisible-but-actionable cell). x is content-relative (1-based within lanes).
  const allTargets = pulseLaneTargets(model).filter((t) => t.x1 <= contentWidth);
  const visibleTargets = allTargets.filter((t) => t.lineIndex >= contentStart && t.lineIndex < contentStart + bodyRows);

  // The lane cursor lives on the CONTENT pane; it shows only when content is
  // focused (explorer-focused → the sidebar cursor leads, the founder's path).
  const sel =
    state.focusedPane === "content" && visibleTargets.length > 0
      ? Math.min(Math.max(state.contentSelection, 0), visibleTargets.length - 1)
      : -1;
  if (sel >= 0) {
    const t = visibleTargets[sel]!;
    model.lanes[t.lane]!.rows[t.row]!.selected = true; // per-cell accent-bg (mock affordance)
  }

  // motion budget: NOW (lane 0) cells whose seat produced fresh pane output flash
  // per-cell (inverse) — the SAME served terminalActive false→true onset the table
  // row flash rides. JUST FINISHED / UP NEXT never flash (no shipped finish event).
  if (liveFlashes.length) {
    for (const t of allTargets) {
      if (t.lane !== 0) continue;
      const a = t.action;
      if (a.type !== "drill" || a.resource !== "agent" || !a.target?.rig || !a.target?.pod) continue;
      const key = `agent:${a.target.host}/${a.target.rig}/${a.target.pod}/${a.name}`;
      if (liveFlashes.some((f) => f.key === key)) model.lanes[t.lane]!.rows[t.row]!.flashed = true;
    }
  }

  const pulseLines = renderPulseView(model);
  const visiblePulse = pulseLines.slice(contentStart, contentStart + bodyRows);

  // EXPLORER sidebar = the normal navigator (same helpers as every other view).
  const explorer = computeExplorerRows(state, snap);
  const { labels: explorerDisplay, metas: explorerMetas } = navigatorDisplay(explorer, snap, explW - 1);
  const explorerStart = Math.min(Math.max(state.selection - bodyRows + 1, 0), Math.max(explorer.length - bodyRows, 0));

  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1;
    // EXPLORER half (identical to the normal split — real chrome, the action path)
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    const flashed = row?.key != null && ackFlashes.some((f) => f.key === row.key);
    if (flashed) flashAck = true;
    const marker = explorerIndex === state.selection && row ? (flashed ? "◆" : "▶") : flashed ? "≈" : " ";
    const left = pad(row ? `${marker}${explorerDisplay[explorerIndex] ?? row.label}` : "", explW);
    // CONTENT half = the pulse view, truncated to the content width. Selection is
    // the per-cell bg on the segs (mock affordance), so the content marker slot
    // stays blank — no "›" chevron (the native affordance the mock overrides).
    const citem = visiblePulse[i];
    const contentText = (citem?.text ?? "").slice(0, contentWidth);
    lines.push(pad(`${left}┃ ${contentText}`, cols));
    if (row) {
      pushExplorerTargets(hitMap, row, explorerDisplay[explorerIndex] ?? row.label, y, explW);
      explorerRows.push({ ...row, y });
      const em = explorerMetas[explorerIndex];
      if (em && em.length) explorerMeta[y] = em.map((run) => ({ start: 1 + run.start, segs: run.segs }));
      if (row.key && liveFlashes.some((f) => f.key === row.key)) flashRows.push(y);
    }
    if (citem?.segs) segRows[y] = truncateSegs(citem.segs, contentWidth);
  }

  // Lane cells → content targets, x mapped into the content column (origin =
  // explorer boundary + 3, matching normal content geometry), clamped to `cols`.
  for (const t of visibleTargets) {
    const x1 = explW + 2 + t.x1;
    if (x1 > cols) continue;
    const target = { y: t.lineIndex - contentStart + 3, x1, x2: Math.min(explW + 2 + t.x2, cols), action: t.action };
    contentTargets.push(target);
    hitMap.push(target);
  }

  lines.push(paneRule(cols, explW, "bottom"));
  lines.push(pad(keybindHints(state), cols));
  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} read(s) failed: ${snap.readErrors[0]}` : "";
  // Honest first-load lifecycle: while the refresh owner's FIRST hydrate is in
  // flight (!settled) show a spinner-tagged "loading" — distinguishing "still
  // reading" from a genuinely empty fleet. Once settled, refreshes are silent;
  // the footer's live "updated Ns ago" IS the ongoing refresh signal (reader
  // clock), so a settled empty view stays calm. Reduced motion → static "·".
  const loadTag = loading ? `  ${frame} loading` : "";
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}${loadTag}${state.timeZoneWarning ? " · ⚠ timezone; run timezone" : ""}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  const anyFlash = model.lanes.some((l) => l.rows.some((r) => r.flashed));
  return {
    lines: lines.slice(0, rows),
    explorerWidth: explW,
    hitMap,
    contentTargets,
    contentMaxOffset: maxContentOffset,
    explorerRows,
    segRows,
    explorerMeta,
    // whole-line explorer activity flash (tmux-style) on the sidebar half, exactly
    // as the table view; PULSE cell flashes are PER-CELL (inverse in segRows).
    flashRows,
    // schedule the bounded-expiry redraw while the first-load spinner or an
    // un-expired flash is live; reduced motion (no animation) settles via refresh.
    motionActive: (!reduced && loading) || anyFlash || flashRows.length > 0 || flashAck,
  };
}

// Crash-cart shell (ruling 3c6c2be0): the daemon-down cockpit as a content-pane view inside the
// standard explorer│content shell — the LEDGER-FED explorer on the left (honestly marked), the
// approved content on the right. Mirrors renderPulseScreen's split; content segs paint via the normal
// split-pane path (stylize │ branch), so no full-width bypass. All rails live in the content builders.
type PaneContentLine = { text: string; action?: Action; segs?: Array<{ text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }> };

/** Word-wrap long content lines to the pane width with a hanging indent, so nothing is silently
 *  clipped off the right edge. Used ONLY where the content is short enough to afford the extra rows
 *  (the restore lifecycle view) — the fixed-height cockpit still clips to preserve its row layout. */
function wrapContentLines(content: PaneContentLine[], width: number): PaneContentLine[] {
  if (width <= 0) return content;
  const out: PaneContentLine[] = [];
  const indent = "     ";
  for (const item of content) {
    const text = item.text ?? "";
    if (text.length <= width) {
      out.push(item);
      continue;
    }
    let rest = text;
    let first = true;
    while (rest.length > 0) {
      const w = first ? width : Math.max(1, width - indent.length);
      let cut = rest.length <= w ? rest.length : w;
      if (cut < rest.length) {
        const sp = rest.lastIndexOf(" ", cut);
        if (sp > 0 && sp >= Math.floor(w * 0.5)) cut = sp; // break on a word boundary when reasonable
      }
      const chunk = rest.slice(0, cut).trimEnd();
      rest = rest.slice(cut).replace(/^\s+/, "");
      out.push(first ? { text: chunk, segs: item.segs, action: item.action } : { text: indent + chunk });
      first = false;
    }
  }
  return out;
}

function crashCartShell(
  content: PaneContentLine[],
  led: Pick<ReturnType<typeof buildLedgerExplorer>, "note" | "rows">,
  contentTitle: string,
  cols: number,
  rows: number,
  inputLine: string,
  opts?: { wrap?: boolean; scroll?: number },
): Screen {
  const explW = explorerWidth(cols);
  const lines: string[] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  const hitMap: Screen["hitMap"] = [];
  lines.push(pad(`cmd ▸ ${inputLine}▊`, cols));
  lines.push(paneRule(cols, explW, "top", "{ EXPLORER }", contentTitle));

  // The explorer's source note, then any discovered rigs (name + seat count).
  const leftRows: string[] = [led.note, "", ...led.rows.map((r) => `${r.label} (${r.seatCount})`)];
  const contentWidth = Math.max(cols - explW - 2, 0);
  if (opts?.wrap) content = wrapContentLines(content, contentWidth);
  const bodyRows = Math.max(rows - 2 - 3, 1); // minus cmd bar + top rule + (bottom rule, hints, status)
  // HIGH-2 — when content exceeds the viewport, it is VERTICALLY SCROLLABLE: contentMaxOffset is the
  // furthest row the operator can scroll to, and the rendered window starts at the clamped scroll offset.
  // A list that fits (offset 0, maxOffset 0) is unchanged. Only the content pane scrolls; the explorer stays.
  const contentMaxOffset = Math.max(0, content.length - bodyRows);
  const scroll = Math.max(0, Math.min(contentMaxOffset, opts?.scroll ?? 0));
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1;
    const left = pad(leftRows[i] ?? "", explW);
    const citem = content[scroll + i];
    const contentText = (citem?.text ?? "").slice(0, contentWidth);
    if (citem?.action) hitMap.push({ y, x1: explW + 2, x2: cols, action: citem.action });
    lines.push(pad(`${left}┃ ${contentText}`, cols));
    if (citem?.segs) segRows[y] = truncateSegs(citem.segs, contentWidth);
  }
  lines.push(paneRule(cols, explW, "bottom"));
  lines.push(pad("", cols));
  const scrollHint = contentMaxOffset > 0 ? ` · ↑↓ scroll (${scroll}/${contentMaxOffset})` : "";
  lines.push(pad(`[crash-cart] ${led.note}${scrollHint}`, cols));
  while (lines.length < rows) lines.push("");
  return {
    lines: lines.slice(0, rows),
    explorerWidth: explW,
    hitMap,
    contentTargets: [],
    contentMaxOffset,
    explorerRows: [],
    segRows,
  };
}

export function renderScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  if (state.palette) return helpScreen(state.palette, options.commandContext ?? "standard", options.cols ?? 120, options.rows ?? 32);
  const screen = renderBody(state, snap, options, inputLine);
  const commandReady = !options.startup?.open && !options.restore && !options.unavailable && (!options.daemonState || options.daemonState === "up");
  if (commandReady) {
    const reduced = reducedMotion();
    if (!commandFocusVisible(options.nowMs ?? 0, inputLine.length > 0, reduced)) {
      const line = screen.lines[0]!;
      screen.lines[0] = line.slice(0, 6) + " " + line.slice(7);
    }
    screen.commandMotionActive = !reduced && inputLine.length === 0;
  }
  return screen;
}

function renderBody(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  const { cols = 120, rows = 32, nowMs = 0 } = options;
  const fullReading = !options.startup?.open && (!!state.file || !!state.externalUrl || (cols <= 90 && state.section === "specs" && state.drill.length > 0));
  const explW = fullReading ? 0 : explorerWidth(cols);
  if (options.startup?.open) {
    const startup = options.startup;
    const content = wrapContentLines(startupLines(startup).map((line) => ({ ...line,
      text: line.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, " ")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]"),
    })), Math.max(1, cols - explW - 2));
    const selected = content.findIndex((line) => line.action?.type === "startup" && line.action.key === `select:${startup.local?.selected ?? startup.selected}`);
    const scroll = startup.local && !startup.local.result.entries ? startup.local.scroll : startup.expanded ? startup.scroll : Math.max(0, selected - Math.max(1, rows - 12));
    const screen = crashCartShell(content, { note: "startup", rows: [] }, "START AND RETURN", cols, rows, "", { scroll });
    screen.lines[rows - 1] = pad("? Help · w Skip · L Local · ↑↓ scroll · Enter read · Esc Back · q Quit", cols);
    return screen;
  }
  // 5.2 crash-cart (shell-placement rework, ruling 3c6c2be0): daemon-DOWN renders as a CONTENT-PANE
  // view inside the standard shell — the explorer sidebar is ALWAYS present, ledger-fed + honestly
  // marked (from the SAME one-JSON discovery, never a second read). Content moves into the right pane
  // verbatim; all rails stand. DOWN → cockpit; UNVERIFIED → cannot-verify (no restore).
  // B1 ROUND 2 — an ACTIVE fleet restore takes precedence over the cockpit: the operator sees live
  // progress (from the poll stream) and, on done, the rollup + keyboard-walkable triage list.
  if (options.restore) {
    const led = buildLedgerExplorer(options.crashCart?.foundOnHost ?? []);
    // wrap: the triage needs are full sentences — wrap them to the pane so the EXACT need is never
    // clipped off the edge. scroll: a triage list longer than the viewport is vertically scrollable so
    // the final row's exact need is reachable (HIGH-2 — keyboard-walkable, not viewport-truncated).
    return crashCartShell(renderRestoreLifecycleView(options.restore), led, "RESTORE", cols, rows, inputLine, {
      wrap: true,
      scroll: options.restoreScroll ?? 0,
    });
  }
  if (options.unavailable) {
    const detail = options.unavailable
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
    const summary = /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|better-sqlite3/i.test(detail)
      ? "The installed native module cannot load in this runtime. Repair the installation prerequisite, then retry."
      : "Startup state could not be read. Retry after resolving the reported prerequisite.";
    return crashCartShell([
      { text: "Startup prerequisite unavailable" },
      { text: summary },
      { text: "Saved identity and conversation history have not been classified as missing." },
      { text: "" },
      { text: "r retry · d details · q quit" },
      ...(options.unavailableExpanded ? [{ text: "" }, { text: detail }] : []),
    ], { note: "state unavailable", rows: [] }, "STARTUP", cols, rows, inputLine,
    { wrap: true, scroll: options.restoreScroll ?? 0 });
  }
  if (options.daemonState === "down" && options.crashCart) {
    const led = buildLedgerExplorer(options.crashCart.foundOnHost);
    // B1 ROUND 10 — when a confirm is armed, render it at the TOP of the cockpit (where the operator
    // looks) so the first ⏎ is visibly acknowledged; wrap so the sentence is not clipped at the pane edge.
    const content = options.starting
      ? [{ text: `Starting daemon at ${options.starting}…` }, { text: "Seats remain stopped until selected." }]
      : options.confirm
      ? [...renderConfirmBanner(options.confirm), ...renderCrashCartView(options.crashCart)]
      : renderCrashCartView(options.crashCart);
    return crashCartShell(content, led, "CRASH-CART", cols, rows, inputLine, options.confirm ? { wrap: true } : undefined);
  }
  if (options.daemonState === "unverified" && options.daemonEvidence) {
    const led = { note: "daemon unverified", rows: [] }; // No ledger discovery occurred on this path.
    return crashCartShell(renderUnverifiedView(options.daemonEvidence), led, "DAEMON?", cols, rows, inputLine);
  }
  // PULSE (founder Option-B): a content-pane view inside the NORMAL explorer│
  // content chrome — renderPulseScreen builds its own split (sidebar + lanes)
  // and rides the same segRows paint path, so it returns before the table layout.
  if (state.viewTab === "pulse" && options.load?.settled !== false) return renderPulseScreen(state, snap, options, inputLine);
  // S19 round-5 (guard): one spinner frame per render pass from caller time;
  // `loading` comes from the refresh OWNER (omitted = settled — demo/fixture
  // data IS the answer); reduced-motion kills all of it
  const reduced = reducedMotion();
  const load = options.load ?? { inFlight: false, settled: true };
  const motion: MotionCtx = {
    frame: spinnerFrame(Math.floor(nowMs / MOTION_FRAME_MS), options.colorMode ?? "truecolor", reduced),
    reduced,
    used: false,
    loading: load.inFlight || !load.settled,
  };
  const lines: string[] = [];
  const hitMap: Screen["hitMap"] = [];
  // S19 MR5a (guard-corrected): ONE ▊ insertion cell renders at the bar's
  // current insertion point for EMPTY and non-empty buffers alike — the
  // shell accepts typing from the empty state, so the honest readiness
  // affordance must show BEFORE the first key (no new focus state; stylize
  // paints the cell; the shared motion clock controls its visibility).
  lines.push(pad(`cmd ▸ ${inputLine}▊${inputLine ? "" : "  " + readStatus(load, state.timeZone)}`, cols));
  if (load.stale && !inputLine) hitMap.push({ y: 1, x1: 9, x2: cols, action: { type: "noop" } });
  if (options.completion) {
    lines.push(pad(options.completion.message, cols));
    for (const candidate of options.completion.candidates.slice(0, 4)) lines.push(pad(`  ${candidate}`, cols));
    if (options.completion.candidates.length > 4) lines.push(pad("  … keep typing to narrow matches", cols));
  }

  const sectionTitle = { topology: "TOPOLOGY", specs: "SPECS", scopes: "PROJECTS", needs: "FEED", system: "SYSTEM · HEALTH", config: "SYSTEM · CONFIGURATION", connections: "SYSTEM · CONNECTIONS" }[state.section] ?? state.section.toUpperCase();
  // active-pane emphasis (k9s-class chrome): the focused pane's title is bracketed
  const explorerTitle = state.focusedPane === "explorer" ? "{ EXPLORER }" : "EXPLORER";
  const contentTitle = state.focusedPane === "content" ? `{ ${sectionTitle} }` : sectionTitle;
  lines.push(fullReading ? pad(`━ ${state.file ? "READ" : state.externalUrl ? "EXTERNAL URL" : "SPECS"} · Esc / ← Back `, cols) : paneRule(cols, explW, "top", explorerTitle, contentTitle));

  const explorer = fullReading ? [] : computeExplorerRows(state, snap);
  // Slice-17: the file-tree re-skin is a DISPLAY transform only — rows, keys,
  // actions, and the hit-map all keep resolving against the row model above.
  const { labels: explorerDisplay, metas: explorerMetas } = navigatorDisplay(explorer, snap, explW - 1);
  const contentWidth = Math.max(cols - explW - (fullReading ? 1 : 2), 0);
  const previous = !load.settled && !state.externalUrl ? options.previousPage : undefined;
  const content: ContentLine[] = previous
    ? [...wrapDetailLines([{ text: `Previous: ${previous.state.section} · ${previous.state.file ? `${previous.state.file.root}/${previous.state.file.path}` : previous.state.drill.map(d => d.name).join(" / ") || [previous.state.project?.id, previous.state.scopesMission, previous.state.terminalView].filter(Boolean).join(" / ") || "overview"}` }], contentWidth),
       { text: `Opening ${sectionTitle.toLowerCase()}… · Explorer remains available` },
       ...contentLines(previous.state, previous.snapshot, contentWidth, { ...motion, loading: false }).map(line => ({ text: line.text }))]
    : !load.settled && !state.externalUrl
      ? [{ text: `${sectionTitle} · choose a location in Explorer` }, { text: `${motion.frame} ${sectionTitle.toLowerCase()} read pending…` }]
      : contentLines(state, snap, contentWidth, motion);
  if (!load.settled && !reduced) motion.used = true;
  const footer = state.footerOn ? snap.stream.at(-1) : undefined;
  // round-5 (guard): the tmux-style ONE-SHOT activity flash targets the
  // flashed agent's EXPLORER row — per-seat pane-output events from the
  // refresh owner, windowed here. The ambient rig-stream footer is NOT an
  // event source and never flashes. round-6 (guard finding 2): the SGR
  // inverse is the animation (killed under reduced motion), while the
  // acknowledgement WINDOW itself ignores reduced — the plain-layer "≈"
  // marker-slot glyph is the stable static signal reduced motion (and
  // NO_COLOR) keeps, expiring with the same bounded window.
  const liveFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, reduced));
  const ackFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, false));
  const chromeRows = footer ? 4 : 3; // bottom rule + hint bar + status line (+ footer)
  const bodyRows = Math.max(rows - lines.length - chromeRows, 1);
  const explorerStart = Math.min(
    Math.max(state.selection - bodyRows + 1, 0),
    Math.max(explorer.length - bodyRows, 0),
  );
  const contentRows = content.length > bodyRows ? Math.max(bodyRows - 1, 0) : bodyRows;
  const maxContentOffset = Math.max(content.length - contentRows, 0);
  const contentStart = Math.min(state.contentOffset, maxContentOffset);
  const visibleContent = content.slice(contentStart, contentStart + contentRows);
  if (content.length > bodyRows) {
    const scrollText = `scroll ↑/↓ · ${contentStart + 1}-${contentStart + visibleContent.length} of ${content.length}`;
    const up = scrollText.indexOf("↑");
    const down = scrollText.indexOf("↓");
    visibleContent.push({
      text: scrollText,
      zones: [
        { start: up, end: up + 1, action: { type: "content-scroll", delta: -10 } },
        { start: down, end: down + 1, action: { type: "content-scroll", delta: 10 } },
      ],
    });
  }
  const explorerRows: Screen["explorerRows"] = [];
  const contentTargets: Screen["contentTargets"] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  const explorerMeta: NonNullable<Screen["explorerMeta"]> = {};
  const flashRows: number[] = [];
  let flashAck = false;
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1; // 1-based terminal row this line will occupy
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    // round-6/7 (guard): the fresh-output ack rides the marker slot (zero
    // geometry drift). Collision matrix: a SELECTED flashed row shows "»" —
    // still unmistakably the selection chevron, while visibly distinct from
    // both the plain "›" baseline and the unselected "≈" ack — so neither
    // signal is lost under reduced motion / NO_COLOR; expiry returns the
    // exact "›" baseline
    const flashed = row?.key != null && ackFlashes.some((f) => f.key === row.key);
    if (flashed) flashAck = true;
    const marker = explorerIndex === state.selection && row ? (flashed ? "◆" : "▶") : flashed ? "≈" : " ";
    const left = pad(row ? `${marker}${explorerDisplay[explorerIndex] ?? row.label}` : "", explW);
    const item = visibleContent[i];
    const targetIndex = contentTargets.length;
    const zones = item?.zones ?? [];
    const selectedOnLine = state.focusedPane === "content" ? state.contentSelection - targetIndex : -1;
    const selectedZone = selectedOnLine >= 0 && selectedOnLine < zones.length ? zones[selectedOnLine] : undefined;
    const selectedAction = !!item?.action && selectedOnLine === zones.length;
    let contentText = item?.text ?? "";
    let contentMarker = selectedAction ? "›" : " ";
    let rowSegs = item?.segs;
    if (selectedZone) {
      if (selectedZone.start > 0) {
        contentText = `${contentText.slice(0, selectedZone.start - 1)}›${contentText.slice(selectedZone.start)}`;
        // R2 HIGH-3: a segs row's paint source must carry the SAME splice the
        // plain text carries, or stylization erases the keyboard focus marker
        if (rowSegs) rowSegs = spliceMarkerIntoSegs(rowSegs, selectedZone.start - 1);
      } else contentMarker = "›";
    }
    lines.push(pad(fullReading ? `${contentMarker}${contentText}` : `${left}┃${contentMarker}${contentText}`, cols));
    if (row) {
      pushExplorerTargets(hitMap, row, explorerDisplay[explorerIndex] ?? row.label, y, explW);
      explorerRows.push({ ...row, y });
      const em = explorerMetas[explorerIndex];
      if (em && em.length) explorerMeta[y] = em.map((run) => ({ start: 1 + run.start, segs: run.segs })); // +1 = marker slot
      if (row.key && liveFlashes.some((f) => f.key === row.key)) flashRows.push(y);
    }
    // zones first: hit lookup takes the first match, so a zone wins over the row-wide action
    for (const z of zones) {
      const target = { y, x1: (fullReading ? 2 : explW + 3) + z.start, x2: (fullReading ? 1 : explW + 2) + z.end, action: z.action };
      hitMap.push(target);
      contentTargets.push(target);
    }
    if (item?.action) {
      const target = { y, x1: fullReading ? 2 : explW + 3, x2: cols, action: item.action };
      hitMap.push(target);
      contentTargets.push(target);
    }
    if (rowSegs) segRows[y] = rowSegs;
  }

  if (footer) lines.push(pad(`≋ ${displayTime(footer.tsEmitted, state.timeZone)} ${footer.sourceSession}: ${footer.body}`, cols));
  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} read(s) failed: ${snap.readErrors[0]}` : "";
  lines.push(fullReading ? "━".repeat(cols) : paneRule(cols, explW, "bottom"));
  lines.push(pad(fullReading ? "↑↓ scroll / links · → links · Enter open · Esc Back · refresh · v copy" : keybindHints(state), cols));
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}${state.timeZoneWarning ? " · ⚠ timezone; run timezone" : ""}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  return {
    lines: lines.slice(0, rows),
    explorerWidth: explW,
    hitMap,
    contentTargets,
    contentMaxOffset: maxContentOffset,
    explorerRows,
    segRows,
    explorerMeta,
    flashRows,
    // an un-expired ack (even the static reduced-motion glyph) schedules the
    // bounded expiry redraw — the acknowledgement must settle cleanly
    motionActive: motion.used || flashRows.length > 0 || flashAck,
  };
}
