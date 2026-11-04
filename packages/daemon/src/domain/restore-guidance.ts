// A resumed seat's working guidance.
//
// An exact resume replays no startup content (the replay containment in restore-orchestrator.ts),
// because managed CLAUDE.md blocks were once rewritten during a resume. Ordinary `rig down` still
// strips OpenRig's managed blocks from each seat's guidance file, so an exact resume came back with
// no role, culture or SOP guidance (and the rig reported fully_restored). The exception is narrow:
// before the native harness starts, put back only the managed guidance blocks that are MISSING,
// from the saved startup selection (guidance projections and guidance_merge startup files). An
// existing block is refreshed only when OpenRig's record shows it holds what OpenRig last wrote
// (#2456); an edited block, or one with no record, is kept and named. No startup action, skill or
// plugin runs; no profile is resolved again. The blocks are rebuilt from the saved source paths'
// current bytes, not from a byte snapshot of the old file.
//
// Guidance problems never block the exact resume. What can't be put back is reported.

import nodePath from "node:path";
import { lstatSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  DEFAULT_CLAUDE_MANAGED_BLOCK_FILE,
  mergeManagedBlock,
  stripManagedBlocks,
  type ManagedBlockMergeFsOps,
  isPerSeatRoleGuidance,
  isPerSeatRoleStartupFile,
} from "./managed-blocks.js";
import { decideManagedBlock, recordManagedBlockWrite, type ManagedBlockRecords } from "./managed-block-records.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import type { NodeStartupSnapshot } from "./types.js";
import { SEAT_SKILLS_BOOTSTRAP_BLOCK_ID } from "./seat-skill-storage.js";
import { guidanceFileIsLink } from "./footprint-choice.js";

const LEGACY_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;
const LEGACY_BLOCK_END = (id: string) => `<!-- END RIGGED MANAGED BLOCK: ${id} -->`;


export interface GuidanceItem {
  blockId: string;
  sourcePath: string;
  /** An older "auto" startup file whose source can't be read, so it can't be classified. If its
   *  block isn't in the file, that's reported as a gap; nothing is written for it. */
  unresolved?: boolean;
  /** A start fails without it: a projected guidance file, or a startup file marked required. */
  required?: boolean;
}

export interface SeatGuidance {
  targetPath: string;
  items: GuidanceItem[];
}

/** The file a seat's runtime merges its managed guidance blocks into, whatever a spec's `target` declares: the file its
 *  launch recorded (`recorded`, a Pi seat's agent folder AGENTS.md, #875), else the rig's Claude file for Claude,
 *  `AGENTS.md` for Codex, Pi and omp, or null for a runtime this doesn't know. Teardown, its live-file protection, exact
 *  resume and node inventory all read the target from here. */
export function seatGuidanceFile(
  runtime: string | null | undefined,
  cwd: string,
  claudeManagedBlockFile: string | null | undefined,
  recorded?: string | null,
): string | null {
  if (recorded) return recorded;
  const fileName = runtime === "claude-code"
    ? (claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE)
    : runtime === "codex" || runtime === "pi" || runtime === "omp" ? "AGENTS.md" : null;
  return fileName ? nodePath.join(cwd, fileName) : null;
}

export type LinkInfo = (path: string) => { link: boolean; nlink: number } | null;

/** An lstat of a path: whether it's a symlink and its hard-link count, or null when it doesn't exist. */
export const lstatLinkInfo: LinkInfo = (path) => {
  try { const st = lstatSync(path); return { link: st.isSymbolicLink(), nlink: st.nlink }; } catch { return null; }
};

/** #875: a seat's own guidance file (a Pi seat's `<seat>/agent/AGENTS.md`) is its alone only while neither the file, its
 *  folder nor that folder's parent is a symlink and the file has one name. Otherwise other sessions (a person's own Pi
 *  home, a shared file) could read what's written there. Returns the linked path, or null. Checked when a launch chooses
 *  the file and again wherever a recorded file is written, since a link can be made after the launch recorded it. */
export function guidanceFileSharedByLink(file: string, linkInfo: LinkInfo): string | null {
  for (const path of [nodePath.dirname(nodePath.dirname(file)), nodePath.dirname(file), file]) {
    const info = linkInfo(path);
    if (info && (info.link || (path === file && info.nlink > 1))) return path;
  }
  return null;
}

