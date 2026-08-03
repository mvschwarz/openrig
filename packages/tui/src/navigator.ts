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

function keyDepth(key: string | undefined): number {
  const parsed = parseKey(key);
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
      return parsed.parts[0]?.includes("/") ? 3 : 2;
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
    // honest-unknown: no served ctx → an explicit —, never a fabricated value
    return agent.context == null ? "—" : `${agent.context}%`;
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
  const depths = rows.map((row) => keyDepth(row.key));
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

  // NB: the continuation rail is ┊ (not │) — the pane BORDER is │ and the
  // shipped floor treats the first │ on a line as pane structure; the rail
  // must never masquerade as the border (same glyph-collision class as the
  // emoji-width lesson). Branch glyphs ├─ └─ are the mockup's exact chars.
  const railOpen: boolean[] = []; // per depth level: does a later sibling exist?
  return rows.map((row, i) => {
    const depth = depths[i]!;
    if (depth < 0) return row.label; // keyless rows untouched
    if (depth === 0) return row.label; // section headers keep their ▾/▸ identity
    railOpen[depth] = !isLast[i]!;
    const guides = Array.from({ length: depth - 1 }, (_, level) => (railOpen[level + 1] ? "┊ " : "  ")).join("");
    const branch = isLast[i] ? "└─ " : "├─ ";
    const parsed = parseKey(row.key)!;
    let content = contentOf(row, parsed.kind);
    const meta = metaOf(row, snap);
    const prefix = ` ${guides}${branch}`;
    if (!meta) return `${prefix}${content}`;
    // meta is glance data — guaranteed; over-long content truncates honestly
    const contentMax = width - prefix.length - meta.length - 1;
    if (content.length > contentMax) content = `${content.slice(0, Math.max(contentMax - 1, 0))}…`;
    const gap = Math.max(width - prefix.length - content.length - meta.length, 1);
    return `${prefix}${content}${" ".repeat(gap)}${meta}`;
  });
}
