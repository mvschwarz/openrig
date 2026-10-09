// A resumed seat's working guidance (Root's amendment to the OPR.0.5.7.1 D6a zero-projection
// ruling, qitem-20261009081619-d1537b0f).
//
// D6a stopped an exact resume from replaying startup content, after managed CLAUDE.md blocks
// were rewritten during a resume. Ordinary `rig down` still strips OpenRig's managed blocks from
// each seat's guidance file, so an exact resume came back with no role, culture or SOP guidance
// (and the rig reported fully_restored). The amendment is narrow: before the native harness
// starts, put back only the managed guidance blocks that are MISSING, from the saved startup
// selection (guidance projections and guidance_merge startup files). An existing block is never
// refreshed or overwritten; nothing is sent to the conversation; no startup action, skill or
// plugin runs; no profile is resolved again. The blocks are rebuilt from the saved source paths'
// current bytes, not from a byte snapshot of the old file.
//
// Guidance problems never block the exact resume. What can't be put back is reported.

import nodePath from "node:path";
import {
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  DEFAULT_CLAUDE_MANAGED_BLOCK_FILE,
  mergeManagedBlock,
  stripManagedBlocks,
  type ManagedBlockMergeFsOps,
} from "./managed-blocks.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import type { NodeStartupSnapshot } from "./types.js";

const LEGACY_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;
const LEGACY_BLOCK_END = (id: string) => `<!-- END RIGGED MANAGED BLOCK: ${id} -->`;

/** The per-seat role block is delivered through send_text, never merged into a shared file
 *  (ADR-0006); the adapters skip it, and so does this. */
const NEVER_MERGED = new Set(["rig-role"]);

export interface GuidanceItem {
  blockId: string;
  sourcePath: string;
  /** An older "auto" startup file whose source can't be read, so it can't be classified. If its
   *  block isn't in the file, that's reported as a gap; nothing is written for it. */
  unresolved?: boolean;
}

export interface SeatGuidance {
  targetPath: string;
  items: GuidanceItem[];
}

/** The guidance file a seat's managed blocks live in, and the blocks it should hold on restore. */
export function seatGuidance(
  startupCtx: NodeStartupSnapshot | null,
  cwd: string | null | undefined,
  claudeManagedBlockFile: string | null | undefined,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): SeatGuidance | null {
  if (!startupCtx || !cwd) return null;
  const fileName = startupCtx.runtime === "claude-code"
    ? (claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE)
    : startupCtx.runtime === "codex" ? "AGENTS.md" : null;
  if (!fileName) return null;
  const items = new Map<string, GuidanceItem>();
  for (const saved of startupCtx.projectionEntries) {
    if (saved.category !== "guidance" || saved.mergeStrategy !== "managed_block") continue;
    const e = reanchorShippedProjectionEntry(saved, undefined, exists);
    items.set(e.effectiveId, { blockId: e.effectiveId, sourcePath: e.absolutePath });
  }
  // Every guidance startup file the last launch merged, whatever its appliesOn: a fresh-start-only
  // file (onboarding, an agent starter) was merged at that launch and stayed in the file until
  // `rig down` stripped it, so it is part of what the resumed conversation had.
  for (const saved of startupCtx.resolvedStartupFiles) {
    const f = reanchorBuiltinStartupFile(saved, undefined, undefined, exists);
    // An "auto" file is classified from its content, as at launch (a `# SKILL` file is a skill,
    // not guidance). If the source can't be read it can't be classified: it is reported, not dropped.
    let hint: string = f.deliveryHint;
    if (hint === "auto") {
      try {
        hint = resolveConcreteHint(f.path, readFile(f.absolutePath));
      } catch {
        if (f.path.endsWith(".md") && !f.path.endsWith("SKILL.md")) {
          items.set(f.path, { blockId: f.path, sourcePath: f.absolutePath, unresolved: true });
        }
        continue;
      }
    }
    if (hint !== "guidance_merge") continue;
    items.set(f.path, { blockId: f.path, sourcePath: f.absolutePath });
  }
  for (const id of NEVER_MERGED) items.delete(id);
  return { targetPath: nodePath.join(cwd, fileName), items: [...items.values()] };
}

type BlockState = "complete" | "absent" | "incomplete";

/** A block counts only with both its markers (current or legacy form). A lone marker is incomplete:
 *  writing next to it is unsafe, because cleanup strips from a BEGIN to the next END. */
function blockState(content: string, blockId: string): BlockState {
  const current = [content.includes(MANAGED_BLOCK_START(blockId)), content.includes(MANAGED_BLOCK_END(blockId))];
  const legacy = [content.includes(LEGACY_BLOCK_START(blockId)), content.includes(LEGACY_BLOCK_END(blockId))];
  if ((current[0] && current[1]) || (legacy[0] && legacy[1])) return "complete";
  if (current[0] || current[1] || legacy[0] || legacy[1]) return "incomplete";
  return "absent";
}

