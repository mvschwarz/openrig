// Hand-rolled ANSI renderer (Phase-0 substrate decision). Pure function:
// (state, snapshot) → {lines, hitMap, explorerRows}. BOTH panes emit hit
// targets — explorer rows AND content-pane surfaces (table rows, view tabs,
// agent-refs, Needs-You items) — so a mouse click anywhere resolves to the
// SAME semantic actions commands produce (PIN 1). Isolated seam: a substrate
// swap touches only this module (spike verdict revisit trigger).
import { computeExplorerRows, findAgent, findSpec, findAgentBySession, agentsRunningSpec } from "./state.js";
import type { Action, FleetSnapshot, NeedsItem, Screen, ViewState } from "./types.js";

const EXPL_W = 30;

interface ContentLine {
  text: string;
  /** dispatched when this line is clicked (open/navigate class only) */
  action?: Action;
  /** sub-line click zones (content-relative indices); matched before `action`.
   * BR-9: zone actions are drive-structure only (lifecycle + navigation). */
  zones?: Array<{ start: number; end: number; action: Action }>;
}

function pad(text: string | number | null | undefined, width: number): string {
  const t = String(text ?? "");
  return t.length >= width ? t.slice(0, width) : t + " ".repeat(width - t.length);
}

function padLeft(text: string | number | null | undefined, width: number): string {
  const t = String(text ?? "");
  return t.length >= width ? t.slice(0, width) : " ".repeat(width - t.length) + t;
}

type Align = "left" | "right";
const AGENT_COLS: Array<[string, number, Align]> = [
  ["RIG", 18, "left"],
  ["POD", 8, "left"],
  ["AGENT", 16, "left"],
  ["RUNTIME", 13, "left"],
  ["CTX%", 4, "right"],
  ["TOKENS", 7, "right"],
  ["STATUS", 17, "left"],
  ["ACTIONS", 14, "left"],
];

function tableRow(cells: Array<string | null>): string {
  return AGENT_COLS.map(([, w, align], i) => (align === "right" ? padLeft(cells[i], w) : pad(cells[i], w))).join(" ");
}

function tabsLine(state: ViewState, suffix: string): ContentLine[] {
  const table = state.viewTab === "table" ? "[ TABLE ]" : "  TABLE  ";
  const overview = state.viewTab === "overview" ? "[ OVERVIEW ]" : "  OVERVIEW  ";
  return [
    { text: `${table}${overview}   ${suffix}`, action: { type: "tab", tab: state.viewTab === "table" ? "overview" : "table" } },
  ];
}

function needsLine(prefix: string, item: NeedsItem, snap: FleetSnapshot): ContentLine {
  const agent = findAgentBySession(snap, item.target);
  return {
    text: `${prefix}${item.kind}  ${item.target}  — ${item.detail}${agent ? "  (open ▸)" : ""}`,
    ...(agent ? { action: { type: "drill", resource: "agent", name: agent.name } as const } : {}),
  };
}

