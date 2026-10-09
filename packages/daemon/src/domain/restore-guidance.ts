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
  DEFAULT_CLAUDE_MANAGED_BLOCK_FILE,
  mergeManagedBlock,
  type ManagedBlockMergeFsOps,
} from "./managed-blocks.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import type { NodeStartupSnapshot } from "./types.js";

const LEGACY_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;

/** The per-seat role block is delivered through send_text, never merged into a shared file
 *  (ADR-0006); the adapters skip it, and so does this. */
const NEVER_MERGED = new Set(["rig-role"]);

export interface GuidanceItem {
  blockId: string;
  sourcePath: string;
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
  for (const saved of startupCtx.resolvedStartupFiles) {
    if (!saved.appliesOn.includes("restore")) continue;
    const f = reanchorBuiltinStartupFile(saved, undefined, undefined, exists);
    const hint = f.deliveryHint === "auto" ? resolveConcreteHint(f.path, "") : f.deliveryHint;
    if (hint !== "guidance_merge") continue;
    items.set(f.path, { blockId: f.path, sourcePath: f.absolutePath });
  }
  for (const id of NEVER_MERGED) items.delete(id);
  return { targetPath: nodePath.join(cwd, fileName), items: [...items.values()] };
}

function hasBlock(content: string, blockId: string): boolean {
  return content.includes(MANAGED_BLOCK_START(blockId)) || content.includes(LEGACY_BLOCK_START(blockId));
}

/** The block ids the seat's guidance file lacks right now. */
export function missingGuidanceBlocks(guidance: SeatGuidance, fs: Pick<ManagedBlockMergeFsOps, "exists" | "readFile">): string[] {
  const content = fs.exists(guidance.targetPath) ? fs.readFile(guidance.targetPath) : "";
  return guidance.items.filter((item) => !hasBlock(content, item.blockId)).map((item) => item.blockId);
}

export interface GuidanceRepair {
  /** Blocks put back from their saved source. */
  restored: string[];
  /** Blocks still missing, each with the reason. */
  gaps: string[];
}

/** Put back only the missing managed guidance blocks. Existing blocks and any other text in the
 *  file are left exactly as they are. Never throws: a failure becomes a reported gap. */
export function restoreMissingGuidance(guidance: SeatGuidance, fs: ManagedBlockMergeFsOps): GuidanceRepair {
  const repair: GuidanceRepair = { restored: [], gaps: [] };
  let missing: string[];
  try {
    missing = missingGuidanceBlocks(guidance, fs);
  } catch (err) {
    repair.gaps.push(`could not read ${guidance.targetPath}: ${(err as Error).message}`);
    return repair;
  }
  for (const item of guidance.items.filter((i) => missing.includes(i.blockId))) {
    try {
      if (!fs.exists(item.sourcePath)) {
        repair.gaps.push(`${item.blockId}: its source ${item.sourcePath} no longer exists`);
        continue;
      }
      mergeManagedBlock(fs, guidance.targetPath, item.blockId, fs.readFile(item.sourcePath));
      repair.restored.push(item.blockId);
    } catch (err) {
      repair.gaps.push(`${item.blockId}: ${(err as Error).message}`);
    }
  }
  return repair;
}
