// Slice-17 mini-req 1 — the Direction-B file-tree navigator RE-SKIN.
//
// A PURE presentation transform over the ONE row model: computeExplorerRows
// stays the single source of rows/keys/actions (PIN-1 — the reducer's
// 'activate' and the renderer's hit-map keep resolving against it); this
// module only derives each row's DISPLAY label:
//   · continuous branch guides │ ├─ └─ from the row's key depth,
//   · icons: host ⊕ · rig ▚ · pod (dim name + genuine ▾/▸) · agent status ●,
//   · meta right-aligned (agent ctx% — honest `—` when null; pod agent count),
//   · collapse glyphs ONLY where collapse genuinely exists today (pods, spec
//     folders, section headers) — hosts/rigs carried a decorative ▾ that
//     afforded nothing; it is dropped, not re-skinned (no false affordances).
// "Hover" is the existing selection-focus highlight — RENDER-ONLY, no motion
// protocol, no second write-path to selection (arch ruling 1).
import type { AgentRow, ExplorerRow, FleetSnapshot } from "./types.js";
import type { MarkSeg } from "./topology/runtime-marks.js";
import { rowStatusGlyph } from "./topology/glyphs.js";

interface KeyParts {
  kind: string;
  parts: string[];
}

function parseKey(key: string | undefined): KeyParts | null {
  if (!key) return null;
  const at = key.indexOf(":");
  if (at < 0) return null;
  return { kind: key.slice(0, at), parts: key.slice(at + 1).split("/") };
}

function keyDepth(row: ExplorerRow): number {
  const parsed = parseKey(row.key);
  if (!parsed) return -1; // keyless rows (filter, needs items) keep their label
  switch (parsed.kind) {
    case "section":
      return 0;
    case "host":
    case "specs-kind":
      return 1;
    case "rig":
    case "folder":
      return 2;
    case "pod":
      return 3;
    case "spec":
      // The row model's spec keys carry no parent relation (guard finding 2);
      // the folder membership IS encoded in the shipped label indent — a
      // foldered spec indents 6 spaces, a root spec 4 (state.ts) — so the
      // child renders one level BELOW its folder, never as a sibling.
      return /^ {6}/.test(row.label) ? 3 : 2;
    case "agent":
      return 4;
    default:
      return -1;
  }
}

/** the label with its legacy indent + list glyph stripped; pod/folder rows
 * keep their GENUINE ▾/▸ (they really collapse), hosts/rigs lose theirs */
function contentOf(row: ExplorerRow, parsed: KeyParts): string {
  const stripped = row.label.replace(/^\s+/, "");
  if (parsed.kind === "host") return `⊕ ${stripped.replace(/^▾ /, "")}`;
  if (parsed.kind === "rig") return `▦ ${stripped.replace(/^▾ /, "")}`; // round-3 rig glyph
  if (parsed.kind === "pod") return stripped.replace(/ \(\d+\)$/, ""); // count moves to meta
  if (parsed.kind === "agent") {
    // POD-RELATIVE display (guard-ruled; the nav-flow mockup's convention —
    // "driver" under pod dev50): strip ONLY a confirmed `${pod}.` prefix so
    // same-pod siblings stay visibly distinct at the fixed pane width; any
    // non-prefixed served name displays unchanged (honest fallback). The FULL
    // served identity always lives in the row key/action/selection/detail.
    const pod = parsed.parts[2];
    const name = parsed.parts.slice(3).join("/");
    const display = pod && name.startsWith(`${pod}.`) ? name.slice(pod.length + 1) : name;
    return stripped.replace(name, display);
  }
  return stripped;
}

export interface NavigatorMeta {
  /** column (within the DISPLAY label) where this run begins */
  start: number;
  /** token segments — a run's own colors (status role; formerly the mark's
   * bg channel) survive the paint layer through this channel (guard finding 2;
   * round-4: rows may carry SEVERAL runs — status badge + right meta) */
  segs: MarkSeg[];
}

function agentOf(parsed: KeyParts, snap: FleetSnapshot): AgentRow | null {
  const [host, rig, pod, ...name] = parsed.parts;
  return snap.hosts
    .find((h) => h.name === host)?.rigs.find((r) => r.name === rig)
    ?.pods.find((p) => p.name === pod)?.agents.find((a) => a.name === name.join("/")) ?? null;
}

