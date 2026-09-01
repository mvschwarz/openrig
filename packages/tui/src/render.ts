// Hand-rolled ANSI renderer (Phase-0 substrate decision). Pure function:
// (state, snapshot) → {lines, hitMap, explorerRows}. BOTH panes emit hit
// targets — explorer rows AND content-pane surfaces (table rows, view tabs,
// agent-refs, Needs-You items) — so a mouse click anywhere resolves to the
// SAME semantic actions commands produce (PIN 1). Isolated seam: a substrate
// swap touches only this module (spike verdict revisit trigger).
import { computeExplorerRows, findAgent, findSpec, findAgentBySession, agentsRunningSpec, agentsRunningSpecTargets, specDetailArrowsScroll } from "./state.js";
import { filterPalette } from "./commands/palette.js";
import { scopesContentLines } from "./scopes/scopes-model.js";
import { executionContentLines } from "./execution/execution-model.js";
import { COMMAND_REGISTRY } from "./commands/registry.js";
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
import type { ColorMode, Token } from "./theme.js";
import { detailPage, fieldLine, sectionRule, listItem, alignedRow, LABEL_W } from "./detail.js";
import type { Action, FleetSnapshot, LoadState, NeedsItem, RowFlash, Screen, ViewState } from "./types.js";

const EXPL_W = 30;

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
type AgentColumnKey = "rig" | "pod" | "agent" | "runtime" | "context" | "tokens" | "status" | "actions";
type AgentColumn = [key: AgentColumnKey, name: string, width: number, align: Align];

const FULL_AGENT_COLS: AgentColumn[] = [
  ["rig", "RIG", 18, "left"],
  ["pod", "POD", 8, "left"],
  ["agent", "AGENT", 16, "left"],
  ["runtime", "RUNTIME", 13, "left"],
  ["context", "CTX%", 4, "right"],
  ["tokens", "TOKENS", 7, "right"],
  ["status", "STATUS", 17, "left"],
  ["actions", "ACTIONS", 14, "left"],
];

function columnsWidth(columns: AgentColumn[]): number {
  return columns.reduce((total, [, , width]) => total + width + 1, -1);
}

function agentColumns(contentWidth: number): AgentColumn[] {
  if (columnsWidth(FULL_AGENT_COLS) <= contentWidth) return FULL_AGENT_COLS;
  // At the 120-column fallback the content pane is 88 cells. Preserve the
  // operable identity/status/action path; telemetry cells yield first.
  const compactRest: AgentColumn[] = [
    ["pod", "POD", 8, "left"],
    ["agent", "AGENT", 16, "left"],
    ["runtime", "RUNTIME", 13, "left"],
    ["status", "STATUS", 17, "left"],
    ["actions", "ACTIONS", 14, "left"],
  ];
  const rigWidth = Math.max(6, Math.min(18, contentWidth - columnsWidth(compactRest) - 1));
  return [["rig", "RIG", rigWidth, "left"], ...compactRest];
}

function tableRow(columns: AgentColumn[], cells: Record<AgentColumnKey, string | number | null>): string {
  return columns.map(([key, , width, align]) => align === "right" ? padLeft(cells[key], width) : pad(cells[key], width)).join(" ");
}

