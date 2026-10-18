import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { ScopeCliError } from "./types.js";
import { pendingCompletedSliceRefs, markSliceRegistrationsVerified } from "./slice-claims.js";
import {
  LifecycleManifestValidationError,
  validateMissionComposition,
} from "@openrig/daemon/project-lifecycle";

export interface MissionSliceMembership {
  ref: string;
  order: number;
  active: boolean;
}

export interface MissionCompositionEdit {
  manifestPath: string;
  original: string;
  updated: string;
}

interface LoadedComposition {
  manifestPath: string;
  original: string;
  document: ReturnType<typeof parseDocument>;
  members: MissionSliceMembership[];
}

export function planMissionMembershipAdd(
  missionPath: string,
  ref: string,
  order?: number,
): MissionCompositionEdit | null {
  const loaded = loadMissionComposition(missionPath);
  if (!loaded) return null;
  assertSafeRelative(ref);
  order ??= (loaded.members.at(-1)?.order ?? 0) + 10;
  if (!Number.isInteger(order)) fail(`Membership order for ${ref} must be an integer.`);
  if (loaded.members.some((member) => path.normalize(member.ref) === path.normalize(ref))) {
    fail(`Mission composition already contains ${ref}.`);
  }
  if (loaded.members.some((member) => member.order === order)) {
    fail(`Mission composition already contains order ${order}.`);
  }
  const members = [...loaded.members, { ref, order, active: true }]
    .sort((a, b) => a.order - b.order);
  return renderEdit(loaded, members);
}

/** Repair only positively unfinished registrations into a fresh union, then verify
 *  this creator's entry. Rename is not compare-and-swap: a later writer can
 *  still supersede a verified snapshot, so completed scaffolds stay on disk. */
export async function appendMissionMembership(
  missionPath: string,
  ref: string,
): Promise<void> {
  const attempts = 10;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const edit = planCompletedSliceMembership(missionPath, ref);
    // README-backed legacy missions do not have a composition manifest.
    if (!edit) {
      markSliceRegistrationsVerified(missionPath, [ref]);
      return;
    }
    try {
      applyMissionCompositionEdits([edit]);
      const current = loadMissionComposition(missionPath);
      if (current?.members.some((member) => path.normalize(member.ref) === path.normalize(ref))) {
        markSliceRegistrationsVerified(missionPath, current.members.map((member) => member.ref));
        return;
      }
    } catch (error) {
      if (!(error instanceof MissionCompositionChangedError)) throw error;
    }
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 91)));
    }
  }
  throw new ScopeCliError({
    fact: `Could not verify membership for ${ref} after ${attempts} attempts.`,
    consequence: "The complete slice scaffold was kept on disk; this create did not report success.",
    action: "Inspect mission.yaml, then run a later slice create to repair unfinished registration.",
  });
}

/** Preserve authored members and add only positively pending complete scaffolds, plus the
 *  caller's completed entry. Existing active flags and orders remain intact. */
function planCompletedSliceMembership(missionPath: string, ref: string): MissionCompositionEdit | null {
  const loaded = loadMissionComposition(missionPath);
  if (!loaded) return null;
  assertSafeRelative(ref);
  const members = [...loaded.members];
  const present = new Set(members.map((member) => path.normalize(member.ref)));
  const completed = pendingCompletedSliceRefs(missionPath);
  completed.push(ref);
  let order = Math.max(0, ...members.map((member) => member.order));
  for (const completedRef of completed) {
    const normalized = path.normalize(completedRef);
    if (present.has(normalized)) continue;
    order += 10;
    members.push({ ref: completedRef, order, active: true });
    present.add(normalized);
  }
  return renderEdit(loaded, members);
}

class MissionCompositionChangedError extends ScopeCliError {}

