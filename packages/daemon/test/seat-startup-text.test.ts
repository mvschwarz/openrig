import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { editSavedStartupText, inspectSavedStartupText } from "../src/domain/seat-startup-text.js";

describe("saved startup text", () => {
  it("previews, rejects a stale revision, and updates only the chosen seat", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, launch_recipe_json TEXT); CREATE TABLE node_startup_context (node_id TEXT PRIMARY KEY, projection_entries_json TEXT, resolved_files_json TEXT, startup_actions_json TEXT, runtime TEXT)");
    const action = { type: "send_text", value: "old", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true };
    const identity = { ...action, value: "OpenRig session identity: protected" };
    const recipe = JSON.stringify({ version: 1, rigRoot: "/tmp", rigSpec: { pods: [{ id: "dev", members: [{ id: "build", startup: { files: [], actions: [action] } }] }] } });
    const actions = JSON.stringify([action, identity]);
    for (const id of ["a", "b"]) {
      db.prepare("INSERT INTO nodes VALUES (?, ?)").run(id, recipe);
      db.prepare("INSERT INTO node_startup_context VALUES (?, '[]', '[]', ?, 'codex')").run(id, actions);
    }
    const input = { nodeId: "a", logicalId: "dev.build", layer: "member" as const, recipeIndex: 0, contextIndex: 0, value: "new" };
    expect(inspectSavedStartupText(db, "a", "dev.build")).toMatchObject({ ok: true, candidates: [{ layer: "member", recipeIndex: 0, contextIndex: 0, value: "old" }] });
    expect(editSavedStartupText(db, { ...input, value: "OpenRig session identity: forged" })).toMatchObject({ ok: false, code: "invalid_startup_text" });
    expect(editSavedStartupText(db, { ...input, contextIndex: 1 })).toMatchObject({ ok: false, code: "selection_mismatch" });
    const preview = editSavedStartupText(db, input);
    expect(preview).toMatchObject({ ok: true, preview: true, from: "old", to: "new" });
    if (!preview.ok) throw new Error(preview.message);
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run('["concurrent"]', "a");
    expect(editSavedStartupText(db, { ...input, expectedRevision: preview.revision })).toMatchObject({ ok: false, code: "stale_revision" });
    expect((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id = 'a'").get() as { startup_actions_json: string }).startup_actions_json).toBe(actions);
    const current = editSavedStartupText(db, input);
    if (!current.ok) throw new Error(current.message);
    expect(editSavedStartupText(db, { ...input, expectedRevision: current.revision })).toMatchObject({ ok: true, preview: false, to: "new" });
    const saved = JSON.parse((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id = 'a'").get() as { startup_actions_json: string }).startup_actions_json);
    expect(saved.map((a: { value: string }) => a.value)).toEqual(["new", identity.value]);
    const savedRecipe = JSON.parse((db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = 'a'").get() as { launch_recipe_json: string }).launch_recipe_json);
    expect(savedRecipe.rigSpec.pods[0].members[0].startup.actions[0].value).toBe("new");
    expect((db.prepare("SELECT launch_recipe_json FROM nodes WHERE id = 'b'").get() as { launch_recipe_json: string }).launch_recipe_json).toBe(recipe);
    db.close();
  });
});