function tabsLine(state: ViewState, suffix: string): ContentLine[] {
  // slice-17: three tabs, each its own click zone (the first zone starts at
  // content col 0, preserving the focus-marker floor); `tab graph` = the
  // topology graph view (frame-01 hatchet mainline)
  const labels: Array<[Extract<ViewState["viewTab"], "table" | "overview" | "graph">, string]> = [
    ["table", state.viewTab === "table" ? "[ TABLE ]" : "  TABLE  "],
    ["overview", state.viewTab === "overview" ? "[ OVERVIEW ]" : "  OVERVIEW  "],
    ["graph", state.viewTab === "graph" ? "[ GRAPH ]" : "  GRAPH  "],
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

function contentLines(state: ViewState, snap: FleetSnapshot, contentWidth: number, motion: MotionCtx): ContentLine[] {
  const contentWidthForGraph = contentWidth;
  void contentWidthForGraph;
  const lines: ContentLine[] = [];
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
      const { agent, rig, pod } = found;
      const specInLibrary = !!agent.spec && !!findSpec(snap, agent.spec);
      // a4c9548a — S19 FOLLOW-ON FOUNDER RULING (binding, bounds the S19 marks
      // ruling): where there is ROOM, WRITE THE NAME — an icon NEVER replaces text
      // as the value. The detail page has room, so the runtime NAME is the VALUE
      // (honest placeholder when unserved); the mark's OWN token segments still ride
      // the seg channel (ROUND-4: colors/background survive stylization) but only
      // ACCOMPANY the name decoratively, never substitute. Topology cards remain
      // mark-only by space (layout.ts/hatchet.ts) — the ruling is bounded, not reversed.
      // LEG-7 LOW 2 (dead-arm cleanup, wave qitem 79159e6f): the daemon coerces a null runtime to the
      // string "unknown" BEFORE the wire (the icon-fix QA at 5a70e200 proved the old "— (not served)"
      // arm unreachable), so the defensive fallback matches that coercion — honest, never a misleading
      // placeholder. (The cwd field below keeps its own "— (not served)" — a legitimately-servable value.)
      const rtName = agent.runtime ?? "unknown";
      const rtSegs = [
        { text: "  " },
        { text: "runtime:", token: "dim" as const },
        { text: " ".repeat(LABEL_W - "runtime:".length + 1) },
        { text: rtName },
        { text: "  " },
        ...runtimeMarkSegs(agent.runtime),
      ];
      const runtimeLine: ContentLine = { text: rtSegs.map((g) => g.text).join(""), segs: rtSegs };
      return detailPage({ text: `agent ${agent.name}` }, [
        {
          title: "seat",
          fields: [
            { label: "state", value: agent.status },
            { label: "host", value: found.host.name },
            { label: "rig", value: rig.name },
            { label: "pod", value: pod.name },
          ],
          lines: [
            runtimeLine,
            fieldLine({
              label: "context",
              // ROUND-3 mr7: a quiet determinate bar rides REAL fractions only
              value: agent.context == null
                ? "— (not yet known)"
                : `${agent.context}% used · ${agent.tokens ?? "—"} tokens  ${barCells(agent.context / 100, 10)}`,
            }),
            // S19 MR4 (§D9, founder: "very important"): the FULL absolute
            // working directory, verbatim; honest — when not served
            fieldLine({ label: "cwd", value: agent.cwd ?? "— (not served)" }),
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
    if (!rig || !host) {
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
    const podFilter = leaf?.kind === "pod" ? leaf.name : null;
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })));
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter));
    const suffix = `rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ""}${state.filter ? ` · filter "${state.filter}"` : ""}`;
    lines.push(...tabsLine(state, suffix));
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
    const agentCols = agentColumns(contentWidth);
    lines.push({
      text: tableRow(agentCols, {
        rig: "RIG", pod: "POD", agent: "AGENT", runtime: "RUNTIME",
        context: "CTX%", tokens: "TOKENS", status: "STATUS", actions: "ACTIONS",
      }),
    });
    lines.push({ text: "─".repeat(columnsWidth(agentCols)) });
    const actionsIndex = agentCols.findIndex(([key]) => key === "actions");
    const actionsColStart = agentCols.slice(0, actionsIndex).reduce((n, [, , width]) => n + width + 1, 0);
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
        text: tableRow(agentCols, {
          rig: rig.name,
          pod: a.pod,
          agent: a.name,
          runtime: a.runtime,
          context: a.context == null ? "—" : `${a.context}%`,
          tokens: a.tokens ?? "—",
          status: a.status,
          actions: actionsCell,
        }),
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
    if (snap.specs.length === 0) {
      // round-5 (guard): spin only while the owner is loading; settled empty
      // is PROVEN empty and a settled failure is named — neither spins
      if (motion.loading) {
        if (!motion.reduced) motion.used = true;
        lines.push({ text: `  ${motion.frame} library read pending — honest-empty` });
      } else if (snap.readErrors.some((e) => e.startsWith("specs-library"))) {
        lines.push({ text: "  ✕ library read failed — named in the status line" });
      } else {
        lines.push({ text: "  (library empty — proven, no specs served)" });
      }
    }
    return lines;
  }
  if (state.section === "needs") {
    lines.push({ text: "NEEDS-YOU" });
    for (const item of snap.needs) {
      // open/navigate is the ONLY in-TUI action (B3): the click target joins
      // the item's session back to topology; unresolvable targets never
      // advertise a control that can only fail.
      lines.push(needsLine(item.source === "agent" ? "  ☐ " : "  ⚑ ", item, snap));
    }
    if (snap.needs.length === 0 && snap.humanQueueProbed) lines.push({ text: "  (no fleet attention items right now)" });
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
    if (!snap.humanQueueProbed) {
      if (motion.loading) {
        // region discipline (max ONE persistent animation): while a derived ⚑
        // item pulses on this page, the pending spinner degrades to the honest
        // static dot instead of animating beside it
        const pulseVisible = snap.needs.some((item) => item.source === "derived") && !motion.reduced;
        const spin = pulseVisible ? "·" : motion.frame;
        if (!pulseVisible && !motion.reduced) motion.used = true;
        lines.push({ text: `  ${spin} human-queue: not yet known (read pending)` });
      } else {
        // round-5 (guard): settled-unprobed is a static truth (hosts down or
        // registry unavailable) — "(read pending)" would be a false claim
        lines.push({ text: "  human-queue: not yet known (hosts unreachable or registry unavailable)" });
      }
    } else if (!snap.needs.some((item) => item.source === "agent"))
      lines.push({ text: "  human-queue: no items (proven empty — surfacing adoption pending)" });
    return lines;
  }
  if (state.section === "scopes") {
    // SCOPES (d64d2f5c): the opened slice rides scopesSelected; store-direct detail.
    const sel = state.scopesSelected;
    const missionName = sel?.mission ?? null;
    const detail = sel
      ? (snap.scopes ?? []).find((m) => m.mission === sel.mission)?.slices.find((sl) => sl.dirName === sel.slice) ?? null
      : null;
    return scopesContentLines(detail, missionName, {
      collapseReqs: state.scopesCollapseReqs,
      narrative: state.scopesNarrative,
      width: contentWidth,
    });
  }
  if (state.section === "execution") {
    return executionContentLines(snap.execution, snap.scopes, snap.readErrors, state.executionSource);
  }
  return [{ text: `(${state.section})` }];
}

