import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

describe("startup prompt submission", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  function fixture(lostEnters: number, runtime = "claude-code") {
    const db = createFullTestDb(); dbs.push(db); db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
    const registry = new SessionRegistry(db), eventBus = new EventBus(db);
    const repo = new RigRepository(db), rig = repo.createRig("startup-submit");
    const node = repo.addNode(rig.id, "worker", { runtime });
    const name = "worker@startup-submit", session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    let composer = "", enters = 0;
    const submitted: string[] = [];
    const guard = new SeatDeliveryGuard(db, (target) => target === name || target === node.id
      ? { nodeId: node.id, session: name, occupant: null, pane: "%1" } : null);
    const tmux = {
      deliveryGuard: guard,
      probeSession: vi.fn(async () => ({ state: "present" as const })),
      listPanes: vi.fn(async () => []),
      sendText: vi.fn(async (_name: string, text: string) => { composer += text; return { ok: true as const }; }),
      sendKeys: vi.fn(async (_name: string, keys: string[]) => {
        expect(keys).toEqual(["Enter"]);
        if (++enters > lostEnters) { submitted.push(composer); composer = ""; }
        return { ok: true as const }; // successful tmux command can still leave input staged
      }),
      capturePaneContent: vi.fn(async (_target: string, scrollback = 50): Promise<string | null> => {
        const screen = `Previous turn\n────────────────────\n❯ ${composer}\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n✔ Update installed · Restart to apply\n`;
        // tmux -S includes the selected scrollback plus the visible pane (24 rows here).
        return screen.split("\n").slice(-(scrollback + 24)).join("\n");
      }),
    };
    const adapter = {
      runtime, project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }), checkReady: async () => ({ ready: true }),
    } as unknown as RuntimeAdapter;
    const role = Array.from({ length: 100 }, (_, i) => `Startup instruction ${i}: read the assigned project source.`).join("\n");
    const orch = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus,
      tmuxAdapter: tmux as unknown as TmuxAdapter, readFile: () => role, sleep: async () => {} });
    const start = () => orch.startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "binding", nodeId: node.id, tmuxSession: name, tmuxPane: "%1", tmuxWindow: null,
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture" },
      adapter, plan: { runtime: "claude-code", cwd: "/fixture", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [{ type: "send_text", builtin: "session_identity", value: "OpenRig session identity: worker@startup-submit", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }],
      isRestore: false,
    });
    return { db, session, tmux, submitted, start, composer: () => composer };
  }

  it("retries only Enter when the initial startup paste is still staged", async () => {
    const f = fixture(1);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(f.submitted).toEqual([f.tmux.sendText.mock.calls[0]![1]]);
    expect(f.composer()).toBe("");
  });

  it("does not retry a normal submission", async () => {
    const f = fixture(0);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.submitted).toHaveLength(1);
  });

  it("does not report ready when the one retry leaves startup text staged", async () => {
    const f = fixture(Infinity);
    expect(await f.start()).toMatchObject({ ok: false });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(f.submitted).toEqual([]);
    expect(f.db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(f.session.id)).not.toEqual({ startup_status: "ready" });
  });

  it("uses the guarded recheck when the composer changes before the retry", async () => {
    const f = fixture(Infinity);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture)
      .mockResolvedValueOnce("A different question\n❯ 1. Continue\n  2. Cancel\n");
    expect(await f.start()).toMatchObject({ ok: false, errors: [expect.stringContaining("guarded submit failed")] });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.submitted).toEqual([]);
  });

  it("does not retry an old prompt echoed above the current empty composer", async () => {
    const f = fixture(0);
    f.tmux.capturePaneContent.mockImplementation(async () => `❯ ${f.submitted[0]}\nResponse\n❯ \n────────────────────\n`);
    expect(await f.start()).toMatchObject({ ok: true });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", "   "])("does not claim checked submission from unavailable capture %j", async (pane) => {
    const f = fixture(Infinity);
    f.tmux.capturePaneContent.mockResolvedValue(pane);
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified", reasons: [expect.stringContaining("capture is unavailable")] } });
    const event = f.db.prepare("SELECT payload FROM events WHERE type = 'node.startup_ready' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(event.payload).submission).toEqual({ status: "unverified", reasons: [expect.stringContaining("capture is unavailable")] });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("lets the seat continue with an unverified post-retry capture, without a third Enter", async () => {
    const f = fixture(1);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture).mockImplementationOnce(capture).mockResolvedValueOnce(null);
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified", reasons: [expect.stringContaining("after the guarded retry")] } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(f.submitted).toHaveLength(1);
  });

  it("reports a thrown capture as unverified and lets the seat continue", async () => {
    const f = fixture(0);
    f.tmux.capturePaneContent.mockRejectedValue(new Error("fixture capture unavailable"));
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified", reasons: [expect.stringContaining("fixture capture unavailable")] } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("does not fail on an unavailable guarded recheck and final capture", async () => {
    const f = fixture(1);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture).mockResolvedValue(null);
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified" } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("leaves the non-Claude startup path unchanged", async () => {
    const f = fixture(0, "codex");
    f.tmux.capturePaneContent.mockResolvedValue(null);
    expect(await f.start()).toMatchObject({ ok: true });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.tmux.capturePaneContent).not.toHaveBeenCalled();
  });
});