export function planMissionMembershipRemove(
  missionPath: string,
  ref: string,
): MissionCompositionEdit | null {
  const loaded = loadMissionComposition(missionPath);
  if (!loaded) return null;
  const normalized = path.normalize(ref);
  const members = loaded.members.filter((member) => path.normalize(member.ref) !== normalized);
  if (members.length === loaded.members.length) {
    fail(`Mission composition does not contain ${ref}.`);
  }
  return renderEdit(loaded, members);
}

export function nextMissionMembershipOrder(missionPath: string): number {
  const members = loadMissionComposition(missionPath)?.members ?? [];
  return (members.at(-1)?.order ?? 0) + 10;
}

/** Replace one or more already-validated manifests with rollback on write error. */
export function applyMissionCompositionEdits(edits: MissionCompositionEdit[]): void {
  const unique = Array.from(new Map(edits.map((edit) => [edit.manifestPath, edit])).values());
  // Check the whole batch before staging so an already-stale plan cannot
  // overwrite another agent's authored membership or partially change a move.
  for (const edit of unique) {
    if (fs.readFileSync(edit.manifestPath, "utf8") !== edit.original) {
      throw new MissionCompositionChangedError({
        fact: `Mission composition changed since this edit was planned: ${edit.manifestPath}.`,
        consequence: "Scope composition was not changed.",
        action: "Read the current mission.yaml and retry the scope operation.",
      });
    }
  }
  const staged: Array<{ edit: MissionCompositionEdit; temporary: string }> = [];
  const applied: MissionCompositionEdit[] = [];
  try {
    for (const edit of unique) {
      const temporary = `${edit.manifestPath}.openrig-${process.pid}-${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, edit.updated, { encoding: "utf8", mode: fs.statSync(edit.manifestPath).mode });
      staged.push({ edit, temporary });
    }
    for (const item of staged) {
      fs.renameSync(item.temporary, item.edit.manifestPath);
      applied.push(item.edit);
    }
  } catch (error) {
    for (const edit of applied.reverse()) fs.writeFileSync(edit.manifestPath, edit.original, "utf8");
    for (const item of staged) {
      if (fs.existsSync(item.temporary)) fs.rmSync(item.temporary, { force: true });
    }
    throw error;
  }
}

function loadMissionComposition(missionPath: string): LoadedComposition | null {
  const manifestPath = path.join(missionPath, "mission.yaml");
  // Legacy work nodes remain valid indefinitely.  Absence means this mission
  // has not opted into manifest-backed composition; malformed explicit input
  // still refuses loudly.
  if (!fs.existsSync(manifestPath)) return null;
  if (fs.lstatSync(manifestPath).isSymbolicLink()) fail(`Mission manifest may not be a symlink: ${manifestPath}.`);
  const original = fs.readFileSync(manifestPath, "utf8");
  const document = parseDocument(original);
  if (document.errors.length > 0) fail(`Mission manifest is invalid YAML: ${document.errors[0]!.message}`);
  const root = document.toJS() as unknown;
  let members: MissionSliceMembership[];
  try {
    members = validateMissionComposition(root, manifestPath).map((member) => ({
      ref: member.ref,
      order: member.order,
      active: member.active,
    }));
  } catch (error) {
    if (error instanceof LifecycleManifestValidationError) fail(error.message);
    throw error;
  }
  return { manifestPath, original, document, members };
}

function renderEdit(loaded: LoadedComposition, members: MissionSliceMembership[]): MissionCompositionEdit {
  loaded.document.setIn(["composition", "slices"], members);
  return { manifestPath: loaded.manifestPath, original: loaded.original, updated: String(loaded.document) };
}

function assertSafeRelative(ref: string): void {
  if (path.isAbsolute(ref) || path.normalize(ref).split(path.sep).includes("..")) {
    fail(`Mission membership must be a safe relative path without '..': ${ref}.`);
  }
}

function fail(fact: string): never {
  throw new ScopeCliError({
    fact,
    consequence: "Scope composition was not changed.",
    action: "Repair mission.yaml or the referenced slice, then retry.",
  });
}