export interface RenderOptions {
  /** I5 — the live command context (from the C3 detector); default "standard". */
  commandContext?: string;
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

function paneRule(cols: number, joint: "┬" | "┴", leftTitle?: string, rightTitle?: string): string {
  const left = leftTitle ? `─ ${leftTitle} ` : "";
  const right = rightTitle ? `─ ${rightTitle} ` : "";
  const leftPart = (left + "─".repeat(EXPL_W)).slice(0, EXPL_W);
  const rightPart = (right + "─".repeat(cols)).slice(0, Math.max(cols - EXPL_W - 1, 0));
  return `${leftPart}${joint}${rightPart}`;
}

function keybindHints(state: ViewState): string {
  // Affordance surfaces on REAL scrollability (contentMaxOffset), never gated
  // behind already-being-content-focused — that gate was the catch-22 (the
  // hint hid exactly where it was needed). When ↑↓ themselves scroll (a
  // scrollable spec detail), the nav label says so; otherwise ↑↓ move and the
  // page keys carry the scroll.
  const arrowsScroll = specDetailArrowsScroll(state);
  const nav = arrowsScroll ? "↑↓ scroll" : "↑↓ move";
  const pageScroll = state.contentMaxOffset > 0 && !arrowsScroll ? "⇞⇟ scroll · " : "";
  return `${nav} · ←→ pane · ⏎ open · ${pageScroll}: command · / filter · f footer · q quit`;
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

function renderPulseScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions, inputLine: string): Screen {
  const { cols = 120, rows = 32, nowMs = 0 } = options;
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
  const frame = spinnerFrame(Math.floor(nowMs / 120), options.colorMode ?? "truecolor", reduced);
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

  lines.push(pad(`cmd ▸ ${inputLine}▊`, cols));
  // REGISTRY I3 — the palette overlay: fuzzy rows over the ONE registry; unavailable
  // entries render DIMMED-WITH-REASON, never hidden (PM pin); bounded height.
  if (state.palette) {
    const rows = filterPalette(state.palette.query, COMMAND_REGISTRY, options.commandContext ?? "standard");
    const sel = Math.min(state.palette.selection, Math.max(0, rows.length - 1));
    lines.push(pad(`? ${state.palette.query}▊  (${rows.length} commands · ↑↓ · ⏎ run · esc close)`, cols));
    for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
      const r = rows[i]!;
      const mark = i === sel ? "▸" : " ";
      const label = `${r.entry.name}${r.entry.args ? " " + r.entry.args : ""}`;
      const alias = r.entry.aliases.length ? ` (${r.entry.aliases.join(",")})` : "";
      const tail = r.available ? r.entry.description : `${r.entry.description} — unavailable: ${r.reason}`;
      lines.push(pad(`${mark} ${label}${alias}  ${tail}`, cols));
    }
  }
  const explorerTitle = state.focusedPane === "explorer" ? "[ EXPLORER ]" : "EXPLORER";
  const contentTitle = state.focusedPane === "content" ? "[ PULSE ]" : "PULSE";
  lines.push(paneRule(cols, "┬", explorerTitle, contentTitle));

