// Hand-rolled ANSI renderer (Phase-0 substrate decision). Pure function:
// (state, snapshot) → {lines, hitMap, explorerRows}. BOTH panes emit hit
// targets — explorer rows AND content-pane surfaces (table rows, view tabs,
// agent-refs, Needs-You items) — so a mouse click anywhere resolves to the
// SAME semantic actions commands produce (PIN 1). Isolated seam: a substrate
// swap touches only this module (spike verdict revisit trigger).
import { computeExplorerRows, findAgent, findSpec, findAgentBySession, agentsRunningSpec, agentsRunningSpecTargets } from "./state.js";
import { detailPage, fieldLine, sectionRule, listItem, alignedRow } from "./detail.js";
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

function specTabsLine(state: ViewState, name: string): ContentLine {
  const active = state.viewTab === "topology" || state.viewTab === "yaml" ? state.viewTab : "configuration";
  const labels = ["topology", "configuration", "yaml"] as const;
  const parts = labels.map((tab) => (tab === active ? `[ ${tab.toUpperCase()} ]` : `  ${tab.toUpperCase()}  `));
  const text = `rig spec ${name}   ${parts.join(" ")}`;
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

function contentLines(state: ViewState, snap: FleetSnapshot): ContentLine[] {
  const lines: ContentLine[] = [];
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
      const { agent, rig, pod } = found;
      const specInLibrary = !!agent.spec && !!findSpec(snap, agent.spec);
      return detailPage({ text: `agent ${agent.name}` }, [
        {
          title: "seat",
          fields: [
            { label: "state", value: agent.status },
            { label: "host", value: found.host.name },
            { label: "rig", value: rig.name },
            { label: "pod", value: pod.name },
            { label: "runtime", value: agent.runtime },
            {
              label: "context",
              value: agent.context == null ? "— (not yet known)" : `${agent.context}% used · ${agent.tokens ?? "—"} tokens`,
            },
          ],
        },
        {
          title: "spec",
          fields: [
            specInLibrary
              ? {
                  label: "spec",
                  value: agent.spec,
                  link: { type: "cross", kind: "spec-of", name: agent.name, target: { host: found.host.name, rig: rig.name, pod: pod.name } },
                }
              : { label: "spec", value: agent.spec ? `${agent.spec}  (not in library)` : "—" },
          ],
        },
        {
          title: "actions",
          fields: [
            ...(agent.attach ? [{ label: "attach", value: agent.attach }] : []),
            {
              label: "terminal",
              value: `term ▸ pod ${pod.name}`,
              link: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${pod.name}` },
            },
          ],
        },
      ]);
    }
    const rigName = state.drill.find((d) => d.kind === "rig")?.name ?? snap.hosts[0]?.rigs[0]?.name;
    const hostName = state.drill.find((d) => d.kind === "host")?.name;
    const host = (hostName ? snap.hosts.find((candidate) => candidate.name === hostName) : snap.hosts[0]);
    const rig = host?.rigs.find((candidate) => candidate.name === rigName);
    if (!rig || !host) return [{ text: "no rig in view — waiting on the daemon read (honest-empty, not fabricated)" }];
    const podFilter = leaf?.kind === "pod" ? leaf.name : null;
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })));
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter));
    const suffix = `rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ""}${state.filter ? ` · filter "${state.filter}"` : ""}`;
    lines.push(...tabsLine(state, suffix));
    lines.push({ text: state.filter ? `/ filter agents: ${state.filter}` : "/ filter agents…" });
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
    lines.push({ text: tableRow(AGENT_COLS.map(([name]) => name)) });
    lines.push({ text: "─".repeat(AGENT_COLS.reduce((n, [, w]) => n + w + 1, -1)) });
    const actionsColStart = AGENT_COLS.slice(0, -1).reduce((n, [, w]) => n + w + 1, 0);
    for (const a of rows) {
      // ACTIONS = drive-structure ONLY (BR-9), each mapped to an EXISTING
      // write contract: `run ▸` = the rig-restore write (rendered only where
      // it applies — the seat is not running); `term ▸` = the terminal-open
      // view contract (pod-scoped, the web's granularity). No false affordance.
      const canRun = a.canRun ?? !a.live;
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
        action: { type: "drill", resource: "agent", name: a.name, target: { host: host.name, rig: rig.name, pod: a.pod } },
        zones,
      });
    }
    lines.push({ text: "" });
    lines.push({ text: `${rows.length} of ${all.length} / ${rows.filter((agent) => agent.status === "idle").length} idle` });
    return lines;
  }
  if (state.section === "specs") {
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "spec") {
      const spec = findSpec(snap, leaf.name);
      if (!spec) return [{ text: `spec "${leaf.name}" not in the current snapshot` }];
      if (spec.kind === "rig") {
        lines.push(specTabsLine(state, spec.name));
        if (spec.sourcePath) lines.push(fieldLine({ label: "source", value: `${displayPath(spec.sourcePath, 56)} · ${sourceProvenance(spec)}` }));
        if (state.viewTab === "topology") {
          // ROUND-4 item 1: the established table treatment, not unformatted rows
          const nodes = spec.graph?.nodes ?? [];
          const graphEdges = spec.graph?.edges ?? [];
          const NODE_COLS: Array<[string, number]> = [["NODE", 16], ["LABEL", 24], ["POD", 12], ["RUNTIME", 14]];
          lines.push(fieldLine({ label: "shape", value: `${nodes.length} nodes · ${graphEdges.length} edges` }));
          lines.push({ text: "" });
          if (nodes.length === 0) {
            lines.push({ text: "  (topology projection is empty)" });
            return lines;
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
          return lines;
        }
        if (state.viewTab === "yaml") {
          for (const rawLine of (spec.raw ?? "# raw YAML unavailable").split("\n")) lines.push({ text: `  ${rawLine}` });
          return lines;
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
              title: "where it runs",
              fields: [
                ...((spec.usedByRigs?.length ?? 0) === 0
                  ? [{ label: "used by", value: "—" }]
                  : (spec.usedByRigs ?? []).map((rig) => ({
                      label: "used by",
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
      return lines;
    }
    lines.push({ text: "SPEC LIBRARY" });
    lines.push({ text: state.filter ? `/ filter specs: ${state.filter}` : "/ filter specs…" });
    // mirrors the explorer exactly (same grouping, same expansion state, same
    // filter-overrides-collapse rule) — glance consistency across panes
    const expandedSet = new Set(state.expanded);
    for (const kind of ["rig", "agent", "workflow"] as const) {
      const shown = snap.specs.filter((s) => s.kind === kind).filter((s) => !state.filter || s.name.includes(state.filter));
      if (shown.length === 0 && !snap.specs.some((s) => s.kind === kind)) continue;
      lines.push({ text: `  ${kind.toUpperCase()} (${shown.length})` });
      if (kind !== "agent") {
        for (const s of shown)
          lines.push({ text: `    ▪ ${s.name}`, action: { type: "drill", resource: "spec", name: s.name } });
        continue;
      }
      const groups = new Map<string, typeof shown>();
      for (const s of shown) {
        const namespace = s.namespace ?? "(root)";
        groups.set(namespace, [...(groups.get(namespace) ?? []), s]);
      }
      for (const [namespace, specs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const open = namespace === "(root)" || expandedSet.has(`folder:${namespace}`) || !!state.filter;
        if (namespace !== "(root)")
          lines.push({
            text: `    ${open ? "▾" : "▸"} ${namespace}/ (${specs.length})`,
            action: { type: "toggle-expand", key: `folder:${namespace}` },
          });
        if (!open) continue;
        for (const s of specs)
          lines.push({
            text: `${namespace === "(root)" ? "    " : "      "}▪ ${s.name}`,
            action: { type: "drill", resource: "spec", name: s.name },
          });
      }
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
      for (const h of snap.hostsDown)
        lines.push({ text: `  ✖ ${alignedRow([[h.hostId, 28], [h.status, 26]])} ${h.error ?? ""}`.trimEnd() });
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

function paneRule(cols: number, joint: "┬" | "┴", leftTitle?: string, rightTitle?: string): string {
  const left = leftTitle ? `─ ${leftTitle} ` : "";
  const right = rightTitle ? `─ ${rightTitle} ` : "";
  const leftPart = (left + "─".repeat(EXPL_W)).slice(0, EXPL_W);
  const rightPart = (right + "─".repeat(cols)).slice(0, Math.max(cols - EXPL_W - 1, 0));
  return `${leftPart}${joint}${rightPart}`;
}

function keybindHints(state: ViewState): string {
  const scroll = state.viewTab === "yaml" || state.focusedPane === "content" ? "⇞⇟ scroll · " : "";
  return `↑↓ move · ←→ pane · ⏎ open · ${scroll}: command · / filter · f footer · q quit`;
}

export function renderScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  const { cols = 120, rows = 32 } = options;
  const lines: string[] = [];
  const hitMap: Screen["hitMap"] = [];
  lines.push(pad(`cmd ▸ ${inputLine}`, cols));
  const sectionTitle = { topology: "TOPOLOGY", specs: "SPECS", needs: "NEEDS-YOU" }[state.section] ?? state.section.toUpperCase();
  // active-pane emphasis (k9s-class chrome): the focused pane's title is bracketed
  const explorerTitle = state.focusedPane === "explorer" ? "[ EXPLORER ]" : "EXPLORER";
  const contentTitle = state.focusedPane === "content" ? `[ ${sectionTitle} ]` : sectionTitle;
  lines.push(paneRule(cols, "┬", explorerTitle, contentTitle));

  const explorer = computeExplorerRows(state, snap);
  const content = contentLines(state, snap);
  const footer = state.footerOn ? snap.stream.at(-1) : undefined;
  const chromeRows = footer ? 4 : 3; // bottom rule + hint bar + status line (+ footer)
  const bodyRows = Math.max(rows - 2 - chromeRows, 1);
  const explorerStart = Math.min(
    Math.max(state.selection - bodyRows + 1, 0),
    Math.max(explorer.length - bodyRows, 0),
  );
  const contentRows = content.length > bodyRows ? Math.max(bodyRows - 1, 0) : bodyRows;
  const maxContentOffset = Math.max(content.length - contentRows, 0);
  const contentStart = Math.min(state.contentOffset, maxContentOffset);
  const visibleContent = content.slice(contentStart, contentStart + contentRows);
  if (content.length > bodyRows) {
    const scrollText = `content ↑/↓ · ${contentStart + 1}-${contentStart + visibleContent.length} of ${content.length}`;
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
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1; // 1-based terminal row this line will occupy
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    const marker = explorerIndex === state.selection && row ? "›" : " ";
    const left = pad(row ? `${marker}${row.label}` : "", EXPL_W);
    const item = visibleContent[i];
    const targetIndex = contentTargets.length;
    const zones = item?.zones ?? [];
    const selectedOnLine = state.focusedPane === "content" ? state.contentSelection - targetIndex : -1;
    const selectedZone = selectedOnLine >= 0 && selectedOnLine < zones.length ? zones[selectedOnLine] : undefined;
    const selectedAction = !!item?.action && selectedOnLine === zones.length;
    let contentText = item?.text ?? "";
    let contentMarker = selectedAction ? "›" : " ";
    if (selectedZone) {
      if (selectedZone.start > 0)
        contentText = `${contentText.slice(0, selectedZone.start - 1)}›${contentText.slice(selectedZone.start)}`;
      else contentMarker = "›";
    }
    lines.push(pad(`${left}│${contentMarker}${contentText}`, cols));
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action });
      explorerRows.push({ ...row, y });
    }
    // zones first: hit lookup takes the first match, so a zone wins over the row-wide action
    for (const z of zones) {
      const target = { y, x1: EXPL_W + 3 + z.start, x2: EXPL_W + 2 + z.end, action: z.action };
      hitMap.push(target);
      contentTargets.push(target);
    }
    if (item?.action) {
      const target = { y, x1: EXPL_W + 3, x2: cols, action: item.action };
      hitMap.push(target);
      contentTargets.push(target);
    }
  }

  if (footer) lines.push(pad(`≋ ${footer.tsEmitted.slice(11, 16)} ${footer.sourceSession}: ${footer.body}`, cols));
  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} read(s) failed: ${snap.readErrors[0]}` : "";
  lines.push(paneRule(cols, "┴"));
  lines.push(pad(keybindHints(state), cols));
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  return { lines: lines.slice(0, rows), hitMap, contentTargets, contentMaxOffset: maxContentOffset, explorerRows };
}
