// Slice 16: a live seat moves between Codex and Claude Code, successor first. Real repositories on an in-memory
// database; tmux and the runtime adapters are fakes that keep which pane each session holds, so the exchange, the
// rollback and the retirement are observable. Nothing native runs here; the native cases are named in the PR.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { queueRoutes } from "../src/routes/queue.js";
import { seatRoutes } from "../src/routes/seat.js";
import { transportRoutes } from "../src/routes/transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SeatRuntimeSwitchService, runtimeSwitchSummary } from "../src/domain/seat-runtime-switch-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const SEAT = "dev-impl@seat-rig";

describe("live seat runtime switch", () => {
  let db: Database.Database;
  let home: string;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let panes: Map<string, string>;
  let typed: Array<{ target: string; text: string }>;
  let swaps: Array<{ canonical: string; staged: string }>;
  let clock: number;
  let onSleep: (() => void | Promise<void>) | undefined;
  let checkReady: ReturnType<typeof vi.fn>;
  let declareOccupantSwap: ReturnType<typeof vi.fn>;
  let nodeId: string;
  let predecessorGeneration: string;

  const tmux = () => ({
    deliveryGuard: undefined,
    listPanes: vi.fn(async (name: string) => panes.has(name) ? [{ id: panes.get(name)!, index: 0, cwd: "/project", width: 80, height: 24, active: true }] : []),
    listWindows: vi.fn(async (name: string) => panes.has(name) ? [{ id: "@1", index: 0, name: "main", panes: 1, active: true }] : []),
    probeSession: vi.fn(async (name: string) => ({ state: panes.has(name) ? "present" : "absent" })),
    capturePaneScreen: vi.fn(async () => "predecessor screen tail"),
    createSession: vi.fn(async (name: string) => { panes.set(name, "%5"); return { ok: true }; }),
    getDefaultShell: vi.fn(async () => "/bin/zsh"),
    getPaneCommand: vi.fn(async () => "zsh"),
    sendText: vi.fn(async (target: string, text: string) => { typed.push({ target, text }); return { ok: true }; }),
    sendKeys: vi.fn(async () => ({ ok: true })),
    swapRuntimeSwitchPanes: vi.fn(async (input: { stagingSession: string; canonicalSession: string; canonicalPane: string; stagedPane: string }) => {
      if (panes.get(input.canonicalSession) !== input.canonicalPane || panes.get(input.stagingSession) !== input.stagedPane) {
        return { ok: false, code: "runtime_switch_target_changed", message: "a pane moved" };
      }
      panes.set(input.canonicalSession, input.stagedPane);
      panes.set(input.stagingSession, input.canonicalPane);
      swaps.push({ canonical: input.canonicalPane, staged: input.stagedPane });
      return { ok: true };
    }),
    adoptRuntimeSwitchStaging: vi.fn(async () => ({ ok: true })),
    setRuntimeSwitchEnvironment: vi.fn(async () => ({ ok: true })),
    finishLaunchBinding: vi.fn(),
    setRemainOnExit: vi.fn(async () => ({ ok: true })),
    signalPaneProcess: vi.fn(async () => ({ ok: true })),
    isPaneDead: vi.fn(async () => true),
    killSession: vi.fn(async (name: string) => { panes.delete(name); return { ok: true }; }),
  });
  let fakeTmux: ReturnType<typeof tmux>;

  const adapter = (runtime: string): RuntimeAdapter => ({
    runtime,
    launchHarness: vi.fn(async () => ({ ok: true, resumeToken: runtime === "codex" ? "0198b1f0-0000-7000-8000-000000000001" : "11111111-2222-4333-8444-555555555555",
      resumeType: runtime === "codex" ? "codex_id" : "claude_id" })),
    checkReady,
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: [], failed: [] })),
  }) as unknown as RuntimeAdapter;

  const service = (overrides: Partial<ConstructorParameters<typeof SeatRuntimeSwitchService>[0]> = {}) => new SeatRuntimeSwitchService({
    db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, tmuxAdapter: fakeTmux as unknown as TmuxAdapter, queueRepo,
    runtimeAdapters: { codex: adapter("codex"), "claude-code": adapter("claude-code") },
    occupantInvalidator: new DefaultOccupantInvalidator({ enforcer: { invalidateOccupant: vi.fn() }, contextUsage: { invalidateOccupantSidecar: vi.fn() }, queue: queueRepo }),
    activityOracle: { declareOccupantSwap }, openrigHome: home, readinessTimeoutMs: 1000, confirmPollMs: 1000,
    sleep: async (ms) => { clock += ms; await onSleep?.(); }, now: () => new Date(clock),
    ...overrides,
  });

  const openSwitch = () => db.prepare("SELECT * FROM seat_runtime_switches ORDER BY created_at DESC LIMIT 1").get() as
    { id: string; phase: string; successor_generation: string; committed_at: string | null; outcome: string | null; attention: string | null } | undefined;
  const nodeRow = () => db.prepare("SELECT runtime, model, effort, effort_choice, codex_config_profile, advisor FROM nodes WHERE id = ?").get(nodeId) as Record<string, string | null>;
  const handoverTyped = () => typed.some((t) => t.target.startsWith("openrig-switch-") && t.text.includes("--confirm"));
  /** The staged successor reads the handover and confirms it through OpenRig, with its own generation. */
  const successorConfirms = (svc: SeatRuntimeSwitchService, note = "I'll pick up the claimed review first") => {
    onSleep = () => {
      const row = openSwitch();
      if (row?.phase !== "preparing" || !handoverTyped()) return;
      svc.confirm({ seatRef: SEAT, switchId: row.id, note, actorSession: SEAT, generation: row.successor_generation });
    };
  };

  beforeEach(async () => {
    db = createFullTestDb();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-switch-"));
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true, resolveOccupantGeneration: (name) => sessionRegistry.currentOccupantGenerationForSession(name) });
    panes = new Map([[SEAT, "%0"]]);
    typed = [];
    swaps = [];
    clock = Date.parse("2026-10-24T02:00:00Z");
    onSleep = undefined;
    checkReady = vi.fn(async () => ({ ready: true }));
    declareOccupantSwap = vi.fn();
    fakeTmux = tmux();
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project", model: "gpt-5.5", effort: "high", codexConfigProfile: "fast" });
    nodeId = node.id;
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%0" });
    predecessorGeneration = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
  });
  afterEach(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });

  it("the preview shows the target's settings and where each comes from, what is cleared, and the costs; nothing changes", async () => {
    new NativePermissionStore(db).write(nodeId, { runtime: "codex", mode: "full_bypass" }, "operator@test", "earlier choice");
    const result = await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "Codex usage limit", dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, changed: true, from: "codex", to: "claude-code",
      settings: { model: { value: null, source: "native_default" }, effort: { value: null, source: "native_default" } },
      permission: { mode: "inherit", source: "member_or_rig_policy" } });
    const plan = result as { dropped: Array<{ setting: string; value: string }>; costs: string[] };
    expect(plan.dropped).toEqual(expect.arrayContaining([{ setting: "model", value: "gpt-5.5" }, { setting: "effort", value: "high" },
      { setting: "codex config profile", value: "fast" }, { setting: "native permission choice", value: "codex:full_bypass" }]));
    expect(plan.costs.join(" ")).toMatch(/new conversation.*isn't converted/);
    expect(plan.costs.join(" ")).toMatch(/deferred change_runtime/);
    expect(openSwitch()).toBeUndefined();
    expect(fakeTmux.createSession).not.toHaveBeenCalled();
    expect(nodeRow().runtime).toBe("codex");
  });

  it("a Codex seat moves to Claude Code: same address, the successor confirms first, the claim moves, the old runtime retires", async () => {
    const pending = await queueRepo.create({ sourceSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "review #1" });
    const claimed = await queueRepo.create({ sourceSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "review #2" });
    queueRepo.claim({ qitemId: claimed.qitemId, destinationSession: SEAT });
    const svc = service();
    successorConfirms(svc);

    const result = await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "Codex usage limit", requestedBy: "operator-agent@kernel" });

    expect(result).toMatchObject({ ok: true, changed: true, from: "codex", to: "claude-code", claimsMoved: 1, openRows: 2, recoveryPending: false,
      confirmation: { note: "I'll pick up the claimed review first" } });
    const row = openSwitch()!;
    // The seat's address is unchanged; its pane is the successor's, and its occupant is the successor.
    expect(sessionRegistry.getBindingForNode(nodeId)).toMatchObject({ tmuxSession: SEAT, tmuxPane: "%5" });
    expect(sessionRegistry.currentOccupantTenure(nodeId)!.generationUuid).toBe(row.successor_generation);
    expect(nodeRow()).toEqual({ runtime: "claude-code", model: null, effort: null, effort_choice: null, codex_config_profile: null, advisor: null });
    // Both rows stay addressed to the seat; the claim is the successor's, not released, and its history says why.
    expect(queueRepo.getById(pending.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(queueRepo.getById(claimed.qitemId)).toMatchObject({ destinationSession: SEAT, state: "in-progress" });
    expect((db.prepare("SELECT claimed_by_generation_uuid g FROM queue_items WHERE qitem_id = ?").get(claimed.qitemId) as { g: string }).g).toBe(row.successor_generation);
    const notes = (db.prepare("SELECT transition_note n FROM queue_transitions WHERE qitem_id = ?").all(claimed.qitemId) as Array<{ n: string | null }>).map((t) => t.n);
    expect(notes.some((n) => n?.startsWith(`moved: the seat's runtime switch ${row.id} (codex → claude-code)`))).toBe(true);
    // The exchange came after the confirmation, the predecessor (now in the staging session) is gone, and the
    // successor was told it holds the seat.
    expect(swaps).toEqual([{ canonical: "%0", staged: "%5" }]);
    expect([...panes.keys()]).toEqual([SEAT]);
    expect(typed.at(-1)).toMatchObject({ target: SEAT });
    expect(typed.at(-1)!.text).toMatch(/You now hold dev-impl@seat-rig on claude-code/);
    expect(row).toMatchObject({ phase: "finished", attention: null });
    // The newest default restore describes the new runtime; the change is recorded with who asked and why.
    const rigId = (db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(nodeId) as { rig_id: string }).rig_id;
    const snapshot = new SnapshotRepository(db).findLatestRestoreUsable(rigId);
    expect(snapshot?.kind).toBe("runtime-switch");
    const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.runtime_changed'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ from: "codex", to: "claude-code", reason: "Codex usage limit", requestedBy: "operator-agent@kernel", claimsMoved: 1 });
    expect(declareOccupantSwap).toHaveBeenCalledWith(nodeId, row.successor_generation);
  });

  it("carries retained Claude rules into a target successor while replacing a Codex mode selection", async () => {
    const rules = { allow: ["Read(./work/**)"], deny: ["Read(./private/**)"] };
    db.prepare("UPDATE nodes SET claude_permissions_json=? WHERE id=?").run(JSON.stringify(rules), nodeId);
    new NativePermissionStore(db).write(nodeId, { runtime: "codex", mode: "floor" }, "operator", "earlier Codex choice");
    const claude = adapter("claude-code");
    const svc = service({ runtimeAdapters: { codex: adapter("codex"), "claude-code": claude } });
    successorConfirms(svc);
    expect(await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", permissionMode: "acceptEdits", reason: "switch with retained rules" }))
      .toMatchObject({ ok: true, to: "claude-code" });
    expect(claude.launchHarness).toHaveBeenCalledWith(expect.objectContaining({
      claudePermissions: rules, permissionMode: "acceptEdits",
    }), expect.objectContaining({ name: SEAT }));
  });

  it("refuses unreadable target rules while keeping sends to the current occupant available", async () => {
    db.prepare("UPDATE nodes SET claude_permissions_json = 'broken' WHERE id = ?").run(nodeId);
    const svc = service();
    await expect(svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "switch to Claude" }))
      .resolves.toMatchObject({ ok: false, committed: false, message: expect.stringContaining("Repair the rules") });
    expect(openSwitch()).toBeUndefined();
    expect(fakeTmux.createSession).not.toHaveBeenCalled();
    expect(nodeRow().runtime).toBe("codex");
    expect(sessionRegistry.currentOccupantTenure(nodeId)!.generationUuid).toBe(predecessorGeneration);

    const transport = { resolveSessions: vi.fn(async () => ({ ok: true, sessions: [{ sessionName: SEAT }] })),
      send: vi.fn(async () => ({ ok: true, sent: true })) };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, db as never);
      c.set("sessionTransport" as never, transport as never);
      await next();
    });
    app.route("/api/transport", transportRoutes());
    const response = await app.request("/api/transport/send", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "operator@kernel" },
      body: JSON.stringify({ session: SEAT, text: "please continue" }) });
    expect(await response.json()).toMatchObject({ ok: true, sent: true });
    expect(transport.send).toHaveBeenCalledTimes(1);

    db.prepare("UPDATE nodes SET claude_permissions_json = NULL WHERE id = ?").run(nodeId);
    successorConfirms(svc);
    expect(await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "retry after repairing rules" }))
      .toMatchObject({ ok: true, to: "claude-code" });
  });

  it("the handover asks the successor to confirm, carries the seat's open work, and tells it not to act as the seat yet", async () => {
    await queueRepo.create({ sourceSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "review #1" });
    const svc = service();
    successorConfirms(svc);
    await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "better fit" });
    const handover = typed.find((t) => t.target.startsWith("openrig-switch-"))!.text;
    expect(handover).toMatch(/don't act as the seat/);
    expect(handover).toMatch(/predecessor screen tail/);
    expect(handover).toMatch(/The seat's open queue work \(1 rows/);
    expect(handover).toMatch(new RegExp(`rig seat set-runtime dev\\.impl@seat-rig --confirm ${openSwitch()!.id} --note`));
  });

  it("a Claude Code seat moves to Codex, with an explicit Codex profile", async () => {
    db.prepare("UPDATE nodes SET runtime = 'claude-code', codex_config_profile = NULL, advisor = 'opus' WHERE id = ?").run(nodeId);
    const svc = service();
    successorConfirms(svc);
    const result = await svc.setRuntime({ seatRef: SEAT, runtime: "codex", reason: "Claude usage limit", codexConfigProfile: "deep" });
    expect(result).toMatchObject({ ok: true, changed: true, from: "claude-code", to: "codex",
      settings: { codexConfigProfile: { value: "deep", source: "explicit" }, advisor: { value: null } } });
    expect(nodeRow()).toMatchObject({ runtime: "codex", codex_config_profile: "deep", advisor: null });
  });

  describe("a retained Codex envelope on the way back to Codex", () => {
    // A narrow envelope kept while the seat ran Claude, under a policy that would bypass approvals and the sandbox.
    const envelope = { sandbox: "read-only", approval: "on-request" };
    const storedEnvelope = () => (db.prepare("SELECT codex_permissions_json j FROM nodes WHERE id = ?").get(nodeId) as { j: string | null }).j;
    let codex: RuntimeAdapter;
    beforeEach(() => {
      db.prepare(`UPDATE nodes SET runtime = 'claude-code', codex_config_profile = NULL, codex_permissions_json = ?,
        permission_policy = 'builtin:yolo', policy_origin = 'builtin', policy_launch_posture = 'full_bypass' WHERE id = ?`).run(JSON.stringify(envelope), nodeId);
      codex = adapter("codex");
    });

    it("inherit: the Codex successor launches with the envelope, not the policy's posture alone, and the seat keeps it", async () => {
      const svc = service({ runtimeAdapters: { codex, "claude-code": adapter("claude-code") } });
      successorConfirms(svc);
      expect(await svc.setRuntime({ seatRef: SEAT, runtime: "codex", reason: "back to Codex" })).toMatchObject({ ok: true, to: "codex" });
      // The staged successor's own binding carries the envelope, which the Codex adapter emits in place of the posture.
      expect(codex.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ codexPermissions: envelope }), expect.objectContaining({ name: SEAT }));
      expect(JSON.parse(storedEnvelope()!)).toEqual(envelope);
    });

    it("an explicit target mode replaces it: the successor launches with the mode, and the commit clears the envelope and says so", async () => {
      const svc = service({ runtimeAdapters: { codex, "claude-code": adapter("claude-code") } });
      const plan = await svc.setRuntime({ seatRef: SEAT, runtime: "codex", permissionMode: "floor", reason: "preview", dryRun: true });
      expect(plan).toMatchObject({ ok: true, permission: { mode: "floor", source: "explicit" } });
      expect((plan as { dropped: unknown[] }).dropped).toContainEqual({ setting: "codex permission envelope", value: JSON.stringify(envelope) });
      expect(JSON.parse(storedEnvelope()!)).toEqual(envelope);
      successorConfirms(svc);
      expect(await svc.setRuntime({ seatRef: SEAT, runtime: "codex", permissionMode: "floor", reason: "back to Codex at the floor" }))
        .toMatchObject({ ok: true, to: "codex", permission: { mode: "floor", source: "explicit" } });
      expect(codex.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ launchPosture: "floor" }), expect.objectContaining({ name: SEAT }));
      expect((codex.launchHarness as ReturnType<typeof vi.fn>).mock.calls[0]![0].codexPermissions).toBeUndefined();
      expect(storedEnvelope()).toBeNull();
      expect(new NativePermissionStore(db).read(nodeId)).toMatchObject({ runtime: "codex", mode: "floor" });
      const event = db.prepare("SELECT payload FROM events WHERE type = 'seat.runtime_changed'").get() as { payload: string };
      expect(JSON.parse(event.payload)).toMatchObject({ permissionSelection: "floor", replaced: { codexPermissions: envelope } });
    });

    it("a read error while clearing the envelope rolls the whole commit back, so no mode is recorded beside the envelope", async () => {
      const svc = service({ runtimeAdapters: { codex, "claude-code": adapter("claude-code") } });
      const prepare = db.prepare.bind(db);
      let failClearingRead = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (failClearingRead && sql === "SELECT codex_permissions_json FROM nodes WHERE id = ?") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        return prepare(sql);
      }) as typeof db.prepare);
      // The successor confirms, and the commit's read of the envelope then fails.
      onSleep = () => {
        const row = openSwitch();
        if (row?.phase !== "preparing" || !handoverTyped()) return;
        failClearingRead = true;
        svc.confirm({ seatRef: SEAT, switchId: row.id, note: "ready", actorSession: SEAT, generation: row.successor_generation });
      };
      const result = await svc.setRuntime({ seatRef: SEAT, runtime: "codex", permissionMode: "floor", reason: "back to Codex at the floor" });
      failClearingRead = false;
      expect(result).toMatchObject({ ok: false, code: "runtime_switch_failed", committed: false, message: expect.stringContaining("disk I/O error") });
      expect(JSON.parse(storedEnvelope()!)).toEqual(envelope);
      expect(new NativePermissionStore(db).read(nodeId)).toBeNull();
      expect(nodeRow().runtime).toBe("claude-code");
      expect(sessionRegistry.getBindingForNode(nodeId)).toMatchObject({ tmuxPane: "%0" });
    });

    it("a switch that doesn't commit leaves the envelope and the seat's permission choice as they were", async () => {
      const result = await service({ runtimeAdapters: { codex, "claude-code": adapter("claude-code") } })
        .setRuntime({ seatRef: SEAT, runtime: "codex", permissionMode: "floor", reason: "limit", confirmTimeoutMs: 10_000 });
      expect(result).toMatchObject({ ok: false, code: "runtime_switch_failed", committed: false });
      expect(JSON.parse(storedEnvelope()!)).toEqual(envelope);
      expect(new NativePermissionStore(db).read(nodeId)).toBeNull();
      expect(nodeRow().runtime).toBe("claude-code");
    });
  });

  it("without a confirmation in time nothing changes: the current occupant keeps the seat and its claim, and the staged successor is retired", async () => {
    const claimed = await queueRepo.create({ sourceSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "review" });
    queueRepo.claim({ qitemId: claimed.qitemId, destinationSession: SEAT });
    const result = await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "limit", confirmTimeoutMs: 10_000 });
    expect(result).toMatchObject({ ok: false, code: "runtime_switch_failed", committed: false });
    expect((result as { message: string }).message).toMatch(/didn't confirm the handover within 10 s, so it isn't shown able to carry on/);
    expect((result as { guidance: string }).guidance).toMatch(/dev\.impl@seat-rig is unchanged on codex/);
    expect(nodeRow().runtime).toBe("codex");
    expect(sessionRegistry.getBindingForNode(nodeId)).toMatchObject({ tmuxPane: "%0" });
    expect(sessionRegistry.currentOccupantTenure(nodeId)!.generationUuid).toBe(predecessorGeneration);
    expect((db.prepare("SELECT claimed_by_generation_uuid g FROM queue_items WHERE qitem_id = ?").get(claimed.qitemId) as { g: string }).g).toBe(predecessorGeneration);
    expect(swaps).toEqual([]);
    expect([...panes.keys()]).toEqual([SEAT]);
    expect(openSwitch()).toMatchObject({ phase: "abandoned", committed_at: null });
  });

  it("a successor stuck at a login prompt stops the switch before the handover, and says so", async () => {
    checkReady.mockImplementation(async () => ({ ready: false, code: "login_required", reason: "Claude Code asks for a login" }));
    const result = await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "limit" });
    expect(result).toMatchObject({ ok: false, code: "runtime_switch_failed", committed: false });
    expect((result as { message: string }).message).toMatch(/waiting at a login, trust or approval prompt/);
    expect(handoverTyped()).toBe(false);
    expect(nodeRow().runtime).toBe("codex");
  });

  it("only the staged successor can confirm, with its own generation at the seat it names", async () => {
    const svc = service();
    let refused: unknown;
    onSleep = () => {
      const row = openSwitch();
      if (row?.phase !== "preparing" || refused) return;
      refused = svc.confirm({ seatRef: SEAT, switchId: row.id, note: "me", actorSession: SEAT, generation: predecessorGeneration });
    };
    await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "limit", confirmTimeoutMs: 10_000 });
    expect(refused).toMatchObject({ ok: false, code: "runtime_switch_confirmation_refused" });
    expect(openSwitch()).toMatchObject({ phase: "abandoned" });
  });

  describe("what can't switch is said before anything stops", () => {
    it("the same runtime with settings names the existing setters; without settings nothing changes", async () => {
      expect(await service().setRuntime({ seatRef: SEAT, runtime: "codex", reason: "x", model: "gpt-6" }))
        .toMatchObject({ ok: false, code: "runtime_unchanged", guidance: expect.stringMatching(/rig seat set-model, rig seat set-effort or rig seat set-permissions/) });
      expect(await service().setRuntime({ seatRef: SEAT, runtime: "codex", reason: "x" })).toMatchObject({ ok: true, changed: false });
    });
    it("a seat with two panes", async () => {
      fakeTmux.listPanes.mockImplementation(async () => [{ id: "%0" }, { id: "%1" }] as never);
      const result = await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "x", dryRun: true });
      expect(result).toMatchObject({ ok: false, code: "runtime_switch_unsupported" });
      expect((result as { message: string }).message).toMatch(/only a single-window, single-pane seat can/);
    });
    it("a seat on another runtime", async () => {
      db.prepare("UPDATE nodes SET runtime = 'pi' WHERE id = ?").run(nodeId);
      expect(await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "x", dryRun: true }))
        .toMatchObject({ ok: false, code: "runtime_switch_unsupported", message: expect.stringMatching(/only Codex and Claude Code seats can switch/) });
    });
    it("a target this daemon can't start", async () => {
      expect(await service({ runtimeAdapters: { codex: adapter("codex") } }).setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "x", dryRun: true }))
        .toMatchObject({ ok: false, code: "runtime_target_unavailable" });
    });
    it("a switch already open", async () => {
      db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane, predecessor_generation, successor_generation,
        from_runtime, to_runtime, reason, plan_json, deadline_at) VALUES ('sw1', ?, ?, 'openrig-switch-sw1', '%0', ?, 'g-next', 'codex', 'claude-code', 'r', '{}', '2026-10-24T03:00:00Z')`)
        .run(nodeId, SEAT, predecessorGeneration);
      expect(await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "x", dryRun: true }))
        .toMatchObject({ ok: false, code: "runtime_switch_pending", switchId: "sw1", guidance: expect.stringMatching(/--recover/) });
    });
    it("a reason is required and recorded", async () => {
      expect(await service().setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "  " })).toMatchObject({ ok: false, code: "invalid_runtime_settings" });
    });
  });

  describe("recovery after an interrupted switch", () => {
    const record = (phase: "preparing" | "confirmed" | "committed") => {
      db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane, successor_pane, predecessor_generation,
        successor_generation, from_runtime, to_runtime, phase, reason, plan_json, deadline_at, committed_at)
        VALUES ('sw1', ?, ?, 'openrig-switch-sw1', '%0', '%5', ?, 'g-next', 'codex', 'claude-code', ?, 'r', '{}', '2026-10-24T03:00:00Z', ?)`)
        .run(nodeId, SEAT, predecessorGeneration, phase, phase === "committed" ? "2026-10-24T02:01:00Z" : null);
    };

    it("stopped before commit, panes not exchanged: the staged successor is retired and the old runtime keeps the seat", async () => {
      record("preparing");
      panes.set("openrig-switch-sw1", "%5");
      expect(await service().recover(nodeId)).toMatchObject({ ok: true, outcome: expect.stringMatching(/the codex occupant holds the seat/) });
      expect([...panes.keys()]).toEqual([SEAT]);
      expect(panes.get(SEAT)).toBe("%0");
      expect(openSwitch()).toMatchObject({ phase: "abandoned", attention: null });
    });

    it("stopped after the exchange but before commit: the panes are exchanged back first", async () => {
      record("confirmed");
      panes.set(SEAT, "%5");
      panes.set("openrig-switch-sw1", "%0");
      expect(await service().recover(nodeId)).toMatchObject({ ok: true });
      expect(panes.get(SEAT)).toBe("%0");
      expect(panes.has("openrig-switch-sw1")).toBe(false);
      expect(openSwitch()).toMatchObject({ phase: "abandoned" });
    });

    it("stopped after commit: the predecessor is retired and the successor keeps the seat, never the other way", async () => {
      record("committed");
      panes.set(SEAT, "%5");
      panes.set("openrig-switch-sw1", "%0");
      expect(await service().recover(nodeId)).toMatchObject({ ok: true, outcome: expect.stringMatching(/the seat runs claude-code/) });
      expect([...panes.keys()]).toEqual([SEAT]);
      expect(panes.get(SEAT)).toBe("%5");
      expect(typed.at(-1)!.text).toMatch(/You now hold/);
      expect(openSwitch()).toMatchObject({ phase: "finished" });
    });

    it("panes that match neither side: nothing is touched, and the seat's status says why", async () => {
      record("preparing");
      panes.set(SEAT, "%9");
      expect(await service().recover(nodeId)).toMatchObject({ ok: false, code: "runtime_switch_pending" });
      expect(fakeTmux.killSession).not.toHaveBeenCalled();
      expect(runtimeSwitchSummary(db, { nodeId })).toMatchObject({ id: "sw1", committed: false, attention: expect.stringMatching(/neither the predecessor's nor the successor's/) });
    });
  });

  // review-r2's controls on #1895: a process a switch names stays fenced until it's known gone, on every route that acts
  // as the seat, not only the queue.
  describe("the two processes of one switch stay apart until each is known gone", () => {
    const app = () => {
      const a = new Hono();
      a.use("*", async (c, next) => {
        for (const [key, value] of Object.entries({ db, rigRepo, sessionRegistry, eventBus, queueRepo, tmuxAdapter: fakeTmux })) c.set(key as never, value as never);
        await next();
      });
      a.route("/api/queue", queueRoutes());
      a.route("/api/seat", seatRoutes);
      return a;
    };
    const as = (generation: string, session = SEAT) => ({ "Content-Type": "application/json", "X-OpenRig-Session": session, "X-OpenRig-Occupant-Generation": generation });
    const committedSwitch = async () => {
      const svc = service();
      successorConfirms(svc);
      expect(await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "limit" })).toMatchObject({ ok: true });
      return openSwitch();
    };

    it("a staged successor that couldn't be retired stays fenced, and recovery at the next start retires it", async () => {
      const a = app();
      const work = await queueRepo.create({ sourceSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "owned work", nudge: false });
      fakeTmux.signalPaneProcess.mockImplementation(async () => ({ ok: false, code: "tmux_error", message: "controlled retirement failure" }) as never);
      fakeTmux.isPaneDead.mockImplementation(async () => false);
      const svc = service();
      expect(await svc.setRuntime({ seatRef: SEAT, runtime: "claude-code", reason: "limit", confirmTimeoutMs: 10_000 })).toMatchObject({ ok: false, committed: false });
      const row = openSwitch();
      expect(row).toMatchObject({ phase: "abandoned", attention: expect.stringMatching(/couldn't be retired/) });
      const claim = await a.request(`/api/queue/${work.qitemId}/claim`, { method: "POST", headers: as(row.successor_generation), body: "{}" });
      expect(claim.status).toBe(409);
      expect(await claim.json()).toMatchObject({ code: "switch_not_committed", message: expect.stringMatching(/didn't commit/) });
      expect(queueRepo.getById(work.qitemId)?.state).toBe("pending");
      // The next start tries again. Once the process is gone, the switch is settled and nothing is fenced any more.
      fakeTmux.signalPaneProcess.mockImplementation(async () => ({ ok: true }) as never);
      fakeTmux.isPaneDead.mockImplementation(async () => true);
      expect(await svc.recoverAll()).toEqual([]);
      expect(openSwitch()).toMatchObject({ phase: "abandoned", attention: null, outcome: expect.stringMatching(/retired at recovery/) });
      expect(panes.has(row.staging_session)).toBe(false);
    });

    it("the retired predecessor can't change the seat's model; the successor can", async () => {
      const row = await committedSwitch();
      const a = app();
      const stale = await a.request(`/api/seat/set-model/${encodeURIComponent(SEAT)}`, { method: "POST", headers: as(predecessorGeneration),
        body: JSON.stringify({ model: "stale-predecessor-choice", reason: "earlier work" }) });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "occupant_retired_by_switch" });
      expect(nodeRow().model).toBeNull();
      const own = await a.request(`/api/seat/set-model/${encodeURIComponent(SEAT)}`, { method: "POST", headers: as(row.successor_generation),
        body: JSON.stringify({ model: "successor-choice", reason: "current work" }) });
      expect(own.status).toBe(200);
      expect(nodeRow().model).toBe("successor-choice");
    });

    it.each(["set-effort", "set-permissions", "set-typing-guard", "set-cwd", "set-policy", "set-terminal-policy", "handover", "launch", "stop", "clean", "set-runtime"])(
      "the retired predecessor can't %s as the seat either", async (route) => {
        await committedSwitch();
        const response = await app().request(`/api/seat/${route}/${encodeURIComponent(SEAT)}`, { method: "POST", headers: as(predecessorGeneration), body: "{}" });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "occupant_retired_by_switch" });
      });

    it("reading the seat, and anyone else's request, go on as before", async () => {
      await committedSwitch();
      const a = app();
      expect((await a.request(`/api/seat/status/${encodeURIComponent(SEAT)}`, { headers: as(predecessorGeneration) })).status).toBe(200);
      const operator = await a.request(`/api/seat/set-model/${encodeURIComponent(SEAT)}`, { method: "POST", headers: as("operator-generation", "orch-lead@seat-rig"),
        body: JSON.stringify({ model: "operator-choice", reason: "operator" }) });
      expect(operator.status).toBe(200);
      expect(nodeRow().model).toBe("operator-choice");
    });
  });
});
