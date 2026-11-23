import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { RigRepository } from "./rig-repository.js";
import type { NodeLaunchRecipe, StartupAction } from "./types.js";

/** Revision covers saved context, recipe and shared rig layer, including unrelated fields. */
export function startupTextRevision(nodeId: string, context: unknown, recipeJson: string): string {
  return createHash("sha256").update(JSON.stringify([nodeId, context, recipeJson])).digest("hex");
}

export type StartupTextLayer = "rig" | "pod" | "member" | "context";
type RecipeWithOverrides = NodeLaunchRecipe;

function savedNodeInputs(db: Database.Database, nodeId: string) {
  return db.prepare("SELECT n.launch_recipe_json, r.startup_layers_json FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?")
    .get(nodeId) as { launch_recipe_json: string | null; startup_layers_json: string | null } | undefined;
}

/** Locate an authored action in this seat's private copy of the launch recipe. */
export function recipeStartupAction(recipe: NodeLaunchRecipe, logicalId: string, layer: StartupTextLayer, index: number): StartupAction | undefined {
  if (layer === "context") return undefined;
  const [podId, memberId] = logicalId.split(".");
  const pod = recipe.rigSpec.pods.find(candidate => candidate.id === podId);
  const member = pod?.members.find(candidate => candidate.id === memberId);
  if (!pod || !member) return undefined;
  const block = layer === "rig" ? recipe.rigSpec.startup : layer === "pod" ? pod.startup : member.startup;
  return block?.actions[index];
}

/** Generated identity actions, including legacy untagged ones, are never editable here. */
export function isEditableStartupText(action: StartupAction | undefined): action is StartupAction {
  return !!action && action.type === "send_text" && !action.builtin && !action.value.startsWith("OpenRig session identity:");
}

/** The two selected positions must name the same authored action, not merely similar text. */
function sameAction(a: StartupAction, b: StartupAction): boolean {
  return a.type === b.type && a.value === b.value && a.phase === b.phase && a.idempotent === b.idempotent
    && JSON.stringify(a.appliesOn) === JSON.stringify(b.appliesOn) && a.builtin === b.builtin;
}

function sameShape(a: StartupAction, b: StartupAction): boolean {
  return sameAction({ ...a, value: b.value }, b);
}

/** Apply seat-owned replacements to freshly resolved actions, without editing shared sources. */
export function applyStartupTextOverrides(db: Database.Database, nodeId: string, actions: StartupAction[], warnings: string[] = [], source: "resolved" | "saved" = "resolved"): StartupAction[] {
  const recipe = new RigRepository(db).getNodeLaunchRecipe(nodeId);
  if (!recipe || actions.length === 0) return actions;
  const overrides = recipe.startupTextOverrides ?? [];
  const matchesByOverride = overrides.map(override => actions.flatMap((action, index) => isEditableStartupText(action) && sameShape(action, override.before)
      && (action.value === override.before.value || action.value === override.value) ? [index] : []));
  const replacements = new Map<number, string>();
  overrides.forEach((override, i) => {
    const matches = matchesByOverride[i]!;
    if (matches.length !== 1 || matchesByOverride.some((other, j) => j !== i && other.includes(matches[0]!))) {
      warnings.push(`Saved startup text override ${i} is stale or overlaps another action; using ${source === "saved" ? "saved startup" : "current source"} text. Inspect or clear the saved override.`);
    } else replacements.set(matches[0]!, override.value);
  });
  return actions.map((action, index) => replacements.has(index) ? { ...action, value: replacements.get(index)! } : action);
}

