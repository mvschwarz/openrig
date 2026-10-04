import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { startupSubmissionEvidence } from "../src/domain/startup-submission-evidence.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { STARTUP_PROOF_INSTRUCTION_LINE } from "../src/domain/startup-proof.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// A mockable wrapper is needed because native ESM namespace exports are immutable.
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>() }));

describe("startup prompt submission", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });

  function fixture(lostEnters: number, runtime = "claude-code", challengeOnly = false) {
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
    const start = (overrides: Partial<StartupInput> = {}) => orch.startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "binding", nodeId: node.id, tmuxSession: name, tmuxPane: "%1", tmuxWindow: null,
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture" },
      adapter, plan: { runtime: "claude-code", cwd: "/fixture", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: challengeOnly ? [] : [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: challengeOnly ? [{ type: "startup_proof", value: "authenticated", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }] : [{ type: "send_text", builtin: "session_identity", value: "OpenRig session identity: worker@startup-submit", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }],
      isRestore: false, ...overrides,
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
    const event = f.db.prepare("SELECT payload FROM events WHERE type = 'node.startup_ready'").get() as { payload: string };
    expect(JSON.parse(event.payload).submission).toBeUndefined();
  });

  it("does not retry a normal submission", async () => {
    const f = fixture(0);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.submitted).toHaveLength(1);
  });

  it("keeps startup ready with an actionable staged warning after one retry", async () => {
    const f = fixture(Infinity);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "staged", warning: expect.stringContaining("press Enter in that pane") } });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(f.submitted).toEqual([]);
    expect(f.db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(f.session.id)).toEqual({ startup_status: "ready" });
  });

  it("uses the guarded recheck when the composer changes before the retry", async () => {
    const f = fixture(Infinity);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture)
      .mockResolvedValueOnce("A different question\n❯ 1. Continue\n  2. Cancel\n");
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "staged" } });
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
    expect(JSON.parse(event.payload).submission).toMatchObject({ status: "unverified", reasons: [expect.stringContaining("capture is unavailable")],
      diagnostics: [{ retry: "not_run", observations: [{ phase: "initial", observed: null, firstDifferenceByte: null }] }] });
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

  it.each(["initial", "guarded recheck"])("does not retry a different body sharing the startup header at %s", async (point) => {
    const f = fixture(Infinity);
    const original = f.tmux.capturePaneContent.getMockImplementation()!;
    const different = "❯ OpenRig session identity: worker@startup-submit\nA different body, left for the operator.\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n";
    f.tmux.capturePaneContent.mockResolvedValue(different);
    if (point === "guarded recheck") f.tmux.capturePaneContent.mockImplementationOnce(original);
    const result = await f.start();
    expect(result).toMatchObject({ ok: true, submission: { status: "unverified" } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
  });

  it("does not retry a stale echo with no current composer", async () => {
    const f = fixture(0);
    f.tmux.capturePaneContent.mockImplementation(async () => `❯ ${f.submitted[0]}\nWorking…\nEsc to interrupt\n`);
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified" } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.submitted).toHaveLength(1);
  });

  it("does not treat a matching echo ending in a rule without composer footer as staged", async () => {
    const f = fixture(0);
    f.tmux.capturePaneContent.mockImplementation(async () => `❯ ${f.submitted[0]}\n────────────────────\nWorking… Esc to interrupt\n`);
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified" } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("follows a submitted challenge-only prompt with the short proof line", async () => {
    const f = fixture(0, "claude-code", true);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(2);
    expect(f.submitted).toHaveLength(2);
    expect(f.submitted[0]).toContain("startup orientation challenge");
    expect(f.submitted[1]).toBe(STARTUP_PROOF_INSTRUCTION_LINE);
  });

  it("keeps a staged challenge-only prompt best-effort", async () => {
    const f = fixture(Infinity, "claude-code", true);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "staged" } });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
  });

  it("leaves the non-Claude startup path unchanged", async () => {
    const f = fixture(0, "codex");
    f.tmux.capturePaneContent.mockResolvedValue(null);
    expect(await f.start()).toMatchObject({ ok: true });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  const screen = (body: string) => `Previous turn\n❯ ${body}\n────────────────────\n? for shortcuts`;
  const digest = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex") });

  it.each(["initial", "after_retry"])("labels an unrecognized composer boundary at %s without changing submission", async (phase) => {
    const f = fixture(phase === "initial" ? 0 : 1);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockResolvedValue("Previous turn\n❯ \n────────────────────\nOther footer\n");
    if (phase === "after_retry") f.tmux.capturePaneContent.mockImplementationOnce(capture).mockImplementationOnce(capture);
    const reason = phase === "initial"
      ? "Startup submission is unverified: the current composer boundary was not recognized."
      : "Startup submission is unverified after the guarded retry: the current composer boundary was not recognized.";
    const result = await f.start();
    const event = f.db.prepare("SELECT payload FROM events WHERE type = 'node.startup_ready'").get() as { payload: string };
    const submission = JSON.parse(event.payload).submission;
    expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission });
    expect(submission).toMatchObject({ status: "unverified", reasons: [reason], diagnostics: [{
      retry: phase === "initial" ? "not_run" : "ok",
      observations: [{ phase, reason: "unrecognized_composer_boundary", markerLine: 2,
        closingRuleLine: null, observed: null, firstDifferenceByte: null }],
    }] });
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(phase === "initial" ? 1 : 3);
    expect(f.submitted).toHaveLength(1);
  });

  it("persists exact synthetic mismatch evidence without another Enter or capture", async () => {
    const f = fixture(Infinity);
    f.tmux.capturePaneContent.mockResolvedValue(screen("X ä\n b"));
    const result = await f.start();
    const event = f.db.prepare("SELECT payload FROM events WHERE type = 'node.startup_ready'").get() as { payload: string };
    const submission = JSON.parse(event.payload).submission;
    expect(result).toMatchObject({ ok: true, submission });
    expect(submission.reasons).toEqual(["Startup submission is unverified: the current composer does not positively match the complete prompt."]);
    expect(submission.diagnostics).toEqual([{
      startupAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/), sendOrder: 1, source: "initial_identity", retry: "not_run",
      observations: [{ phase: "initial", reason: "extracted_text_mismatch", normalization: "whitespace-stripped-utf8",
        expected: digest(f.tmux.sendText.mock.calls[0]![1].replace(/\s+/g, "")), observed: digest("Xäb"),
        firstDifferenceByte: 0, markerLine: 2, closingRuleLine: 4, capturedLines: 5,
        captureScrollbackLines: 200, windowsOmitted: "unclassified-startup-text" }],
    }]);
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("retains the guarded recheck mismatch even if the final composer is clear", async () => {
    const f = fixture(Infinity);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture)
      .mockResolvedValueOnce(screen("different text")).mockResolvedValueOnce(screen(""));
    expect(await f.start()).toMatchObject({ ok: true, submission: { diagnostics: [{
      retry: "refused_or_failed", observations: [{ phase: "guarded_retry", reason: "extracted_text_mismatch", observed: digest("differenttext") }],
    }] } });
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(3);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("distinguishes retry transport success from an unavailable final observation", async () => {
    const f = fixture(1);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture).mockImplementationOnce(capture).mockResolvedValueOnce(null);
    expect(await f.start()).toMatchObject({ ok: true, submission: { status: "unverified", diagnostics: [{
      retry: "ok", observations: [{ phase: "after_retry", observed: null }],
    }] } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
  });

  it("retains a thrown precheck when the delivery guard converts it to a failure", async () => {
    const f = fixture(Infinity);
    const capture = f.tmux.capturePaneContent.getMockImplementation()!;
    f.tmux.capturePaneContent.mockImplementationOnce(capture).mockRejectedValueOnce(new Error("unavailable"));
    expect(await f.start()).toMatchObject({ ok: true, submission: { diagnostics: [{
      retry: "refused_or_failed", observations: [{ phase: "guarded_retry", observed: null }],
    }] } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("identifies sequential sends and omits credential-capable text from every diagnostic", async () => {
    const f = fixture(Infinity);
    const secret = "synthetic-private-credential-do-not-record";
    f.tmux.capturePaneContent.mockResolvedValue(screen(`other ${secret}`));
    const actions: StartupInput["startupActions"] = [
      { type: "send_text", value: `OpenRig session identity: ${secret}`, builtin: "session_identity", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
      { type: "send_text", value: `after files ${secret}`, phase: "after_files", appliesOn: ["fresh_start"], idempotent: true },
      { type: "send_text", value: `after ready ${secret}`, phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
    ];
    const result = await f.start({ startupActions: actions });
    if (!result.ok) throw new Error("fixture did not start");
    const diagnostics = result.submission!.diagnostics!;
    expect(diagnostics.map(({ sendOrder, source, actionIndex }) => ({ sendOrder, source, actionIndex }))).toEqual([
      { sendOrder: 1, source: "initial_identity", actionIndex: undefined },
      { sendOrder: 2, source: "after_files", actionIndex: 1 },
      { sendOrder: 3, source: "after_ready", actionIndex: 2 },
    ]);
    expect(new Set(diagnostics.map(d => d.startupAttemptId)).size).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(diagnostics.every(d => d.observations.every(o => o.windowsOmitted === "unclassified-startup-text"))).toBe(true);
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(3);
  });

  it("retains earlier evidence if a later action fails startup", async () => {
    const f = fixture(Infinity);
    f.tmux.capturePaneContent.mockResolvedValue(null);
    const send = f.tmux.sendText.getMockImplementation()!;
    f.tmux.sendText.mockImplementationOnce(send).mockRejectedValueOnce(new Error("later action failed"));
    const actions: StartupInput["startupActions"] = [
      { type: "send_text", value: "OpenRig session identity: fixture", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
      { type: "send_text", value: "later", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
    ];
    expect(await f.start({ startupActions: actions })).toMatchObject({ ok: false, startupStatus: "failed" });
    const event = f.db.prepare("SELECT payload FROM events WHERE type = 'node.startup_failed'").get() as { payload: string };
    expect(JSON.parse(event.payload).submissionDiagnostics).toMatchObject([{ sendOrder: 1, retry: "not_run", observations: [{ observed: null }] }]);
  });

  it("keeps diagnostics bounded for a large synthetic prompt and uses UTF-8 byte offsets", () => {
    const body = "ä" + "x".repeat(200_000);
    const evidence = startupSubmissionEvidence(screen(body), "äy" + "x".repeat(200_000), 200)!;
    expect(evidence.firstDifferenceByte).toBe(2);
    expect(evidence.observed).toEqual(digest(body));
    expect(evidence.expected.bytes).toBe(200_003);
    expect(JSON.stringify(evidence).length).toBeLessThan(700);
    expect(JSON.stringify(evidence)).not.toContain("xxxxx");
    const selector = startupSubmissionEvidence("❯ 1. Continue\n────────────────────\n? for shortcuts", "1. Continue", 200)!;
    expect(selector.observed).toBeNull();
    expect(selector.reason).toBeUndefined();
    expect(startupSubmissionEvidence(null, "expected", 200)?.reason).toBeUndefined();
  });

  it("ignores a failing diagnostic sink without changing the guard verdict", async () => {
    const f = fixture(Infinity);
    f.tmux.capturePaneContent.mockResolvedValue(screen("different composer"));
    const sink = vi.fn(() => { throw new Error("diagnostic sink unavailable"); });
    const transport = new SessionTransport({ db: f.db, rigRepo: new RigRepository(f.db),
      sessionRegistry: new SessionRegistry(f.db), eventBus: new EventBus(f.db), tmuxAdapter: f.tmux as unknown as TmuxAdapter });
    expect(await transport.send("worker@startup-submit", "", {
      submitOnly: true, requireFullStagedText: true, expectedStagedText: "original composer", onStartupMismatch: sink,
    })).toMatchObject({ ok: false, reason: "staged_mismatch" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(f.tmux.sendText).not.toHaveBeenCalled();
    expect(f.tmux.sendKeys).not.toHaveBeenCalled();
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(1);
  });

  it("does not change the delivery verdict when diagnostic hashing fails", async () => {
    const f = fixture(Infinity);
    f.tmux.capturePaneContent.mockResolvedValue(screen("different composer"));
    vi.spyOn(crypto, "createHash").mockImplementation(() => { throw new Error("diagnostic failure"); });
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "unverified" } });
    expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.tmux.capturePaneContent).toHaveBeenCalledTimes(1);
  });

});
