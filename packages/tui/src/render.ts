// Hand-rolled ANSI renderer (Phase-0 substrate decision). Pure function:
// (state, snapshot) → {lines, hitMap, explorerRows}. The hit-map is how mouse
// clicks resolve to the SAME semantic actions commands produce (PIN 1).
// Isolated seam: a substrate swap touches only this module (spike verdict
// revisit trigger).
import { computeExplorerRows, findAgent, findSpec, agentsRunningSpec } from "./state.js";
import type { FleetSnapshot, Screen, ViewState } from "./types.js";

const EXPL_W = 30;

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

function contentLines(state: ViewState, snap: FleetSnapshot): string[] {
  const lines: string[] = [];
  if (state.section === "topology") {
    if (state.runningOf) {
      lines.push(`seats running spec "${state.runningOf}":`);
      for (const seat of agentsRunningSpec(snap, state.runningOf)) lines.push(`  ● ${seat}  (open: agent ${seat})`);
      if (lines.length === 1) lines.push("  (no seats currently run it)");
      return lines;
    }
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "agent") {
      const found = findAgent(snap, leaf.name);
      if (!found) return [`agent "${leaf.name}" not in the current snapshot`];
      const { agent, rig, pod } = found;
      lines.push(`agent ${agent.name}`);
      lines.push(`  rig ${rig.name} · pod ${pod.name} · runtime ${agent.runtime}`);
      lines.push(`  spec ${agent.spec}  (open: spec-of ${agent.name})`);
      lines.push(`  state ${agent.status}`);
      return lines;
    }
    const rigName = state.drill.find((d) => d.kind === "rig")?.name ?? snap.hosts[0]?.rigs[0]?.name;
    const rig = snap.hosts.flatMap((h) => h.rigs).find((r) => r.name === rigName);
    if (!rig) return ["no rig in view — waiting on the daemon read (honest-empty, not fabricated)"];
    const podFilter = leaf?.kind === "pod" ? leaf.name : null;
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })));
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter));
    lines.push(
      `[ TABLE ] OVERVIEW      rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ""}${state.filter ? ` · filter "${state.filter}"` : ""}`,
    );
    lines.push(tableRow(AGENT_COLS.map(([name]) => name)));
    lines.push("─".repeat(AGENT_COLS.reduce((n, [, w]) => n + w + 1, -1)));
    for (const a of rows)
      lines.push(
        tableRow([
          a.pod,
          a.name,
          a.runtime,
          a.context == null ? "—" : `${a.context}%`,
          a.tokens ?? "—",
          a.status,
          "run ▸ · term",
        ]),
      );
    lines.push("");
    lines.push(`${rows.length} of ${all.length} agents shown`);
    return lines;
  }
  if (state.section === "specs") {
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "spec") {
      const spec = findSpec(snap, leaf.name);
      if (!spec) return [`spec "${leaf.name}" not in the current snapshot`];
      if (spec.agentRefs) {
        lines.push(`rig spec ${spec.name}   tabs: topology [ CONFIGURATION ] yaml`);
        lines.push("  members:");
        for (const ref of spec.agentRefs) lines.push(`    ▪ ${ref}  (open: spec ${ref})`);
      } else {
        lines.push(`agent spec ${spec.name}`);
        lines.push(`  runtime ${spec.runtime ?? "—"}`);
        lines.push(`  used by rigs: ${spec.usedByRigs?.join(", ") ?? "—"}`);
        const seats = agentsRunningSpec(snap, spec.name);
        lines.push(`  seats now: ${seats.join(", ") || "(none)"}  (open: running ${spec.name})`);
      }
      return lines;
    }
    lines.push("SPEC LIBRARY");
    for (const kind of ["rig", "agent", "workflow"] as const) {
      const shown = snap.specs.filter((s) => s.kind === kind).filter((s) => !state.filter || s.name.includes(state.filter));
      if (shown.length === 0 && !snap.specs.some((s) => s.kind === kind)) continue;
      lines.push(`  ${kind.toUpperCase()} (${shown.length})`);
      for (const s of shown) lines.push(`    ▪ ${s.name}`);
    }
    if (snap.specs.length === 0) lines.push("  (library read pending — honest-empty)");
    return lines;
  }
  if (state.section === "needs") {
    lines.push("NEEDS-YOU");
    for (const item of snap.needs) lines.push(`  ⚑ ${item.kind}  ${item.target}  — ${item.detail}  (open ▸)`);
    if (snap.needs.length === 0) lines.push("  (no grounded exception items right now)");
    if (snap.hostsDown.length > 0) {
      // composed BESIDE the items (a separate shipped read), never into the item shape
      lines.push("");
      lines.push("  hosts down:");
      for (const h of snap.hostsDown) lines.push(`  ⛔ ${h.hostId} — ${h.status}${h.error ? ` (${h.error})` : ""}`);
    }
    lines.push("");
    if (!snap.humanQueueProbed) lines.push("  human-queue: not yet known (read pending)");
    else if (snap.humanQueue.length === 0)
      lines.push("  human-queue: no items (proven empty — surfacing adoption pending)");
    else for (const item of snap.humanQueue) lines.push(`  ☐ ${item.kind}  ${item.target}  — ${item.detail}  (open ▸)`);
    return lines;
  }
  return [`(${state.section})`];
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
  const bodyRows = Math.max(explorer.length, content.length);
  const explorerRows: Screen["explorerRows"] = [];
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1; // 1-based terminal row this line will occupy
    const row = explorer[i];
    const marker = i === state.selection && row ? "›" : " ";
    const left = pad(row ? `${marker}${row.label}` : "", EXPL_W);
    const right = content[i] ?? "";
    lines.push(`${left}│ ${right}`);
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action });
      explorerRows.push({ ...row, y });
    }
  }

  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} read(s) failed: ${snap.readErrors[0]}` : "";
  lines.push("─".repeat(cols));
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${readWarn}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  return { lines: lines.slice(0, rows), hitMap, explorerRows };
}
