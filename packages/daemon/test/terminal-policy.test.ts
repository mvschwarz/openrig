import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { TerminalPolicyStore } from "../src/domain/terminal-policy.js";

describe("terminal interaction choices", () => {
  let db: ReturnType<typeof createFullTestDb>;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => db.close());

  it("preserves old seats at upgrade and copies a rig default only into newly added seats", () => {
    const old = new Database(":memory:");
    try {
      migrate(old, ALL_MIGRATIONS.filter(m => !m.name.startsWith("128_terminal_policy")));
      const repo = new RigRepository(old);
      const rig = repo.createRig("existing");
      const oldSeat = repo.addNode(rig.id, "old", { runtime: "claude-code" });
      migrate(old, ALL_MIGRATIONS);
      const store = new TerminalPolicyStore(old);
      expect(store.account(oldSeat.id, "claude-code")).toMatchObject({ source: "upgrade", preset: "full-control" });
      store.write(oldSeat.id, { preset: "no-peer-interventions", helpers: [], exceptions: {} }, "person", "New seats", true);
      const added = repo.addNode(rig.id, "new", { runtime: "codex" });
      expect(store.account(added.id, "codex")).toMatchObject({ source: "rig_default", preset: "no-peer-interventions",
        supported: { compaction: "not applicable" } });
      store.write(oldSeat.id, { preset: "full-control", helpers: [], exceptions: {} }, "person", "Future seats", true);
      expect(store.read(oldSeat.id).config.preset).toBe("full-control");
      expect(store.read(added.id).config.preset).toBe("no-peer-interventions");
    } finally { old.close(); }
  });

  it("lets a reviewer allow compaction but refuse a peer's saved model and effort changes", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("review-team");
    const reviewer = rigRepo.addNode(rig.id, "reviewer", { runtime: "claude-code", model: "original" });
    const session = sessionRegistry.registerSession(reviewer.id, "reviewer@review-team");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(reviewer.id, { tmuxSession: session.sessionName });
    const headers = { "Content-Type": "application/json", "X-OpenRig-Session": "helper@review-team" };
    const selected = await app.request("/api/seat/set-terminal-policy/reviewer@review-team", {
      method: "POST", headers,
      body: JSON.stringify({ preset: "help-within-instructions", helpers: ["helper@review-team"],
        exceptions: { peer: { compaction: "allow", model: "deny" } }, reason: "Help with compaction; keep the review model." }),
    });
    expect(selected.status, await selected.text()).toBe(200);
    for (const [verb, body] of [["set-model", { model: "different" }], ["set-effort", { effort: "high" }]] as const) {
      const changed = await app.request(`/api/seat/${verb}/reviewer@review-team`, {
        method: "POST", headers, body: JSON.stringify({ ...body, reason: "try a change" }),
      });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ code: "terminal_policy_refused", actorClass: "peer" });
    }
    expect(db.prepare("SELECT model,effort_choice FROM nodes WHERE id=?").get(reviewer.id))
      .toEqual({ model: "original", effort_choice: null });
    const account = await app.request("/api/seat/status/reviewer@review-team");
    expect(await account.json()).toMatchObject({ terminalPolicy: { state: "planned", label: "Custom",
      instruction: "Help with compaction; keep the review model.", rules: {
        peer: { compaction: "allow", model: "deny" }, self: { compaction: "allow", model: "allow" },
        openrig: { compaction: "allow", model: "allow" },
      } } });
  });

  it("admits named help, keeps self separate, and records header attribution instead of a conflicting operator", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("delegation");
    const seat = rigRepo.addNode(rig.id, "reviewer", { runtime: "claude-code", model: "original" });
    const session = sessionRegistry.registerSession(seat.id, "reviewer@delegation");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(seat.id, { tmuxSession: session.sessionName });
    new TerminalPolicyStore(db).write(seat.id, { preset: "help-within-instructions", helpers: ["helper@delegation"], exceptions: {} },
      "person", "Helper may tune the next review model");
    for (const [actor, status] of [["stranger@delegation", 409], ["helper@delegation", 200], ["reviewer@delegation", 200]] as const) {
      const response = await app.request("/api/seat/set-model/reviewer@delegation", { method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor },
        body: JSON.stringify({ model: actor, reason: "Tune the model", operator: "reviewer@delegation" }) });
      expect(response.status).toBe(status);
    }
    const events = (db.prepare("SELECT payload FROM events WHERE type='node.model_changed' ORDER BY seq").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload));
    expect(events.map(e => [e.operator, e.actorClass])).toEqual([["helper@delegation", "peer"], ["reviewer@delegation", "self"]]);
  });
});
