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
import type { ExplorerRow, FleetSnapshot } from "./types.js";

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
function contentOf(row: ExplorerRow, kind: string): string {
  const stripped = row.label.replace(/^\s+/, "");
  if (kind === "host") return `⊕ ${stripped.replace(/^▾ /, "")}`;
  if (kind === "rig") return `▚ ${stripped.replace(/^▾ /, "")}`;
  if (kind === "pod") return stripped.replace(/ \(\d+\)$/, ""); // count moves to meta
  return stripped;
}

function metaOf(row: ExplorerRow, snap: FleetSnapshot): string {
  const parsed = parseKey(row.key);
  if (!parsed) return "";
  if (parsed.kind === "agent") {
    const [host, rig, pod, ...name] = parsed.parts;
    const agent = snap.hosts
      .find((h) => h.name === host)?.rigs.find((r) => r.name === rig)
      ?.pods.find((p) => p.name === pod)?.agents.find((a) => a.name === name.join("/"));
    if (!agent) return "";
    // LOCKED meta form (mini-req 1, guard-ruled): ALWAYS `runtime · ctx%` —
    // never context-only. The runtime's DISPLAY form is its first hyphen
    // token (the literal mockups render "claude" for claude-code seats);
    // honest-unknown ctx renders `runtime · —`, never a fabricated value.
    const runtimeToken = agent.runtime.split("-")[0] || agent.runtime;
    return `${runtimeToken} · ${agent.context == null ? "—" : `${agent.context}%`}`;
  }
  if (parsed.kind === "pod") {
    const [host, rig, pod] = parsed.parts;
    const found = snap.hosts.find((h) => h.name === host)?.rigs.find((r) => r.name === rig)?.pods.find((p) => p.name === pod);
    return found ? String(found.agents.length) : "";
  }
  return "";
}

/**
 * Display labels for the explorer pane — same order, same length as `rows`.
 * Guides derive from key depth with last-sibling awareness so the vertical
 * rails read continuously (the `tree` command look).
 */
export function navigatorLabels(rows: ExplorerRow[], snap: FleetSnapshot, width: number): string[] {
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
    if (depth < 0) return row.label; // keyless rows untouched
    if (depth === 0) return row.label; // section headers keep their ▾/▸ identity
    railOpen[depth] = !isLast[i]!;
    const guides = Array.from({ length: depth - 1 }, (_, level) => (railOpen[level + 1] ? "│ " : "  ")).join("");
    const branch = isLast[i] ? "└─ " : "├─ ";
    const parsed = parseKey(row.key)!;
    let content = contentOf(row, parsed.kind);
    const meta = metaOf(row, snap);
    const prefix = ` ${guides}${branch}`;
    if (!meta) return `${prefix}${content}`;
    // LOCKED width policy (guard-ruled): the complete right-aligned meta is
    // ALWAYS preserved; an over-long display name truncates with … instead
    // of the meta ever dropping its runtime.
    const contentMax = width - prefix.length - meta.length - 1;
    if (content.length > contentMax) content = `${content.slice(0, Math.max(contentMax - 1, 0))}…`;
    const gap = Math.max(width - prefix.length - content.length - meta.length, 1);
    return `${prefix}${content}${" ".repeat(gap)}${meta}`;
  });
}