function contentLines(state: ViewState, snap: FleetSnapshot): ContentLine[] {
  const lines: ContentLine[] = [];
  if (state.section === "topology") {
    if (state.runningOf) {
      lines.push({ text: `seats running spec "${state.runningOf}":` });
      for (const seat of agentsRunningSpec(snap, state.runningOf))
        lines.push({ text: `  ● ${seat}  (open: agent ${seat})`, action: { type: "drill", resource: "agent", name: seat } });
      if (lines.length === 1) lines.push({ text: "  (no seats currently run it)" });
      return lines;
    }
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "agent") {
      const found = findAgent(snap, leaf.name);
      if (!found) return [{ text: `agent "${leaf.name}" not in the current snapshot` }];
      const { agent, rig, pod } = found;
      lines.push({ text: `agent ${agent.name}` });
      lines.push({ text: `  rig ${rig.name} · pod ${pod.name} · runtime ${agent.runtime}` });
      if (agent.spec)
        lines.push({ text: `  spec ${agent.spec}  (open: spec-of ${agent.name})`, action: { type: "cross", kind: "spec-of", name: agent.name } });
      lines.push({ text: `  state ${agent.status}` });
      if (agent.attach) lines.push({ text: `  attach: ${agent.attach}` });
      lines.push({ text: `  term ▸ (open pod terminal)`, action: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${pod.name}` } });
      return lines;
    }
    const rigName = state.drill.find((d) => d.kind === "rig")?.name ?? snap.hosts[0]?.rigs[0]?.name;
    const rig = snap.hosts.flatMap((h) => h.rigs).find((r) => r.name === rigName);
    if (!rig) return [{ text: "no rig in view — waiting on the daemon read (honest-empty, not fabricated)" }];
    const podFilter = leaf?.kind === "pod" ? leaf.name : null;
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })));
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter));
    const suffix = `rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ""}${state.filter ? ` · filter "${state.filter}"` : ""}`;
    lines.push(...tabsLine(state, suffix));
    if (state.viewTab === "overview") {
      lines.push({ text: `rig ${rig.name} — ${rig.pods.length} pods · ${all.length} agents` });
      for (const pod of rig.pods)
        lines.push({
          text: `  ▾ ${pod.name} — ${pod.agents.length} agents`,
          action: { type: "drill", resource: "pod", name: pod.name },
        });
      return lines;
    }
    lines.push({ text: tableRow(AGENT_COLS.map(([name]) => name)) });
    lines.push({ text: "─".repeat(AGENT_COLS.reduce((n, [, w]) => n + w + 1, -1)) });
    const actionsColStart = AGENT_COLS.slice(0, -1).reduce((n, [, w]) => n + w + 1, 0);
    for (const a of rows) {
      // ACTIONS = drive-structure ONLY (BR-9), each mapped to an EXISTING
      // write contract: `run ▸` = the rig-restore write (rendered only where
      // it applies — the seat is not running); `term ▸` = the terminal-open
      // view contract (pod-scoped, the web's granularity). No false affordance.
      const canRun = a.status !== "running";
      const actionsCell = canRun ? "run ▸ · term ▸" : "term ▸";
      const zones: ContentLine["zones"] = [];
      const termOffset = actionsColStart + actionsCell.indexOf("term ▸");
      zones.push({ start: termOffset, end: termOffset + "term ▸".length, action: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${a.pod}` } });
      if (canRun)
        zones.push({
          start: actionsColStart,
          end: actionsColStart + "run ▸".length,
          action: { type: "act", act: "run", rigId: rig.id ?? rig.name, agent: a.name },
        });
      lines.push({
        // the WHOLE row is the hit surface (not a testid'd control): clicking
        // any visible cell opens the agent; the ACTIONS zones override.
        text: tableRow([
          rig.name,
          a.pod,
          a.name,
          a.runtime,
          a.context == null ? "—" : `${a.context}%`,
          a.tokens ?? "—",
          a.status,
          actionsCell,
        ]),
        action: { type: "drill", resource: "agent", name: a.name },
        zones,
      });
    }
    lines.push({ text: "" });
    lines.push({ text: `${rows.length} of ${all.length} agents shown` });
    return lines;
  }
  if (state.section === "specs") {
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "spec") {
      const spec = findSpec(snap, leaf.name);
      if (!spec) return [{ text: `spec "${leaf.name}" not in the current snapshot` }];
      if (spec.agentRefs) {
        lines.push({ text: `rig spec ${spec.name}   tabs: topology [ CONFIGURATION ] yaml` });
        lines.push({ text: "  members:" });
        for (const ref of spec.agentRefs)
          lines.push({ text: `    ▪ ${ref}  (open: spec ${ref})`, action: { type: "drill", resource: "spec", name: ref } });
      } else {
        lines.push({ text: `agent spec ${spec.name}${spec.version ? ` · v${spec.version}` : ""}` });
        if (spec.description) lines.push({ text: `  ${spec.description}` });
        lines.push({ text: `  runtime ${spec.runtime ?? "—"}` });
        if (spec.skills) lines.push({ text: `  skills: ${spec.skills.join(", ") || "(none)"}` });
        if (spec.hasGuidance != null) lines.push({ text: `  guidance: ${spec.hasGuidance ? "yes" : "no"}` });
        if (spec.startupFiles)
          for (const f of spec.startupFiles)
            lines.push({ text: `  startup: ${f.path}${f.required ? " (required)" : ""}` });
        if (spec.sourcePath) lines.push({ text: `  source: ${spec.sourcePath}` });
        lines.push({ text: `  used by rigs: ${spec.usedByRigs?.join(", ") ?? "—"}` });
        const seats = agentsRunningSpec(snap, spec.name);
        lines.push({
          text: `  seats now: ${seats.join(", ") || "(none)"}  (open: running ${spec.name})`,
          action: { type: "cross", kind: "running", name: spec.name },
        });
      }
      return lines;
    }
    lines.push({ text: "SPEC LIBRARY" });
    for (const kind of ["rig", "agent", "workflow"] as const) {
      const shown = snap.specs.filter((s) => s.kind === kind).filter((s) => !state.filter || s.name.includes(state.filter));
      if (shown.length === 0 && !snap.specs.some((s) => s.kind === kind)) continue;
      lines.push({ text: `  ${kind.toUpperCase()} (${shown.length})` });
      for (const s of shown)
        lines.push({ text: `    ▪ ${s.name}`, action: { type: "drill", resource: "spec", name: s.name } });
    }
    if (snap.specs.length === 0) lines.push({ text: "  (library read pending — honest-empty)" });
    return lines;
  }
  if (state.section === "needs") {
    lines.push({ text: "NEEDS-YOU" });
    for (const item of snap.needs) {
      // open/navigate is the ONLY in-TUI action (B3): the click target joins
      // the item's session back to topology; unresolvable targets never
      // advertise a control that can only fail.
      lines.push(needsLine("  ⚑ ", item, snap));
    }
    if (snap.needs.length === 0) lines.push({ text: "  (no grounded exception items right now)" });
    if (snap.hostsDown.length > 0) {
      // composed BESIDE the items (a separate shipped read), never into the item shape
      lines.push({ text: "" });
      lines.push({ text: "  hosts/rigs down:" });
      // NB: glyphs here must be single-cell — U+26D4 ⛔ is emoji-width (2 cells)
      // and wraps a full-width padded line, shearing every row below it.
      for (const h of snap.hostsDown) lines.push({ text: `  ✖ ${h.hostId} — ${h.status}${h.error ? ` (${h.error})` : ""}` });
    }
    lines.push({ text: "" });
    if (!snap.humanQueueProbed) lines.push({ text: "  human-queue: not yet known (read pending)" });
    else if (snap.humanQueue.length === 0)
      lines.push({ text: "  human-queue: no items (proven empty — surfacing adoption pending)" });
    else
      for (const item of snap.humanQueue)
        lines.push(needsLine("  ☐ ", item, snap));
    return lines;
  }
  return [{ text: `(${state.section})` }];
}

