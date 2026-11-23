// S5 (OPR.0.5.4.7) — the three seat-lifecycle routes: HTTP status mapping per the
// PRD (400 required-input, 404 not-found, 409 state conflicts, 502 tmux-layer) and
// the pass-through of the service's named refusals (message + guidance + matches).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

describe("POST /api/seat/{set-model,stop,clean}/:seatRef", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function seedSeat(logicalId = "dev.impl", model = "fable") {
    const rig = setup.rigRepo.findRigsByName("seat-rig")[0] ?? setup.rigRepo.createRig("seat-rig");
    const sessionName = `${logicalId.replace(".", "-")}@seat-rig`;
    const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", model });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    return { rig, node, session, sessionName };
  }

  function tmux() {
    const t = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // Fix r1 (row 9baac99f): the service consumes the CLASSIFIED probeSession.
    // The shared test-app mock predates it; derive a positive-evidence probe
    // from the test's hasSession mock (present/absent — the blip class is
    // pinned against the REAL adapter in the service suite, not here).
    if (!t.probeSession) {
      t.probeSession = vi.fn(async (name: string) =>
        (await t.hasSession(name)) ? { state: "present" } : { state: "absent" });
    }
    return t;
  }

  function post(path: string, seatRef: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/seat/${path}/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("set-cwd forwards the requested directory, prefers the transport actor and returns preparation warnings", async () => {
    const result = { ok: true as const, seat: {} as never, from: "/workspace", to: "/workspace/planner",
      changed: true, effect: "next_launch" as const, warnings: ["Existing local guidance was retained"] };
    const setCwd = vi.spyOn(SeatLifecycleService.prototype, "setCwd").mockResolvedValue(result);
    const res = await setup.app.request("/api/seat/set-cwd/planner%40project", {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "operator@project" },
      body: JSON.stringify({ cwd: "/workspace/planner", reason: "isolate planning", operator: "body-actor" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(setCwd).toHaveBeenCalledExactlyOnceWith({ seatRef: "planner@project", cwd: "/workspace/planner",
      reason: "isolate planning", operator: "operator@project" });
  });

  it("set-launch-wrapper accepts wrapper and argv, clears to NULL and leaves the running seat alone", async () => {
    const { node, sessionName } = seedSeat();
    const sessions = db.prepare("SELECT * FROM sessions").all(), bindings = db.prepare("SELECT * FROM bindings").all();
    const wrapper = ["wrapper", "--flag"];
    const response = await setup.app.request(`/api/seat/set-launch-wrapper/${encodeURIComponent(sessionName)}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@rig" },
      body: JSON.stringify({ wrapper, reason: "select wrapper", operator: "body@rig" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, from: null, to: wrapper, changed: true, effect: "next_launch" });
    const same = await post("set-launch-wrapper", sessionName, { argv: wrapper, reason: "same choice" });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ ok: true, changed: false });
    const cleared = await post("set-launch-wrapper", sessionName, { clear: true, reason: "clear wrapper" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, from: wrapper, to: null, changed: true, effect: "next_launch" });
    expect(db.prepare("SELECT launch_wrapper FROM nodes WHERE id = ?").get(node.id)).toEqual({ launch_wrapper: null });
    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.launch_wrapper_changed' ORDER BY seq").all() as { payload: string }[];
    expect(events.map(row => JSON.parse(row.payload))).toMatchObject([
      { reason: "select wrapper", operator: "sender@rig", from: null, to: wrapper },
      { reason: "clear wrapper", operator: null, from: wrapper, to: null },
    ]);
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(sessions);
    expect(db.prepare("SELECT * FROM bindings").all()).toEqual(bindings);
    expect(tmux().killSession).not.toHaveBeenCalled();
    expect(tmux().createSession).not.toHaveBeenCalled();
    expect(tmux().sendText).not.toHaveBeenCalled();
  });

  it("set-launch-wrapper supports the immutable node route and explicit operator", async () => {
    const { node } = seedSeat();
    const res = await setup.app.request(`/api/seat/set-launch-wrapper/node/${node.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ argv: ["wrapper"], reason: "select wrapper", operator: "operator@rig" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seat: { nodeId: node.id }, to: ["wrapper"] });
    const event = db.prepare("SELECT payload FROM events WHERE type = 'node.launch_wrapper_changed'").get() as { payload: string };
    expect(JSON.parse(event.payload).operator).toBe("operator@rig");
  });

  it.each([undefined, null, "wrapper", [1], ["./wrapper"], ["wrapper", "bad\narg"]].map(wrapper => ({ wrapper })))(
    "set-launch-wrapper returns 400 for invalid argv $wrapper", async ({ wrapper }) => {
      const { sessionName } = seedSeat();
      const res = await post("set-launch-wrapper", sessionName, { wrapper, reason: "select wrapper" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: "invalid_launch_wrapper" });
    },
  );

  it.each(["null", "[]", "{broken", '{"wrapper": ["wrapper"]}', '{"clear": true, "reason": 42}'])(
    "set-launch-wrapper rejects missing reason or malformed input %s", async body => {
      seedSeat();
      const res = await setup.app.request("/api/seat/set-launch-wrapper/dev-impl%40seat-rig", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, code: "missing_reason" });
    },
  );

  it("set-launch-wrapper returns 409 for an unsupported runtime and 404 for a missing seat", async () => {
    const { node, sessionName } = seedSeat();
    db.prepare("UPDATE nodes SET runtime = 'terminal' WHERE id = ?").run(node.id);
    const unsupported = await post("set-launch-wrapper", sessionName, { wrapper: ["wrapper"], reason: "select wrapper" });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({ ok: false, code: "launch_wrapper_unsupported_runtime" });
    const missing = await post("set-launch-wrapper", "ghost@seat-rig", { wrapper: ["wrapper"], reason: "select wrapper" });
    expect(missing.status).toBe(404);
  });

  // R3 (#2829 review): the stop route records sender ELSE body --operator, dropping daemon: from either.
  it("stop records the body --operator when there is no transport sender", async () => {
    const stopSeat = vi.spyOn(SeatLifecycleService.prototype, "stopSeat").mockResolvedValue({ ok: true } as never);
    const res = await post("stop", "dev.impl@seat-rig", { reason: "wave boundary", operator: "op@rig" });
    expect(res.status).toBe(200);
    expect(stopSeat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ seatRef: "dev.impl@seat-rig", reason: "wave boundary", operator: "op@rig" }));
  });

  it("stop prefers the transport sender over a body operator", async () => {
    const stopSeat = vi.spyOn(SeatLifecycleService.prototype, "stopSeat").mockResolvedValue({ ok: true } as never);
    await setup.app.request("/api/seat/stop/dev.impl%40seat-rig", {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@rig" },
      body: JSON.stringify({ reason: "x", operator: "body@rig" }),
    });
    expect(stopSeat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operator: "sender@rig" }));
  });

  it.each(["daemon:seat-reaper", "daemon:anything"])("stop drops a %s body operator (a caller cannot forge daemon attribution)", async actor => {
    const stopSeat = vi.spyOn(SeatLifecycleService.prototype, "stopSeat").mockResolvedValue({ ok: true } as never);
    await post("stop", "dev.impl@seat-rig", { reason: "x", operator: actor });
    expect(stopSeat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operator: null }));
  });

  it("stop drops a daemon: transport sender", async () => {
    const stopSeat = vi.spyOn(SeatLifecycleService.prototype, "stopSeat").mockResolvedValue({ ok: true } as never);
    await setup.app.request("/api/seat/stop/dev.impl%40seat-rig", {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "daemon:seat-reaper" },
      body: JSON.stringify({ reason: "x" }),
    });
    expect(stopSeat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operator: null }));
  });

  it.each(["null", "[]", "{broken", '{"cwd": 42, "reason": "isolate"}'])("set-cwd rejects malformed input %s without an internal error", async body => {
    const res = await setup.app.request("/api/seat/set-cwd/planner%40project", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it.each([["cwd_configuration_changed", 409], ["cwd_destination_conflict", 409], ["cwd_check_failed", 500], ["cwd_persistence_failed", 500]] as const)("set-cwd exposes %s with its recovery details", async (code, status) => {
    const result = { ok: false as const, code, message: "The working directory was not changed",
      guidance: "Inspect the reported files and seat status", warnings: ["Protected destination file: /work/seat/.claude/agents/reviewer.md"] };
    vi.spyOn(SeatLifecycleService.prototype, "setCwd").mockResolvedValue(result);
    const res = await post("set-cwd", "planner@project", { cwd: "/work/seat", reason: "isolate" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(result);
  });

  it.each([true, false])("default-path continue delegates the existing occupant operation (ok=%s)", async ok => {
    const result = { ok, code: "fixture", message: "Existing continuation result", warnings: ["Submission unverified"] };
    const spy = vi.spyOn(SeatLifecycleService.prototype, "continueStartup").mockResolvedValue(result as never);
    const res = await post("continue", "dev@fixture");
    expect(res.status).toBe(ok ? 200 : 409);
    expect(await res.json()).toEqual(result);
    expect(spy).toHaveBeenCalledExactlyOnceWith("dev@fixture");
  });

  it("set-model 200: persists, echoes from/to/changed", async () => {
    const { sessionName } = seedSeat();
    const res = await post("set-model", sessionName, { model: "claude-fable-5", reason: "alias migration", operator: "op@rig" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, from: "fable", to: "claude-fable-5", changed: true });
  });

  it("set-model 400 on missing model; 400 on missing reason", async () => {
    const { sessionName } = seedSeat();
    const noModel = await post("set-model", sessionName, { reason: "x" });
    expect(noModel.status).toBe(400);
    expect((await noModel.json() as { code: string }).code).toBe("missing_model");
    const noReason = await post("set-model", sessionName, { model: "claude-fable-5" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { code: string }).code).toBe("missing_reason");
  });

  it("404 seat_not_found; 409 seat_ambiguous with matches", async () => {
    seedSeat();
    const missing = await post("set-model", "ghost@seat-rig", { model: "m", reason: "x" });
    expect(missing.status).toBe(404);

    // Same logical id in a second rig → bare ref is ambiguous.
    const rigB = setup.rigRepo.createRig("seat-rig-b");
    setup.rigRepo.addNode(rigB.id, "dev.impl", { runtime: "claude-code" });
    const ambiguous = await post("set-model", "dev.impl", { model: "m", reason: "x" });
    expect(ambiguous.status).toBe(409);
    const body = await ambiguous.json() as { code: string; matches: unknown[] };
    expect(body.code).toBe("seat_ambiguous");
    expect(body.matches.length).toBe(2);
  });

  it("stop 200 on a live seat; 409 session_not_live on a dead one; 502 on probe failure", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().killSession.mockResolvedValue({ ok: true });
    const ok = await post("stop", sessionName, { reason: "wave boundary" });
    expect(ok.status).toBe(200);
    expect(tmux().killSession).toHaveBeenCalledWith(sessionName);

    const b = seedSeat("dev.other");
    tmux().hasSession.mockResolvedValue(false);
    const dead = await post("stop", b.sessionName, { reason: "x" });
    expect(dead.status).toBe(409);
    expect((await dead.json() as { code: string }).code).toBe("session_not_live");

    tmux().hasSession.mockRejectedValue(new Error("socket gone"));
    const probe = await post("stop", b.sessionName, { reason: "x" });
    expect(probe.status).toBe(502);
    expect((await probe.json() as { code: string }).code).toBe("tmux_probe_failed");
  });

  it("keeps ps and the TUI rig summary consistent after an intentional stop and a sibling crash", async () => {
    const stopped = seedSeat("dev.qa");
    const crashed = seedSeat("dev.impl");
    seedSeat("dev.lead");
    tmux().hasSession.mockResolvedValue(true);
    tmux().killSession.mockResolvedValue({ ok: true });
    expect((await post("stop", stopped.sessionName, { reason: "on-demand review" })).status).toBe(200);

    async function expectSurfaces(lifecycleState: string, runningCount: number) {
      const ps = await setup.app.request("/api/ps");
      expect(ps.status).toBe(200);
      expect(await ps.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ rigId: stopped.rig.id, lifecycleState, nodeCount: 3, runningCount, status: "partial" }),
      ]));
      const summary = await setup.app.request("/api/rigs/summary");
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stopped.rig.id, lifecycleState, restoreLifecycleState: "degraded", nodeCount: 3, hasLiveAgents: true }),
      ]));
    }

    await expectSurfaces("running", 2);
    setup.sessionRegistry.markDetached(crashed.session.id);
    setup.sessionRegistry.clearBinding(crashed.node.id);
    await expectSurfaces("degraded", 1);
  });

  it("clean 409 session_live on a live seat; 200 on a dead one; 409 nothing_to_clean when repeated", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession.mockResolvedValue(true);
    const live = await post("clean", sessionName, { reason: "x" });
    expect(live.status).toBe(409);
    expect((await live.json() as { code: string }).code).toBe("session_live");

    tmux().hasSession.mockResolvedValue(false);
    const ok = await post("clean", sessionName, { reason: "clean exit observed" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, actions: { sessionsExited: [sessionName], bindingCleared: true } });

    const again = await post("clean", sessionName, { reason: "x" });
    expect(again.status).toBe(409);
    expect((await again.json() as { code: string }).code).toBe("nothing_to_clean");
  });

  it("routes --plan to read-only planning without requiring a reason or entering execution", async () => {
    const result = { ok: true, planOnly: true, complete: false, launchable: null };
    const plan = vi.spyOn(SeatLifecycleService.prototype, "planFresh").mockResolvedValue(result as never);
    const launch = vi.spyOn(SeatLifecycleService.prototype, "launchFresh");
    const res = await post("launch-plan", "dev@fixture", { fresh: true, stop: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(plan).toHaveBeenCalledExactlyOnceWith({ seatRef: "dev@fixture", fresh: true, stop: true });
    expect(launch).not.toHaveBeenCalled();
  });

  it("still requires --fresh for a plan", async () => {
    const res = await post("launch-plan", "dev@fixture", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, planOnly: true, code: "fresh_required" });
  });

  it("launch requires explicit fresh=true", async () => {
    const { sessionName } = seedSeat();
    const res = await post("launch", sessionName, { reason: "deliberate blank restart" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "fresh_required" });
  });

  it("#729: launch route forwards the explicit fresh/stop/reason contract and warnings", async () => {
    const launchFresh = vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockResolvedValue({
      ok: true,
      seat: { ref: "dev-impl@seat-rig", rigId: "rig-1", rigName: "seat-rig", logicalId: "dev.impl", podId: null, podNamespace: null, runtime: "codex" },
      status: "ready",
      sessionName: "dev-impl@seat-rig",
      sessionId: "sess-fresh",
      generation: "gen-fresh",
      model: "gpt-5.6-codex",
      startupPolicyHash: "policy-hash",
      supersededSessionIds: ["sess-old"],
      warnings: ["Startup submission unverified"],
    });

    const res = await post("launch", "dev-impl@seat-rig", {
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "orch-lead@seat-rig",
    });

    expect(res.status).toBe(200);
    expect(launchFresh).toHaveBeenCalledWith({
      seatRef: "dev-impl@seat-rig",
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "orch-lead@seat-rig",
    });
    expect(await res.json()).toMatchObject({ status: "ready", generation: "gen-fresh", warnings: ["Startup submission unverified"] });
  });

  it.each([["process_limits_unverified", true, 409], ["process_limits_unsupported", false, 422], ["process_limits_setup", false, 422],
    ["process_limits_invalid", false, 422]] as const)("#3253: launch route refused with %s -> %s", async (code, retryable, status) => {
    const processLimits = { kind: code.slice("process_limits_".length) as "setup", reason: "fixture" };
    vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockResolvedValue({ ok: false, code, message: "Nothing was stopped or cleaned",
      retryable, processLimits });
    const res = await post("launch", "dev-impl@seat-rig", { fresh: true, reason: "x" });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ ok: false, code, retryable, processLimits });
  });
});