function metaOf(row: ExplorerRow, snap: FleetSnapshot): { text: string; segs: MarkSeg[] } | null {
  const parsed = parseKey(row.key);
  if (!parsed) return null;
  if (parsed.kind === "agent") {
    const agent = agentOf(parsed, snap);
    if (!agent) return null;
    // ROUND-3 LOCKED: runtime marks are OFF explorer rows (detail + topology
    // only; stacked rows too busy) — the meta is bare ctx%, honest — when
    // unknown; spelled runtime stays dead; name-first-untruncated holds.
    const value = agent.context == null ? "—" : `${agent.context}%`;
    return { text: value, segs: [{ text: value, token: "dim" }] };
  }
  if (parsed.kind === "pod") {
    const [host, rig, pod] = parsed.parts;
    const found = snap.hosts.find((h) => h.name === host)?.rigs.find((r) => r.name === rig)?.pods.find((p) => p.name === pod);
    return found ? { text: String(found.agents.length), segs: [{ text: String(found.agents.length), token: "dim" }] } : null;
  }
  return null;
}

/**
 * Display rows for the explorer pane — labels plus the seg-run channel
 * (same order/length as `rows`; each row carries 0..n paint runs).
 */
export function navigatorDisplay(
  rows: ExplorerRow[],
  snap: FleetSnapshot,
  width: number,
): { labels: string[]; metas: Array<NavigatorMeta[] | null> } {
  const metas: Array<NavigatorMeta[] | null> = [];
  const labels = navigatorLabelsInner(rows, snap, width, metas);
  return { labels, metas };
}

/** compat view (tests/callers that only need labels) */
export function navigatorLabels(rows: ExplorerRow[], snap: FleetSnapshot, width: number): string[] {
  return navigatorDisplay(rows, snap, width).labels;
}

function navigatorLabelsInner(rows: ExplorerRow[], snap: FleetSnapshot, width: number, metasOut: Array<NavigatorMeta[] | null>): string[] {
  const depths = rows.map((row) => keyDepth(row));
  const isLast = rows.map((_, i) => {
    const depth = depths[i]!;
    if (depth <= 0) return true;
    for (let j = i + 1; j < rows.length; j++) {
      const other = depths[j]!;
      if (other < 0) continue;
      if (other < depth) return true;
      if (other === depth) return false;
    }
    return true;
  });

  // The continuation rail is the mockup's literal │ (guard finding 4, locked
  // glyph). The pane border is ALSO │ but lives at a FIXED column (EXPL_W) —
  // the paint layer and floors locate it by that boundary, never by scanning
  // for the first │ (which a rail would shadow).
  const railOpen: boolean[] = []; // per depth level: does a later sibling exist?
  return rows.map((row, i) => {
    const depth = depths[i]!;
    if (depth < 0) { metasOut.push(null); return row.label; } // keyless rows untouched
    if (depth === 0) { metasOut.push(null); return row.label; } // section headers keep their ▾/▸ identity
    railOpen[depth] = !isLast[i]!;
    const guides = Array.from({ length: depth - 1 }, (_, level) => (railOpen[level + 1] ? "│ " : "  ")).join("");
    const branch = isLast[i] ? "└─ " : "├─ ";
    const parsed = parseKey(row.key)!;
    const content = contentOf(row, parsed);
    const meta = metaOf(row, snap);
    const prefix = ` ${guides}${branch}`;
    // S19 round-4 (guard finding 4): agent rows carry a STATUS BADGE run so
    // the served-truth glyph paints its activity ROLE (color is for status —
    // the one colored thing on the row; non-status icons stay monochrome)
    const runs: NavigatorMeta[] = [];
    if (parsed.kind === "agent") {
      const agent = agentOf(parsed, snap);
      if (agent) {
        const st = rowStatusGlyph(agent);
        runs.push({ start: prefix.length, segs: [{ text: st.glyph, token: st.token }] });
      }
    }
    if (!meta) { metasOut.push(runs.length ? runs : null); return `${prefix}${content}`; }
    // S19 re-sealed width policy (guard NOT-CLEAR finding 1): the NAME renders
    // FIRST and UNTRUNCATED — when the full name leaves no room, the META
    // yields entirely (never an ellipsised identity).
    const room = width - prefix.length - content.length - 1;
    if (room < meta.text.length) { metasOut.push(runs.length ? runs : null); return `${prefix}${content}`; }
    const gap = Math.max(width - prefix.length - content.length - meta.text.length, 1);
    runs.push({ start: prefix.length + content.length + gap, segs: meta.segs });
    metasOut.push(runs);
    return `${prefix}${content}${" ".repeat(gap)}${meta.text}`;
  });
}