export interface RenderOptions {
  cols?: number;
  rows?: number;
}

export function renderScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  const { cols = 120, rows = 32 } = options;
  const lines: string[] = [];
  const hitMap: Screen["hitMap"] = [];
  lines.push(pad(`cmd ▸ ${inputLine}`, cols));
  lines.push("─".repeat(cols));

  const explorer = computeExplorerRows(state, snap);
  const content = contentLines(state, snap);
  const footer = state.footerOn ? snap.stream.at(-1) : undefined;
  const chromeRows = footer ? 3 : 2; // bottom rule + status line (+ footer)
  const bodyRows = Math.min(Math.max(explorer.length, content.length), Math.max(rows - 2 - chromeRows, 1));
  const explorerStart = Math.min(
    Math.max(state.selection - bodyRows + 1, 0),
    Math.max(explorer.length - bodyRows, 0),
  );
  const explorerRows: Screen["explorerRows"] = [];
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1; // 1-based terminal row this line will occupy
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    const marker = explorerIndex === state.selection && row ? "›" : " ";
    const left = pad(row ? `${marker}${row.label}` : "", EXPL_W);
    const item = content[i];
    lines.push(pad(`${left}│ ${item?.text ?? ""}`, cols));
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action });
      explorerRows.push({ ...row, y });
    }
    // zones first: hit lookup takes the first match, so a zone wins over the row-wide action
    for (const z of item?.zones ?? [])
      hitMap.push({ y, x1: EXPL_W + 3 + z.start, x2: EXPL_W + 2 + z.end, action: z.action });
    if (item?.action) hitMap.push({ y, x1: EXPL_W + 3, x2: cols, action: item.action });
  }

  if (footer) lines.push(pad(`≋ ${footer.tsEmitted.slice(11, 16)} ${footer.sourceSession}: ${footer.body}`, cols));
  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} read(s) failed: ${snap.readErrors[0]}` : "";
  lines.push("─".repeat(cols));
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  return { lines: lines.slice(0, rows), hitMap, explorerRows };
}