/** The guidance file a node's last launch recorded (#875), or null: none recorded, or a database from before the column. */
export function recordedGuidanceFile(db: Pick<Database.Database, "prepare">, nodeId: string | null | undefined): string | null {
  if (!nodeId) return null;
  try {
    const row = db.prepare("SELECT guidance_file FROM node_startup_context WHERE node_id = ?").get(nodeId) as { guidance_file: string | null } | undefined;
    return row?.guidance_file || null;
  } catch { return null; }
}

/** Whether guidance text holds this id's block as it is written: a BEGIN marker followed later by its END, in the
 *  current or legacy form. For reporting an installed file; restore's own `blockState` is unchanged. */
export function hasCompleteGuidanceBlock(content: string, blockId: string): boolean {
  const ordered = (start: string, end: string): boolean => {
    const begin = content.indexOf(start);
    return begin >= 0 && content.indexOf(end, begin + start.length) >= 0;
  };
  return ordered(MANAGED_BLOCK_START(blockId), MANAGED_BLOCK_END(blockId))
    || ordered(LEGACY_BLOCK_START(blockId), LEGACY_BLOCK_END(blockId));
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
  const targetPath = seatGuidanceFile(startupCtx.runtime, cwd, claudeManagedBlockFile, startupCtx.guidanceFile);
  if (!targetPath) return null;
  const items = new Map<string, GuidanceItem>();
  for (const saved of startupCtx.projectionEntries) {
    if (saved.category !== "guidance" || saved.mergeStrategy !== "managed_block") continue;
    const e = reanchorShippedProjectionEntry(saved, undefined, exists);
    items.set(e.effectiveId, { blockId: e.effectiveId, sourcePath: e.absolutePath, required: true });
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
        hint = resolveConcreteHint(f.path, readFile(f.absolutePath), f.orientation);
      } catch {
        if (f.path.endsWith(".md") && !f.path.endsWith("SKILL.md") && !isPerSeatRoleStartupFile(f.path, f.orientation)) {
          items.set(f.path, { blockId: f.path, sourcePath: f.absolutePath, unresolved: true, required: f.required || items.get(f.path)?.required });
        }
        continue;
      }
    }
    if (hint !== "guidance_merge") continue;
    // A projected block with the same id stays required: a start fails at projection before this file is delivered.
    items.set(f.path, { blockId: f.path, sourcePath: f.absolutePath, required: f.required || items.get(f.path)?.required });
  }
  // A seat's own role goes through send_text, never into a shared file (ADR-0006); the adapters skip it too.
  for (const [id, item] of items) if (isPerSeatRoleGuidance(item.blockId, item.sourcePath)) items.delete(id);
  return { targetPath, items: [...items.values()] };
}

/** A `send_text` startup file a fresh start delivers to a seat's new conversation. */
export interface SeatStartupTextFile {
  absolutePath: string;
  required: boolean;
  /** Whether the file is on disk now. */
  present: boolean;
  /** The seat's own role. */
  role: boolean;
}

/** #2456: the `send_text` startup files a fresh start delivers to a seat's new conversation, from its saved startup context:
 *  each file that applies on `fresh_start` and resolves to `send_text`, as at a start, the seat's role first. A handover's
 *  fresh or rebuild successor is a new conversation no start delivered to, so its first turn points to these. */
export function seatStartupTextFiles(
  startupCtx: NodeStartupSnapshot | null,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): SeatStartupTextFile[] {
  if (!startupCtx) return [];
  const files = startupCtx.resolvedStartupFiles.flatMap((saved): SeatStartupTextFile[] => {
    if (!saved.appliesOn.includes("fresh_start")) return [];
    const f = reanchorBuiltinStartupFile(saved, undefined, undefined, exists);
    const present = exists(f.absolutePath);
    let hint: string = f.deliveryHint;
    if (hint === "auto") {
      // Classified from its content, as at a start; one that can't be read is classified from its path alone.
      let content = "";
      try { if (present) content = readFile(f.absolutePath); } catch { /* as a start's own read */ }
      hint = resolveConcreteHint(f.path, content, f.orientation);
    }
    if (hint !== "send_text") return [];
    return [{ absolutePath: f.absolutePath, required: f.required, present, role: isPerSeatRoleStartupFile(f.path, f.orientation) }];
  });
  return [...files.filter((f) => f.role), ...files.filter((f) => !f.role)];
}

