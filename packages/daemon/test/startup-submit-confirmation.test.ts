import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
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

  function fixture(lostEnters: number | ReadonlySet<number>, runtime = "claude-code", challengeOnly = false, realDelivery = false) {
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
        if (typeof lostEnters === "number" ? ++enters > lostEnters : !lostEnters.has(++enters)) { submitted.push(composer); composer = ""; }
        return { ok: true as const }; // successful tmux command can still leave input staged
      }),
      capturePaneContent: vi.fn(async (_target: string, scrollback = 50): Promise<string | null> => {
        const screen = `Previous turn\n────────────────────\n❯ ${composer}\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n✔ Update installed · Restart to apply\n`;
        // tmux -S includes the selected scrollback plus the visible pane (24 rows here).
        return screen.split("\n").slice(-(scrollback + 24)).join("\n");
      }),
    };
    const role = Array.from({ length: 100 }, (_, i) => `Startup instruction ${i}: read the assigned project source.`).join("\n");
    const readFile = vi.fn((_path: string) => role);
    const sleep = vi.fn(async (_ms: number) => {});
    const nativeAdapter = new ClaudeCodeAdapter({ tmux: tmux as unknown as TmuxAdapter, sleep,
      fsOps: { readFile, writeFile: vi.fn(), exists: () => false, mkdirp: vi.fn(), copyFile: vi.fn(), homedir: "/fixture/home" } });
    const adapter = {
      runtime, project: vi.fn(async () => ({ projected: [], skipped: [], failed: [], warnings: [] as string[] })),
      deliverStartup: vi.fn(realDelivery ? nativeAdapter.deliverStartup.bind(nativeAdapter) : async () => ({ delivered: 0, failed: [] })),
      launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })),
    } as unknown as RuntimeAdapter;
    const orch = new StartupOrchestrator({ db, sessionRegistry: registry, eventBus,
      tmuxAdapter: tmux as unknown as TmuxAdapter, readFile, sleep });
    const start = (overrides: Partial<StartupInput> = {}) => orch.startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "binding", nodeId: node.id, tmuxSession: name, tmuxPane: "%1", tmuxWindow: null,
        cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture" },
      adapter, plan: { runtime: "claude-code", cwd: "/fixture", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: challengeOnly ? [] : [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: challengeOnly ? [{ type: "startup_proof", value: "authenticated", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }] : [{ type: "send_text", builtin: "session_identity", value: "OpenRig session identity: worker@startup-submit", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }],
      isRestore: false, ...overrides,
    });
    return { db, session, tmux, adapter, readFile, sleep, submitted, start, composer: () => composer };
  }

  const file = (name: string, required = true, deliveryHint = "send_text" as "send_text" | "auto" | "guidance_merge"): StartupInput["resolvedStartupFiles"][number] => ({
    path: name, absolutePath: `/fixture/${name}`, ownerRoot: "/fixture", deliveryHint, required, appliesOn: ["fresh_start", "restore"],
  });

  describe("remaining Claude startup files (#729)", () => {
    it("checks a lost Enter on each later file, with one paste per body and preserved order", async () => {
      // The actual Claude adapter delivers these files on the parent; a no-op mock would hide the gap.
      const f = fixture(new Set([2, 4]), "claude-code", false, true);
      f.readFile.mockImplementation(p => `Body of ${p}`);
      const result = await f.start({ resolvedStartupFiles: [file("first.md"), file("second.md"), file("third.md")] });
      expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(result.warnings).toBeUndefined();
      expect(f.tmux.sendText).toHaveBeenCalledTimes(3);
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(5);
      expect(f.submitted).toEqual(f.tmux.sendText.mock.calls.map(c => c[1]));
      expect(f.submitted[0]).toContain("first.md");
      expect(f.submitted.slice(1)).toEqual(["Body of /fixture/second.md", "Body of /fixture/third.md"]);
    });

    it.each(["send_text", "auto"] as const)("checks a single %s file without an identity action", async hint => {
      const f = fixture(1, "claude-code", false, true);
      expect(await f.start({ startupActions: [], resolvedStartupFiles: [file("role.md", true, hint)] })).toMatchObject({ ok: true });
      expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
      expect(f.submitted).toHaveLength(1);
    });

    it("keeps prelaunch delivery before harness launch and adds only the bounded check delay", async () => {
      const f = fixture(0, "claude-code", false, true);
      await f.start({ startupActions: [], resolvedStartupFiles: [file("CLAUDE.md", true, "guidance_merge"), file("role.md")] });
      expect(f.adapter.deliverStartup).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.adapter.deliverStartup).mock.calls[0]![0].map(f => f.path)).toEqual(["CLAUDE.md"]);
      expect(vi.mocked(f.adapter.deliverStartup).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.adapter.launchHarness).mock.invocationCallOrder[0]!);
      expect(f.sleep.mock.calls).toEqual([[200], [200]]);
      expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
    });

    it("checks remaining restore files after the existing bundled preload", async () => {
      const f = fixture(new Set([2]), "claude-code", false, true);
      f.readFile.mockImplementation(p => p);
      await f.start({ isRestore: true, skipHarnessLaunch: true, resumeToken: "fixture-original", resolvedStartupFiles: [file("first.md"), file("second.md")], startupActions: [
        { type: "send_text", value: "Restore context", phase: "after_ready", appliesOn: ["restore"], idempotent: true },
      ] });
      expect(f.tmux.sendText).toHaveBeenCalledTimes(2);
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(3);
      expect(f.submitted[0]).toContain("Restore context");
      expect(f.submitted[1]).toBe("/fixture/second.md");
    });

    it("keeps an earlier staged observation and other warnings after a later file clears", async () => {
      const f = fixture(new Set([1, 2]), "claude-code", false, true);
      f.readFile.mockImplementation(p => p);
      vi.mocked(f.adapter.project).mockResolvedValue({ projected: [], skipped: [], failed: [], warnings: ["Existing projection warning"] });
      const result = await f.start({ startupActions: [], resolvedStartupFiles: [file("first.md"), file("second.md")] });
      expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "staged" } });
      expect(result.warnings).toEqual(["Existing projection warning", expect.stringContaining("press Enter in that pane")]);
      expect(f.tmux.sendText).toHaveBeenCalledTimes(2);
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(3);
      expect(f.composer()).toBe("");
    });

    it.each(["null", "throw", "different"])("retains earlier %s uncertainty after a successful file without claiming staging", async mode => {
      const f = fixture(0, "claude-code", false, true);
      if (mode === "throw") f.tmux.capturePaneContent.mockRejectedValueOnce(new Error("capture unavailable"));
      else f.tmux.capturePaneContent.mockResolvedValueOnce(mode === "null" ? null : "❯ a different body\n────────────────────\n? for shortcuts");
      const result = await f.start({ startupActions: [], resolvedStartupFiles: [file("first.md"), file("second.md")] });
      expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "unverified" } });
      expect(result.warnings).toEqual([expect.stringContaining("Startup submission unverified")]);
      expect(result.warnings!.join()).not.toContain("press Enter");
      expect(f.tmux.sendText).toHaveBeenCalledTimes(2);
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])("preserves required=%s read failures and still attempts the following file", async required => {
      const f = fixture(0, "claude-code", false, true);
      f.readFile.mockImplementation(p => { if (p.endsWith("missing.md")) throw new Error("missing file"); return p; });
      const result = await f.start({ startupActions: [], resolvedStartupFiles: [file("missing.md", required), file("last.md")] });
      expect(result.ok).toBe(!required);
      if (!result.ok) expect(result.errors).toEqual(["Post-launch file delivery failed: missing.md: missing file"]);
      expect(f.submitted).toEqual(["/fixture/last.md"]);
    });

    it.each([false, true])("preserves required=%s transport errors and retains an earlier unknown observation", async required => {
      const f = fixture(0, "claude-code", false, true);
      f.tmux.capturePaneContent.mockResolvedValueOnce(null);
      const send = f.tmux.sendText.getMockImplementation()!;
      f.tmux.sendText.mockImplementationOnce(send).mockRejectedValueOnce(new Error("paste unavailable"));
      const result = await f.start({ startupActions: [], resolvedStartupFiles: [file("first.md"), file("bad.md", required)] });
      expect(result.ok).toBe(!required);
      expect(result.warnings).toEqual([expect.stringContaining("unverified")]);
      if (!result.ok) expect(result.errors).toEqual(["Post-launch file delivery failed: bad.md: paste unavailable"]);
      expect(f.tmux.sendText).toHaveBeenCalledTimes(2);
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    });

    it("leaves non-Claude remaining files with their adapter and no observation", async () => {
      const f = fixture(0, "codex", false, true);
      expect(await f.start({ startupActions: [], resolvedStartupFiles: [file("role.md")] })).toMatchObject({ ok: true });
      expect(f.adapter.deliverStartup).toHaveBeenCalledTimes(2);
      expect(f.tmux.capturePaneContent).not.toHaveBeenCalled();
      expect(f.tmux.sendKeys).toHaveBeenCalledTimes(1);
    });
  });

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

  // The Claude proof line follows only a startup prompt observed as submitted; it is never typed onto
  // pending input (controls from review50-r2's review of #719).
  const proofActions = (identity: boolean): StartupInput["startupActions"] => [
    ...(identity ? [{ type: "send_text" as const, builtin: "session_identity" as const, value: "OpenRig session identity: fixture", phase: "after_ready" as const, appliesOn: ["fresh_start" as const], idempotent: true }] : []),
    { type: "startup_proof", value: "authenticated", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
  ];
  for (const identity of [false, true]) {
    const path = identity ? "identity" : "challenge-only";
    for (const observation of ["unavailable", "mismatch"] as const) {
      it(`leaves an unconfirmed ${path} prompt pending and sends no proof line (${observation} capture)`, async () => {
        const f = fixture(1, "claude-code", !identity);
        f.tmux.capturePaneContent.mockResolvedValue(observation === "unavailable" ? null : "❯ [Pasted text #1]\n────────────────────\n? for shortcuts");
        const result = await f.start({ startupActions: proofActions(identity) });
        expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "unverified" } });
        expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
        expect(f.submitted).toHaveLength(0);
        expect(f.composer()).toBe(f.tmux.sendText.mock.calls[0]![1]);
        expect(result.ok && result.submission?.reasons).toContain("Startup proof instruction was not sent: the startup prompt was not confirmed submitted.");
      });
    }
    it(`sends the proof line as its own submission after a confirmed ${path} prompt`, async () => {
      const f = fixture(0, "claude-code", !identity);
      expect(await f.start({ startupActions: proofActions(identity) })).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(f.submitted).toHaveLength(2);
      expect(f.submitted[0]).toContain("startup orientation challenge");
      expect(f.submitted[1]).toBe(STARTUP_PROOF_INSTRUCTION_LINE);
    });
    it(`keeps a staged ${path} prompt pending and sends no proof line`, async () => {
      const f = fixture(Infinity, "claude-code", !identity);
      expect(await f.start({ startupActions: proofActions(identity) })).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "staged" } });
      expect(f.tmux.sendText).toHaveBeenCalledTimes(1);
      expect(f.submitted).toHaveLength(0);
    });
  }
  it("a Codex challenge stays one submission with no proof line", async () => {
    const f = fixture(0, "codex", true);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]).not.toContain(STARTUP_PROOF_INSTRUCTION_LINE);
  });
  it("without a challenge there is one submission and no proof line", async () => {
    const f = fixture(0);
    expect(await f.start()).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]).not.toContain(STARTUP_PROOF_INSTRUCTION_LINE);
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
