// OBS1 (11-28): a fresh Claude can lose its first startup Enter while its paste hasn't drawn yet. The first look then finds
// the input box empty, which used to count as submitted, and ready was published with the prompt left staged. A seat that
// runs Claude's activity hooks now counts it submitted only on Claude's own UserPromptSubmit report, or looks again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { STARTUP_SUBMIT_EVIDENCE_WAIT_MS } from "../src/domain/startup-submission-evidence.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

type Scenario = {
  /** The seat's plan selects Claude's activity hooks. */
  hooks?: boolean;
  /** Claude's hooks report SessionStart at the first Enter. */
  sessionStart?: boolean;
  /** Claude reports UserPromptSubmit when it takes a prompt. */
  reports?: boolean;
  /** The first paste draws only by this capture (1-based): until then the box is empty and Enter is lost. */
  drawsAtCapture?: number;
  /** What the box shows when the late paste draws (default: our paste). */
  drawnInstead?: string;
};

describe("a fresh Claude start's first send waits for Claude's own report", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });

  function fixture({ hooks = true, sessionStart = true, reports = true, drawsAtCapture, drawnInstead }: Scenario) {
    const db = createFullTestDb(); dbs.push(db); db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
    const registry = new SessionRegistry(db), eventBus = new EventBus(db);
    const repo = new RigRepository(db), rig = repo.createRig("obs1");
    const node = repo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const name = "worker@obs1", session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const hook = (rawEvent: string) => eventBus.emit({ type: "agent.activity", rigId: rig.id, nodeId: node.id, sessionName: name, runtime: "claude-code",
      activity: { state: "running", reason: rawEvent, evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), rawEvent } } as never);
    let composer = "", pending: string | null = null, enters = 0, captures = 0;
    const submitted: string[] = [];
    const guard = new SeatDeliveryGuard(db, (target) => target === name || target === node.id
      ? { nodeId: node.id, session: name, occupant: null, pane: "%1" } : null);
    const tmux = {
      deliveryGuard: guard,
      probeSession: vi.fn(async () => ({ state: "present" as const })),
      listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: "/fixture", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "claude"),
      sendText: vi.fn(async (_name: string, text: string) => {
        if (drawsAtCapture !== undefined && pending === null && !submitted.length && !composer) pending = text; else composer += text;
        return { ok: true as const };
      }),
      sendKeys: vi.fn(async (_name: string, keys: string[]) => {
        expect(keys).toEqual(["Enter"]);
        if (++enters === 1 && sessionStart) hook("SessionStart");
        if (composer) { submitted.push(composer); composer = ""; if (reports) hook("UserPromptSubmit"); }
        return { ok: true as const };
      }),
      capturePaneContent: vi.fn(async (_target: string, scrollback = 50): Promise<string | null> => {
        if (pending !== null && ++captures >= drawsAtCapture!) { composer = drawnInstead ?? pending; pending = null; }
        const screen = `Previous turn\n────────────────────\n❯ ${composer}\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n`;
        return screen.split("\n").slice(-(scrollback + 24)).join("\n");
      }),
      capturePaneScreen: vi.fn(async () => `────────────────────\n❯ ${composer}\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n`),
    };
    const sleep = vi.fn(async (_ms: number) => {});
    const adapter = {
      runtime: "claude-code", project: vi.fn(async () => ({ projected: [], skipped: [], failed: [], warnings: [] as string[] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })),
    } as unknown as RuntimeAdapter;
    const orch = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus, tmuxAdapter: tmux as unknown as TmuxAdapter,
      readFile: () => "", sleep, listProcesses: async () => [] });
    const entries = hooks ? [{ category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "claude-activity-hooks" }] : [];
    const start = (overrides: Partial<StartupInput> = {}) => orch.startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "binding", nodeId: node.id, tmuxSession: name, tmuxPane: "%1", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture" },
      adapter, plan: { runtime: "claude-code", cwd: "/fixture", entries, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as unknown as StartupInput["plan"],
      resolvedStartupFiles: [],
      startupActions: [{ type: "send_text", builtin: "session_identity", value: "OpenRig session identity: worker@obs1", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }],
      isRestore: false, ...overrides,
    });
    return { start, tmux, sleep, submitted, composer: () => composer, unsent: () => composer || pending || "", enters: () => enters };
  }

  const waits = (sleep: ReturnType<typeof vi.fn>) => sleep.mock.calls.filter(([ms]) => ms === 100).length;

  it("the reported failure, repaired: an Enter lost before the paste drew is retried once the prompt shows, and ready follows Claude's report", async () => {
    const f = fixture({ drawsAtCapture: 2 });
    const result = await f.start();
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect((result as { submission?: unknown }).submission).toBeUndefined();
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]).toContain("OpenRig session identity");
    expect(f.composer()).toBe("");
    expect(f.enters()).toBe(2);                       // the lost Enter, then one guarded retry; nothing is pasted twice
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(waits(f.sleep)).toBe(STARTUP_SUBMIT_EVIDENCE_WAIT_MS / 100);
  });

  it("a prompt Claude reports taking is confirmed at once, with no extra wait or look", async () => {
    const f = fixture({});
    const result = await f.start();
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect((result as { submission?: unknown }).submission).toBeUndefined();
    expect(waits(f.sleep)).toBe(0);
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(1);
  });

  it("an empty box without Claude's report, from a seat whose hooks run, makes ready say the submission is unverified", async () => {
    const f = fixture({ reports: false });
    const result = await f.start() as { ok: boolean; startupStatus: string; submission?: { status: string; reasons: string[] } };
    expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "unverified" } });
    expect(result.submission!.reasons.join(" ")).toContain("Claude did not report taking the prompt");
    expect(f.enters()).toBe(1);
  });

  it("a seat that selected the hooks but reports nothing keeps the empty box's reading after looking again", async () => {
    const f = fixture({ sessionStart: false, reports: false });
    const result = await f.start();
    expect((result as { submission?: unknown }).submission).toBeUndefined();
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(2);
  });

  it("a seat without the hooks keeps today's single look (the remaining limit)", async () => {
    const f = fixture({ hooks: false, drawsAtCapture: 2 });
    const result = await f.start();
    expect((result as { submission?: unknown }).submission).toBeUndefined();
    expect(waits(f.sleep)).toBe(0);
    expect(f.unsent()).toContain("OpenRig session identity");   // still unsent: no report to wait for on this seat
  });

  it("a person's text in the box when it draws is never submitted", async () => {
    const f = fixture({ drawsAtCapture: 2, drawnInstead: "a person's draft" });
    const result = await f.start() as { submission?: { status: string; reasons: string[] } };
    expect(result.submission).toMatchObject({ status: "unverified" });
    expect(f.enters()).toBe(1);
    expect(f.composer()).toBe("a person's draft");
    expect(f.submitted).toEqual([]);
  });
});