/** The seat-skills line's own rule, as at a start: its block belongs in the guidance only with the person's yes, and never
 *  through a linked file. Without it, the block is left out (so it's neither put back nor reported missing), and
 *  `excluded` says why. */
export function applySeatSkillsLineRule(guidance: SeatGuidance, answeredYes: boolean): { guidance: SeatGuidance; excluded?: "not_yes" | "linked" } {
  if (!guidance.items.some((item) => item.blockId === SEAT_SKILLS_BOOTSTRAP_BLOCK_ID)) return { guidance };
  const excluded = !answeredYes ? "not_yes" : guidanceFileIsLink(guidance.targetPath) ? "linked" : undefined;
  if (!excluded) return { guidance };
  return { guidance: { ...guidance, items: guidance.items.filter((item) => item.blockId !== SEAT_SKILLS_BOOTSTRAP_BLOCK_ID) }, excluded };
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
  /** #2456: blocks OpenRig wrote whose source changed since, replaced with the source's current text. */
  refreshed: string[];
  /** #2456: blocks left as they are although they differ from their source, each named with the reason
   *  (`guidance_block_edited`, `guidance_block_may_be_stale` or `guidance_block_record_unreadable`). The seat runs them as
   *  they are. A block written whose record wasn't saved is named here too (`guidance_block_record_not_saved`). */
  kept: string[];
}

const KEPT_GUIDANCE_PREFIXES = ["guidance_block_edited: ", "guidance_block_may_be_stale: ", "guidance_block_record_unreadable: "];

/** #2456: the one line a seat is told when a managed guidance block was left as it is (edited by hand, or possibly stale),
 *  naming each one, or undefined when none was. */
export function keptGuidanceSeatLine(notes: string[]): string | undefined {
  const kept = notes.filter((note) => KEPT_GUIDANCE_PREFIXES.some((prefix) => note.startsWith(prefix)));
  return kept.length > 0 ? `OpenRig guidance note: ${kept.join("; ")}.` : undefined;
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

/** Put back the missing managed guidance blocks. With `records` (#2456), a block already there that OpenRig wrote is
 *  refreshed from its changed source, and one edited since, or with no record, is kept and named (`decideManagedBlock`).
 *  Without them a block already there is left as it is, as before. Any other text in the file is left exactly as it is,
 *  and nothing is written unless cleanup would later remove exactly what was written. Never throws: a failure becomes a
 *  reported gap. */
export function restoreMissingGuidance(guidance: SeatGuidance, fs: ManagedBlockMergeFsOps, records?: ManagedBlockRecords): GuidanceRepair {
  const repair: GuidanceRepair = { restored: [], gaps: [], refreshed: [], kept: [] };
  let states: Map<string, BlockState>;
  let existing: string | null;
  try {
    states = blockStates(guidance, fs);
    existing = fs.exists(guidance.targetPath) ? fs.readFile(guidance.targetPath) : null;
  } catch (err) {
    repair.gaps.push(`could not read ${guidance.targetPath}: ${(err as Error).message}`);
    return repair;
  }
  const toWrite: Array<{ blockId: string; content: string; refresh?: true }> = [];
  for (const item of guidance.items) {
    const state = states.get(item.blockId);
    if (state === "complete") {
      if (!records || item.unresolved) continue;
      let source: string;
      try {
        if (!fs.exists(item.sourcePath)) continue;
        source = fs.readFile(item.sourcePath);
      } catch { continue; }
      // #2456: the same decision every adapter's guidance write makes; an exact resume and a handover keep an unrecorded block.
      const decision = decideManagedBlock(existing ?? "", item.blockId, source, records, guidance.targetPath, { unrecorded: "keep", sourcePath: item.sourcePath });
      if (decision.note) repair.kept.push(decision.note);
      else if (decision.standing === "current") recordManagedBlockWrite(records, guidance.targetPath, item.blockId, source, repair.kept);
      else if (decision.write) toWrite.push({ blockId: item.blockId, content: source, refresh: true });
      continue;
    }
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
      if (records) recordManagedBlockWrite(records, guidance.targetPath, block.blockId, block.content, repair.kept);
      (block.refresh ? repair.refreshed : repair.restored).push(block.blockId);
    } catch (err) {
      repair.gaps.push(`${block.blockId}: ${(err as Error).message}`);
    }
  }
  return repair;
}