export function inspectSavedStartupText(db: Database.Database, nodeId: string, logicalId: string, sourceActions?: StartupAction[] | null) {
  const context = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(nodeId) as { startup_actions_json: string } | undefined;
  const node = savedNodeInputs(db, nodeId);
  if (!context || !node?.launch_recipe_json) return { ok: false as const, code: "saved_input_missing", message: "Saved startup context and launch recipe are both required." };
  const recipe = JSON.parse(node.launch_recipe_json) as NodeLaunchRecipe;
  const actions = JSON.parse(context.startup_actions_json) as StartupAction[];
  const candidates: Array<{ layer: StartupTextLayer; recipeIndex: number; contextIndex: number; value: string; appliesOn: StartupAction["appliesOn"] }> = [];
  for (const layer of ["rig", "pod", "member"] as const) {
    for (let index = 0; ; index++) {
      const action = recipeStartupAction(recipe, logicalId, layer, index);
      if (!action) break;
      if (!isEditableStartupText(action)) continue;
      actions.forEach((saved, contextIndex) => {
        if (isEditableStartupText(saved) && sameAction(action, saved))
          candidates.push({ layer, recipeIndex: index, contextIndex, value: action.value, appliesOn: action.appliesOn });
      });
    }
  }
  const uniqueCandidates = candidates.filter(candidate => candidates.filter(other => other.contextIndex === candidate.contextIndex).length === 1
    && candidates.filter(other => other.layer === candidate.layer && other.recipeIndex === candidate.recipeIndex).length === 1);
  const unmatchedContext = actions.flatMap((action, contextIndex) =>
    isEditableStartupText(action) && !uniqueCandidates.some(candidate => candidate.contextIndex === contextIndex)
      ? [{ contextIndex, value: action.value, appliesOn: action.appliesOn }] : []);
  const contextCandidates = unmatchedContext.filter(entry => !candidates.some(candidate => candidate.contextIndex === entry.contextIndex)
    && actions.filter(action => isEditableStartupText(action) && sameAction(action, actions[entry.contextIndex]!)).length === 1)
    .map(entry => ({ ...entry, layer: "context" as const, recipeIndex: 0 }));
  const ambiguousContext = unmatchedContext.filter(entry => !contextCandidates.some(candidate => candidate.contextIndex === entry.contextIndex));
  const overrides = (recipe.startupTextOverrides ?? []).map((entry, overrideIndex) => {
    const matches = actions.flatMap((action, index) => isEditableStartupText(action) && sameShape(action, entry.before) && action.value === entry.value ? [index] : []);
    const source = sourceActions ?? actions;
    const overlap = source.filter(action => isEditableStartupText(action) && sameShape(action, entry.before)
      && (action.value === entry.before.value || action.value === entry.value)).length > 1;
    const sourceMatches = source.filter(action => isEditableStartupText(action) && sameShape(action, entry.before)
      && (action.value === entry.before.value || action.value === entry.value));
    const contested = sourceMatches.length === 1 && (recipe.startupTextOverrides ?? []).some((other, index) => index !== overrideIndex
      && sameShape(sourceMatches[0]!, other.before) && (sourceMatches[0]!.value === other.before.value || sourceMatches[0]!.value === other.value));
    return { overrideIndex, value: entry.value, before: entry.before.value, contextIndex: matches.length === 1 ? matches[0] : null,
      status: sourceActions ? (sourceMatches.length === 1 && !contested ? "current" : "stale") : "source_unverified", overlap: overlap || contested };
  });
  return { ok: true as const, inspect: true, revision: startupTextRevision(nodeId, [logicalId, context, node.startup_layers_json], node.launch_recipe_json), candidates: [...uniqueCandidates, ...contextCandidates], ambiguousContext, overrides };
}

/** Remove a seat-only override after its shared source changes; the saved context remains intact. */
export function clearStartupTextOverride(db: Database.Database, input: { nodeId: string; logicalId: string; contextIndex: number; overrideIndex?: number; expectedRevision?: string }) {
  return db.transaction(() => {
    const context = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(input.nodeId) as { startup_actions_json: string } | undefined;
    const node = savedNodeInputs(db, input.nodeId);
    if (!context || !node?.launch_recipe_json) return { ok: false as const, code: "saved_input_missing", message: "Saved startup context and launch recipe are both required." };
    const revision = startupTextRevision(input.nodeId, [input.logicalId, context, node.startup_layers_json], node.launch_recipe_json);
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
      return { ok: false as const, code: "stale_revision", message: "Saved startup inputs changed; preview again.", revision };
    const recipe = JSON.parse(node.launch_recipe_json) as RecipeWithOverrides;
    const action = (JSON.parse(context.startup_actions_json) as StartupAction[])[input.contextIndex];
    const overrides = recipe.startupTextOverrides ?? [];
    const matches = input.overrideIndex === undefined ? overrides.flatMap((entry, index) => isEditableStartupText(action) && entry.value === action.value && sameShape(entry.before, action) ? [index] : [])
      : overrides[input.overrideIndex] ? [input.overrideIndex] : [];
    if (matches.length !== 1) return { ok: false as const, code: "override_not_found", message: "The selected saved action does not identify exactly one seat-only override." };
    const from = overrides[matches[0]!]!.value;
    if (input.expectedRevision === undefined) return { ok: true as const, preview: true, clearOverride: true, revision, from };
    overrides.splice(matches[0]!, 1);
    if (overrides.length) recipe.startupTextOverrides = overrides; else delete recipe.startupTextOverrides;
    const recipeJson = JSON.stringify(recipe);
    db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(recipeJson, input.nodeId);
    const savedRecipe = db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = ?").get(input.nodeId) as { launch_recipe_json: string };
    return { ok: true as const, preview: false, clearOverride: true, revision: startupTextRevision(input.nodeId, [input.logicalId, context, node.startup_layers_json], savedRecipe.launch_recipe_json), from };
  })();
}

