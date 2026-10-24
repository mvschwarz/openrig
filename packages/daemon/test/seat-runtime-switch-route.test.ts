// Slice 16: the runtime switch through the production seat routes. What's checked is what a caller gets back: a
// malformed request is refused with the field named, only the staged successor (its session and its reserved generation)
// can confirm, and the summary `rig send` reads says whether the seat is switching. The switch itself is covered with
// fakes in seat-runtime-switch-service.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const SEAT = "dev-impl@seat-rig";
const SUCCESSOR = "0b9d8c7e-successor-generation";

describe("the runtime switch routes", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let nodeId: string;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    nodeId = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/work" }).id;
    const session = setup.sessionRegistry.registerSession(nodeId, SEAT);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(nodeId, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%0" });
  });
  afterEach(() => db.close());

  const post = async (route: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await setup.app.request(`/api/seat/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const openSwitch = () => db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane,
      predecessor_generation, successor_generation, from_runtime, to_runtime, reason, plan_json, deadline_at)
      VALUES ('sw1', ?, ?, 'openrig-switch-sw1', '%0', 'predecessor-generation', ?, 'codex', 'claude-code', 'Codex limit', '{}', '2026-10-24T03:00:00.000Z')`)
    .run(nodeId, SEAT, SUCCESSOR);

  it.each([
    [{ runtime: 7, reason: "x" }, /runtime must be a string/],
    [{ runtime: "claude-code", reason: "x", dryRun: "yes" }, /dryRun must be true or false/],
    [{ runtime: "claude-code", reason: "x", confirmTimeoutSeconds: 5 }, /from 10 to 3600/],
    [[], /must be a JSON object/],
  ])("a malformed request %j is refused with the field named, before the seat is looked at", async (body, message) => {
    const { status, body: result } = await post(`set-runtime/${encodeURIComponent(SEAT)}`, body);
    expect(status).toBe(400);
    expect(result).toMatchObject({ ok: false, code: "invalid_runtime_settings" });
    expect(result.message).toMatch(message);
  });

  it("a seat that doesn't exist is a 404 that names it", async () => {
    const { status, body } = await post("set-runtime/nobody%40seat-rig", { runtime: "claude-code", reason: "Codex limit", dryRun: true });
    expect(status).toBe(404);
    expect(body).toMatchObject({ ok: false, code: "seat_not_found" });
  });

  describe("confirming a staged successor", () => {
    beforeEach(openSwitch);
    const confirm = (headers: Record<string, string>, note = "picking up the review") =>
      post(`set-runtime/${encodeURIComponent(SEAT)}/confirm`, { switchId: "sw1", note }, headers);

    it("another process of the seat can't confirm: the generation is the staged successor's alone", async () => {
      for (const headers of [{ "X-OpenRig-Session": SEAT }, { "X-OpenRig-Session": SEAT, "X-OpenRig-Occupant-Generation": "predecessor-generation" },
        { "X-OpenRig-Session": "orch-lead@seat-rig", "X-OpenRig-Occupant-Generation": SUCCESSOR }]) {
        const { status, body } = await confirm(headers);
        expect(status).toBe(409);
        expect(body).toMatchObject({ code: "runtime_switch_confirmation_refused" });
        expect(body.message).toMatch(/Only the staged successor of dev-impl@seat-rig for switch sw1 can confirm it\. Nothing was changed\./);
      }
      expect(db.prepare("SELECT phase FROM seat_runtime_switches WHERE id = 'sw1'").get()).toEqual({ phase: "preparing" });
    });

    it("the staged successor confirms with a note, and the note is kept with the switch", async () => {
      const { status, body } = await confirm({ "X-OpenRig-Session": SEAT, "X-OpenRig-Occupant-Generation": SUCCESSOR });
      expect(status).toBe(200);
      expect(body.message).toMatch(/Confirmed\. OpenRig is moving dev-impl@seat-rig to you now\. Wait for the activation message/);
      expect(db.prepare("SELECT phase, confirmation_note FROM seat_runtime_switches WHERE id = 'sw1'").get())
        .toEqual({ phase: "confirmed", confirmation_note: "picking up the review" });
    });

    it("a confirmation without a note is refused and says what the note is for", async () => {
      const { status, body } = await confirm({ "X-OpenRig-Session": SEAT, "X-OpenRig-Occupant-Generation": SUCCESSOR }, "  ");
      expect(status).toBe(409);
      expect(body.message).toMatch(/--note .* saying what you'll do first/);
    });
  });

  it("the seat's status says whether it is switching, and until when", async () => {
    const read = async () => (await (await setup.app.request(`/api/seat/status/${encodeURIComponent(SEAT)}`)).json()) as { runtimeSwitch?: unknown };
    expect((await read()).runtimeSwitch).toBeUndefined();
    openSwitch();
    expect((await read()).runtimeSwitch).toMatchObject({ id: "sw1", phase: "preparing", from: "codex", to: "claude-code", committed: false,
      deadlineAt: "2026-10-24T03:00:00.000Z" });
  });
});