/** A node's saved startup context, as a snapshot records it, or null when there's none. */
export function readNodeStartupSnapshot(db: Pick<Database.Database, "prepare">, nodeId: string): NodeStartupSnapshot | null {
  const row = db.prepare("SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime, guidance_file FROM node_startup_context WHERE node_id = ?")
    .get(nodeId) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string; guidance_file: string | null } | undefined;
  if (!row) return null;
  return {
    projectionEntries: JSON.parse(row.projection_entries_json),
    resolvedStartupFiles: JSON.parse(row.resolved_files_json),
    startupActions: JSON.parse(row.startup_actions_json),
    runtime: row.runtime,
    ...(row.guidance_file ? { guidanceFile: row.guidance_file } : {}),
  };
}

/** #875: put a seat's missing managed blocks back in its guidance file from its saved startup context, as an exact resume
 *  does: the seat-skills line only with the person's yes, and nothing through a recorded file that is now a link. A
 *  successor launch carries no guidance of its own, so every seat's handover needs this before its successor starts
 *  (#2456). With `records`, a block OpenRig wrote whose source changed is refreshed too, and a block left as it is is
 *  named. Never throws; returns what it did and what it couldn't, and the source of each required file (a start fails
 *  without it) still missing from the guidance file, which the successor then starts without. */
export function putBackSeatGuidance(input: {
  startupCtx: NodeStartupSnapshot | null;
  cwd: string | null | undefined;
  claudeManagedBlockFile: string | null | undefined;
  seatSkillsLineYes: boolean;
  fs: ManagedBlockMergeFsOps;
  linkInfo: LinkInfo;
  records?: ManagedBlockRecords;
}): { notes: string[]; startedWithoutRequired: string[] } {
  let guidance: SeatGuidance | null;
  try {
    guidance = seatGuidance(input.startupCtx, input.cwd, input.claudeManagedBlockFile, input.fs.exists, input.fs.readFile);
  } catch (err) {
    return { notes: [`could not read the saved guidance selection: ${(err as Error).message}`], startedWithoutRequired: [] };
  }
  if (!guidance) return { notes: [], startedWithoutRequired: [] };
  const notes: string[] = [];
  const rule = applySeatSkillsLineRule(guidance, input.seatSkillsLineYes);
  guidance = rule.guidance;
  const seat = guidance;
  const withoutRequired = (): string[] => {
    const required = seat.items.filter((item) => item.required);
    if (required.length === 0) return [];
    let missing: Set<string>;
    // A guidance file that can't be read is one the harness can't read either.
    try { missing = new Set(missingGuidanceBlocks(seat, input.fs)); } catch { return required.map((item) => item.sourcePath); }
    return required.filter((item) => missing.has(item.blockId)).map((item) => item.sourcePath);
  };
  if (rule.excluded === "linked") notes.push(`the seat-skills line wasn't put back, because ${guidance.targetPath} is a link`);
  const linked = input.startupCtx?.guidanceFile ? guidanceFileSharedByLink(guidance.targetPath, input.linkInfo) : null;
  if (linked) return { notes: [...notes, `${linked} is now a link, so nothing was put back in ${guidance.targetPath}`], startedWithoutRequired: withoutRequired() };
  if (guidance.items.length === 0) return { notes, startedWithoutRequired: [] };
  const repair = restoreMissingGuidance(guidance, input.fs, input.records);
  if (repair.restored.length > 0) notes.push(`put back missing blocks ${repair.restored.join(", ")} in ${guidance.targetPath} from their current source files`);
  if (repair.refreshed.length > 0) notes.push(`refreshed blocks ${repair.refreshed.join(", ")} in ${guidance.targetPath} from their current source files`);
  return { notes: [...notes, ...repair.kept, ...repair.gaps], startedWithoutRequired: withoutRequired() };
}