export function editSavedStartupText(db: Database.Database, input: {
  nodeId: string; logicalId: string; layer: StartupTextLayer; recipeIndex: number; contextIndex: number;
  value: string; expectedRevision?: string;
}) {
  return db.transaction(() => {
    if (!input.value || input.value.startsWith("OpenRig session identity:"))
      return { ok: false as const, code: "invalid_startup_text", message: "Replacement must be nonempty application text, not an OpenRig identity action." };
    const context = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?")
      .get(input.nodeId) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string } | undefined;
    const node = savedNodeInputs(db, input.nodeId);
    if (!context || !node?.launch_recipe_json) return { ok: false as const, code: "saved_input_missing", message: "Saved startup context and launch recipe are both required." };
    const revision = startupTextRevision(input.nodeId, [input.logicalId, context, node.startup_layers_json], node.launch_recipe_json);
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
      return { ok: false as const, code: "stale_revision", message: "Saved startup inputs changed; preview again.", revision };
    const recipe = JSON.parse(node.launch_recipe_json) as RecipeWithOverrides;
    const actions = JSON.parse(context.startup_actions_json) as StartupAction[];
    const authored = recipeStartupAction(recipe, input.logicalId, input.layer, input.recipeIndex);
    const saved = actions[input.contextIndex];
    if (!isEditableStartupText(saved) || (input.layer !== "context" && (!isEditableStartupText(authored) || !sameAction(authored, saved))))
      return { ok: false as const, code: "selection_mismatch", message: "Selected recipe and saved context positions must identify the same application-authored text." };
    if (actions.filter(action => isEditableStartupText(action) && sameAction(action, saved)).length !== 1)
      return { ok: false as const, code: "selection_ambiguous", message: "This saved action is duplicated; select a uniquely identifiable action." };
    const overlap = actions.some((action, index) => index !== input.contextIndex && isEditableStartupText(action)
      && sameShape(action, saved) && action.value === input.value)
      || (recipe.startupTextOverrides ?? []).some(entry => sameShape(entry.before, saved) && entry.value !== saved.value
        && [entry.before.value, entry.value].some(value => value === saved.value || value === input.value));
    let recipeMatches = 0;
    for (const layer of ["rig", "pod", "member"] as const) {
      for (let index = 0; ; index++) {
        const action = recipeStartupAction(recipe, input.logicalId, layer, index);
        if (!action) break;
        if (isEditableStartupText(action) && sameAction(action, saved)) recipeMatches++;
      }
    }
    if ((input.layer === "context" && recipeMatches !== 0) || (input.layer !== "context" && recipeMatches !== 1))
      return { ok: false as const, code: "selection_ambiguous", message: "The selected saved action cannot be attributed uniquely to this recipe layer." };
    const from = saved.value;
    const appliesOn = saved.appliesOn;
    const restoreEligible = appliesOn.includes("restore") && saved.idempotent;
    const sourceMatchRequired = input.layer === "context";
    if (input.expectedRevision === undefined) return { ok: true as const, preview: true, revision, from, to: input.value, appliesOn, restoreEligible, sourceMatchRequired, overlap };
    if (input.value === from) return { ok: true as const, preview: false, changed: false, revision, from, to: from, appliesOn, restoreEligible, sourceMatchRequired };
    if (input.layer === "context") {
      const overrides = recipe.startupTextOverrides ?? [];
      const existing = overrides.find(entry => entry.value === saved.value && sameShape(entry.before, saved));
      if (existing) existing.value = input.value;
      else overrides.push({ before: { ...saved }, value: input.value });
      recipe.startupTextOverrides = overrides;
    } else {
      authored!.value = input.value;
      if (input.layer === "rig" || input.layer === "pod")
        recipe.startupTextPrivateLayers = [...new Set([...(recipe.startupTextPrivateLayers ?? []), input.layer])];
    }
    saved.value = input.value;
    const actionsJson = JSON.stringify(actions);
    const recipeJson = JSON.stringify(recipe);
    db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(actionsJson, input.nodeId);
    db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(recipeJson, input.nodeId);
    const savedContext = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(input.nodeId) as typeof context;
    const savedRecipe = db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = ?").get(input.nodeId) as { launch_recipe_json: string };
    return { ok: true as const, preview: false, changed: true, revision: startupTextRevision(input.nodeId, [input.logicalId, savedContext, node.startup_layers_json], savedRecipe.launch_recipe_json),
      from, to: (JSON.parse(savedContext.startup_actions_json) as StartupAction[])[input.contextIndex]!.value,
      recipeText: input.layer === "context" ? (JSON.parse(savedRecipe.launch_recipe_json) as RecipeWithOverrides).startupTextOverrides!.find(entry => entry.value === input.value && sameShape(entry.before, saved))!.value
        : recipeStartupAction(JSON.parse(savedRecipe.launch_recipe_json) as NodeLaunchRecipe, input.logicalId, input.layer, input.recipeIndex)!.value,
      appliesOn, restoreEligible, sourceMatchRequired };
  })();
}
