import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { NodeLaunchRecipe, StartupAction } from "./types.js";

/** Revision covers both independently persisted inputs, including unrelated fields. */
export function startupTextRevision(nodeId: string, context: unknown, recipeJson: string): string {
  return createHash("sha256").update(JSON.stringify([nodeId, context, recipeJson])).digest("hex");
}

export type StartupTextLayer = "rig" | "pod" | "member";

/** Locate an authored action in this seat's private copy of the launch recipe. */
export function recipeStartupAction(recipe: NodeLaunchRecipe, logicalId: string, layer: StartupTextLayer, index: number): StartupAction | undefined {
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

export function inspectSavedStartupText(db: Database.Database, nodeId: string, logicalId: string) {
  const context = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(nodeId) as { startup_actions_json: string } | undefined;
  const node = db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = ?").get(nodeId) as { launch_recipe_json: string | null } | undefined;
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
  const unmatchedContext = actions.flatMap((action, contextIndex) =>
    isEditableStartupText(action) && !candidates.some(candidate => candidate.contextIndex === contextIndex)
      ? [{ contextIndex, value: action.value, appliesOn: action.appliesOn }] : []);
  return { ok: true as const, inspect: true, revision: startupTextRevision(nodeId, [logicalId, context], node.launch_recipe_json), candidates, unmatchedContext };
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
    const node = db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = ?").get(input.nodeId) as { launch_recipe_json: string | null } | undefined;
    if (!context || !node?.launch_recipe_json) return { ok: false as const, code: "saved_input_missing", message: "Saved startup context and launch recipe are both required." };
    const revision = startupTextRevision(input.nodeId, [input.logicalId, context], node.launch_recipe_json);
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
      return { ok: false as const, code: "stale_revision", message: "Saved startup inputs changed; preview again.", revision };
    const recipe = JSON.parse(node.launch_recipe_json) as NodeLaunchRecipe;
    const actions = JSON.parse(context.startup_actions_json) as StartupAction[];
    const authored = recipeStartupAction(recipe, input.logicalId, input.layer, input.recipeIndex);
    const saved = actions[input.contextIndex];
    if (!isEditableStartupText(authored) || !isEditableStartupText(saved) || !sameAction(authored, saved))
      return { ok: false as const, code: "selection_mismatch", message: "Selected recipe and saved context positions must identify the same application-authored text." };
    const from = authored.value;
    const appliesOn = authored.appliesOn;
    const restoreEligible = appliesOn.includes("restore") && authored.idempotent;
    if (input.expectedRevision === undefined) return { ok: true as const, preview: true, revision, from, to: input.value, appliesOn, restoreEligible };
    authored.value = input.value;
    saved.value = input.value;
    const actionsJson = JSON.stringify(actions);
    const recipeJson = JSON.stringify(recipe);
    db.prepare("UPDATE node_startup_context SET startup_actions_json = ? WHERE node_id = ?").run(actionsJson, input.nodeId);
    db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(recipeJson, input.nodeId);
    const savedContext = db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(input.nodeId) as typeof context;
    const savedRecipe = db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = ?").get(input.nodeId) as { launch_recipe_json: string };
    return { ok: true as const, preview: false, revision: startupTextRevision(input.nodeId, [input.logicalId, savedContext], savedRecipe.launch_recipe_json),
      from, to: (JSON.parse(savedContext.startup_actions_json) as StartupAction[])[input.contextIndex]!.value,
      recipeText: recipeStartupAction(JSON.parse(savedRecipe.launch_recipe_json) as NodeLaunchRecipe, input.logicalId, input.layer, input.recipeIndex)!.value,
      appliesOn, restoreEligible };
  })();
}