  const contentWidth = Math.max(cols - EXPL_W - 2, 0);
  const model = buildPulseModel(snap, nowMs);
  const chromeRows = 3; // bottom rule + hint bar + status line
  const bodyRows = Math.max(rows - 2 - chromeRows, 1);

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
  const { labels: explorerDisplay, metas: explorerMetas } = navigatorDisplay(explorer, snap, EXPL_W - 1);
  const explorerStart = Math.min(Math.max(state.selection - bodyRows + 1, 0), Math.max(explorer.length - bodyRows, 0));

  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1;
    // EXPLORER half (identical to the normal split — real chrome, the action path)
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    const flashed = row?.key != null && ackFlashes.some((f) => f.key === row.key);
    if (flashed) flashAck = true;
    const marker = explorerIndex === state.selection && row ? (flashed ? "»" : "›") : flashed ? "≈" : " ";
    const left = pad(row ? `${marker}${explorerDisplay[explorerIndex] ?? row.label}` : "", EXPL_W);
    // CONTENT half = the pulse view, truncated to the content width. Selection is
    // the per-cell bg on the segs (mock affordance), so the content marker slot
    // stays blank — no "›" chevron (the native affordance the mock overrides).
    const citem = visiblePulse[i];
    const contentText = (citem?.text ?? "").slice(0, contentWidth);
    lines.push(pad(`${left}│ ${contentText}`, cols));
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action });
      explorerRows.push({ ...row, y });
      const em = explorerMetas[explorerIndex];
      if (em && em.length) explorerMeta[y] = em.map((run) => ({ start: 1 + run.start, segs: run.segs }));
      if (row.key && liveFlashes.some((f) => f.key === row.key)) flashRows.push(y);
    }
    if (citem?.segs) segRows[y] = truncateSegs(citem.segs, contentWidth);
  }

  // Lane cells → content targets, x mapped into the content column (origin =
  // EXPL_W + 3, matching the normal content zone geometry), clamped to `cols`.
  for (const t of visibleTargets) {
    const x1 = EXPL_W + 2 + t.x1;
    if (x1 > cols) continue;
    const target = { y: t.lineIndex - contentStart + 3, x1, x2: Math.min(EXPL_W + 2 + t.x2, cols), action: t.action };
    contentTargets.push(target);
    hitMap.push(target);
  }

  lines.push(paneRule(cols, "┴"));
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
      `[${state.instanceId}] ${state.section}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}${loadTag}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  const anyFlash = model.lanes.some((l) => l.rows.some((r) => r.flashed));
  return {
    lines: lines.slice(0, rows),
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
type PaneContentLine = { text: string; segs?: Array<{ text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }> };

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
      out.push(first ? { text: chunk, segs: item.segs } : { text: indent + chunk });
      first = false;
    }
  }
  return out;
}

function crashCartShell(
  content: PaneContentLine[],
  led: ReturnType<typeof buildLedgerExplorer>,
  contentTitle: string,
  cols: number,
  rows: number,
  inputLine: string,
  opts?: { wrap?: boolean; scroll?: number },
): Screen {
  const lines: string[] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  lines.push(pad(`cmd ▸ ${inputLine}▊`, cols));
  lines.push(paneRule(cols, "┬", "EXPLORER", contentTitle));

  // The ledger-fed explorer column: the honest marker, then one row per rig (name + seat count).
  const leftRows: string[] = [led.note, "", ...led.rows.map((r) => `${r.label} (${r.seatCount})`)];
  const contentWidth = Math.max(cols - EXPL_W - 2, 0);
  if (opts?.wrap) content = wrapContentLines(content, contentWidth);
  const bodyRows = Math.max(rows - 2 - 3, 1); // minus cmd bar + top rule + (bottom rule, hints, status)
  // HIGH-2 — when content exceeds the viewport, it is VERTICALLY SCROLLABLE: contentMaxOffset is the
  // furthest row the operator can scroll to, and the rendered window starts at the clamped scroll offset.
  // A list that fits (offset 0, maxOffset 0) is unchanged. Only the content pane scrolls; the explorer stays.
  const contentMaxOffset = Math.max(0, content.length - bodyRows);
  const scroll = Math.max(0, Math.min(contentMaxOffset, opts?.scroll ?? 0));
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1;
    const left = pad(leftRows[i] ?? "", EXPL_W);
    const citem = content[scroll + i];
    const contentText = (citem?.text ?? "").slice(0, contentWidth);
    lines.push(pad(`${left}│ ${contentText}`, cols));
    if (citem?.segs) segRows[y] = truncateSegs(citem.segs, contentWidth);
  }
  lines.push(paneRule(cols, "┴"));
  lines.push(pad("", cols));
  const scrollHint = contentMaxOffset > 0 ? ` · ↑↓ scroll (${scroll}/${contentMaxOffset})` : "";
  lines.push(pad(`[crash-cart] daemon down · explorer ${led.note}${scrollHint}`, cols));
  while (lines.length < rows) lines.push("");
  return {
    lines: lines.slice(0, rows),
    hitMap: [],
    contentTargets: [],
    contentMaxOffset,
    explorerRows: [],
    segRows,
  };
}

export function renderScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  const { cols = 120, rows = 32, nowMs = 0 } = options;
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
  if (options.daemonState === "down" && options.crashCart) {
    const led = buildLedgerExplorer(options.crashCart.foundOnHost);
    // B1 ROUND 10 — when a confirm is armed, render it at the TOP of the cockpit (where the operator
    // looks) so the first ⏎ is visibly acknowledged; wrap so the sentence is not clipped at the pane edge.
    const content = options.confirm
      ? [...renderConfirmBanner(options.confirm), ...renderCrashCartView(options.crashCart)]
      : renderCrashCartView(options.crashCart);
    return crashCartShell(content, led, "CRASH-CART", cols, rows, inputLine, options.confirm ? { wrap: true } : undefined);
  }
  if (options.daemonState === "unverified" && options.daemonEvidence) {
    const led = buildLedgerExplorer([]); // no rigs listed when we cannot verify — honest empty ledger
    return crashCartShell(renderUnverifiedView(options.daemonEvidence), led, "DAEMON?", cols, rows, inputLine);
  }
  // PULSE (founder Option-B): a content-pane view inside the NORMAL explorer│
  // content chrome — renderPulseScreen builds its own split (sidebar + lanes)
  // and rides the same segRows paint path, so it returns before the table layout.
  if (state.viewTab === "pulse") return renderPulseScreen(state, snap, options, inputLine);
  // S19 round-5 (guard): one spinner frame per render pass from caller time;
  // `loading` comes from the refresh OWNER (omitted = settled — demo/fixture
  // data IS the answer); reduced-motion kills all of it
  const reduced = reducedMotion();
  const load = options.load ?? { inFlight: false, settled: true };
  const motion: MotionCtx = {
    frame: spinnerFrame(Math.floor(nowMs / 120), options.colorMode ?? "truecolor", reduced),
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
  // gives the cell SGR blink; zero effect on hit geometry).
  lines.push(pad(`cmd ▸ ${inputLine}▊`, cols));
  // REGISTRY I3 — the palette overlay: fuzzy rows over the ONE registry; unavailable
  // entries render DIMMED-WITH-REASON, never hidden (PM pin); bounded height.
  if (state.palette) {
    const rows = filterPalette(state.palette.query, COMMAND_REGISTRY, options.commandContext ?? "standard");
    const sel = Math.min(state.palette.selection, Math.max(0, rows.length - 1));
    lines.push(pad(`? ${state.palette.query}▊  (${rows.length} commands · ↑↓ · ⏎ run · esc close)`, cols));
    for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
      const r = rows[i]!;
      const mark = i === sel ? "▸" : " ";
      const label = `${r.entry.name}${r.entry.args ? " " + r.entry.args : ""}`;
      const alias = r.entry.aliases.length ? ` (${r.entry.aliases.join(",")})` : "";
      const tail = r.available ? r.entry.description : `${r.entry.description} — unavailable: ${r.reason}`;
      lines.push(pad(`${mark} ${label}${alias}  ${tail}`, cols));
    }
  }
  const sectionTitle = { topology: "TOPOLOGY", specs: "SPECS", needs: "NEEDS-YOU" }[state.section] ?? state.section.toUpperCase();
  // active-pane emphasis (k9s-class chrome): the focused pane's title is bracketed
  const explorerTitle = state.focusedPane === "explorer" ? "[ EXPLORER ]" : "EXPLORER";
  const contentTitle = state.focusedPane === "content" ? `[ ${sectionTitle} ]` : sectionTitle;
  lines.push(paneRule(cols, "┬", explorerTitle, contentTitle));

  const explorer = computeExplorerRows(state, snap);
  // Slice-17: the file-tree re-skin is a DISPLAY transform only — rows, keys,
  // actions, and the hit-map all keep resolving against the row model above.
  const { labels: explorerDisplay, metas: explorerMetas } = navigatorDisplay(explorer, snap, EXPL_W - 1);
  const content = contentLines(state, snap, Math.max(cols - EXPL_W - 2, 0), motion);
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
    const marker = explorerIndex === state.selection && row ? (flashed ? "»" : "›") : flashed ? "≈" : " ";
    const left = pad(row ? `${marker}${explorerDisplay[explorerIndex] ?? row.label}` : "", EXPL_W);
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
    lines.push(pad(`${left}│${contentMarker}${contentText}`, cols));
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action });
      explorerRows.push({ ...row, y });
      const em = explorerMetas[explorerIndex];
      if (em && em.length) explorerMeta[y] = em.map((run) => ({ start: 1 + run.start, segs: run.segs })); // +1 = marker slot
      if (row.key && liveFlashes.some((f) => f.key === row.key)) flashRows.push(y);
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
    if (rowSegs) segRows[y] = rowSegs;
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
  return {
    lines: lines.slice(0, rows),
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