function blockStates(guidance: SeatGuidance, fs: Pick<ManagedBlockMergeFsOps, "exists" | "readFile">): Map<string, BlockState> {
  const content = fs.exists(guidance.targetPath) ? fs.readFile(guidance.targetPath) : "";
  return new Map(guidance.items.map((item) => [item.blockId, blockState(content, item.blockId)]));
}

/** The block ids the seat's guidance file lacks right now (absent, or only partly there). */
export function missingGuidanceBlocks(guidance: SeatGuidance, fs: Pick<ManagedBlockMergeFsOps, "exists" | "readFile">): string[] {
  return [...blockStates(guidance, fs)].filter(([, state]) => state !== "complete").map(([id]) => id);
}

export interface GuidanceRepair {
  /** Blocks put back from their saved source. */
  restored: string[];
  /** Blocks still missing, each with the reason. */
  gaps: string[];
}

/** Put back only the missing managed guidance blocks. Existing blocks and any other text in the
 *  file are left exactly as they are. Never throws: a failure becomes a reported gap. */
/** Would appending these blocks to `content` be safe for the next `rig down`? Decided by effect,
 *  with cleanup itself: safe only when stripping the new file gives exactly what stripping the
 *  current one gives, so the added blocks strip away cleanly and take nothing else with them. A
 *  stray, truncated or misplaced marker (cleanup strips from any BEGIN to the next END that ends a
 *  line) makes the two differ. No second marker grammar to keep in step with cleanup. */
export function appendIsCleanupSafe(content: string, blocks: Array<{ blockId: string; content: string }>): boolean {
  let candidate = content;
  const memory: ManagedBlockMergeFsOps = {
    exists: () => true,
    readFile: () => candidate,
    writeFile: (_path, next) => { candidate = next; },
  };
  for (const block of blocks) mergeManagedBlock(memory, "(in memory)", block.blockId, block.content);
  return stripManagedBlocks(candidate) === stripManagedBlocks(content);
}

/** Put back only the missing managed guidance blocks. Existing blocks and any other text in the
 *  file are left exactly as they are, and nothing is written unless cleanup would later remove
 *  exactly what was added. Never throws: a failure becomes a reported gap. */
export function restoreMissingGuidance(guidance: SeatGuidance, fs: ManagedBlockMergeFsOps): GuidanceRepair {
  const repair: GuidanceRepair = { restored: [], gaps: [] };
  let states: Map<string, BlockState>;
  let existing: string | null;
  try {
    states = blockStates(guidance, fs);
    existing = fs.exists(guidance.targetPath) ? fs.readFile(guidance.targetPath) : null;
  } catch (err) {
    repair.gaps.push(`could not read ${guidance.targetPath}: ${(err as Error).message}`);
    return repair;
  }
  const toWrite: Array<{ blockId: string; content: string }> = [];
  for (const item of guidance.items) {
    const state = states.get(item.blockId);
    if (state === "complete") continue;
    if (state === "incomplete") {
      repair.gaps.push(`${item.blockId}: ${guidance.targetPath} holds only part of this block (one marker); left as it is`);
      continue;
    }
    if (item.unresolved) {
      repair.gaps.push(`${item.blockId}: its source ${item.sourcePath} can't be read, so this older startup file can't be classified or put back`);
      continue;
    }
    try {
      if (!fs.exists(item.sourcePath)) {
        repair.gaps.push(`${item.blockId}: its source ${item.sourcePath} no longer exists`);
        continue;
      }
      toWrite.push({ blockId: item.blockId, content: fs.readFile(item.sourcePath) });
    } catch (err) {
      repair.gaps.push(`${item.blockId}: ${(err as Error).message}`);
    }
  }
  if (toWrite.length === 0) return repair;
  // A file that doesn't exist yet holds no text to lose. An existing one is written only if the
  // next rig down would remove exactly what is added.
  if (existing !== null && !appendIsCleanupSafe(existing, toWrite)) {
    for (const block of toWrite) {
      repair.gaps.push(`${block.blockId}: not written, because ${guidance.targetPath} has a managed-block marker that the next rig down would strip together with other text, so adding blocks there could cost that text`);
    }
    return repair;
  }
  for (const block of toWrite) {
    try {
      mergeManagedBlock(fs, guidance.targetPath, block.blockId, block.content);
      repair.restored.push(block.blockId);
    } catch (err) {
      repair.gaps.push(`${block.blockId}: ${(err as Error).message}`);
    }
  }
  return repair;
}
