import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifyPaneActivity, communityHarnessPaneActivity, probeSessionActivity, SessionTransport } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

// OpenClaw2026.10.6 retained local refusal, with a synthetic conversation name.
// The text has several native emitters: it proves a refused turn, not a specific recovery-claim diagnosis.
const refusal = readFileSync(new URL("./fixtures/openclaw-local-turn-refused.txt", import.meta.url), "utf8");
const read = (screen: string, harness: string | null = "openclaw") =>
  communityHarnessPaneActivity(classifyPaneActivity(screen), harness, screen);

const needsAttention = { state: "attention", reason: "OpenClaw turn not recovered; inspect the pane before retrying" };

describe("an OpenClaw local turn that was not recovered", () => {
  it("reports the retained wrapped refusal, with inspection guidance instead of an automatic retry", () => {
    expect(read(refusal)).toMatchObject(needsAttention);
    expect(read(refusal).evidence).toContain('Session "agent:main:openrig-fixture" changed while starting work. Retry.');
  });

  it("reads a styled, unwrapped refusal through the same path", () => {
    expect(read(refusal.replace('Session\n "agent:main:openrig-fixture" changed while\n starting', 'Session "agent:main:openrig-fixture" changed while starting')
      .replace("local ready | error", "\x1b[31mlocal ready | error\x1b[0m"))).toMatchObject(needsAttention);
  });

  it.each([null, "claude-code", "pi", "synth", "openclaw-gateway"])("does not infer an OpenClaw refusal for %s", harness => {
    expect(read(refusal, harness).reason).not.toBe(needsAttention.reason);
  });

  it.each([
    refusal.replace("local ready | error", "local ready | idle"),
    refusal.replace("local ready | error", "gateway connected | error"),
    refusal.replace("starting work. Retry.", "starting work. Try again."),
    refusal.replace('run error: Session', 'quoted example: Session'),
    refusal.replace("agent main | session", "quoted output | session"),
    'Session "agent:main:openrig-fixture" changed while starting work. Retry.',
    refusal + "\nlocal ready | idle\nagent main | session openrig-fixture |",
    refusal + "\n⠋ Working (esc to interrupt)",
  ])("does not mistake history, another error or an incomplete frame for the current native refusal", screen => {
    expect(read(screen).reason).not.toBe(needsAttention.reason);
  });

  it("feeds the existing capture cache and invalidates on an unreadable pane", async () => {
    let content: string | null = refusal;
    const svc = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect(await svc.pollSeat("worker@team", undefined, "openclaw", "openclaw")).toMatchObject(needsAttention);
    expect(svc.getStructuralActivity("worker@team")).toMatchObject(needsAttention);
    content = null;
    expect(await svc.pollSeat("worker@team", undefined, "openclaw", "openclaw")).toBeNull();
    expect(svc.getStructuralActivity("worker@team")).toBeNull();
  });

  it("uses the same attention and guidance in a direct inventory-style probe", async () => {
    const activity = await probeSessionActivity({
      sessionName: "worker@team", runtime: "openclaw", communityHarness: "openclaw", attachmentType: "tmux",
      tmuxAdapter: { hasSession: async () => true, capturePaneContent: async () => refusal, getPaneCommand: async () => "openclaw" } as unknown as TmuxAdapter,
    });
    expect(activity).toMatchObject({ ...needsAttention, state: "needs_input" });
  });
});


const rule = "─".repeat(80);
const pastedError = [
  "Please explain this pasted error:",
  'run error: Session "agent:main:example" changed while starting work. Retry.',
  "local ready | error",
  "agent main | session example |",
  "openai/gpt-4o-mini | deliver:off | tokens 2.4k/128k (2%)",
].join("\n");

describe("OpenClaw footer boundaries and ordinary sends", () => {
  it.each(["local ready | idle", "gateway connected | idle"])("ignores a pasted refusal inside the editor below %s", footer => {
    const screen = [footer, "agent main | session actual | model | tokens 1/100", rule, pastedError, rule].join("\n");
    expect(read(screen).reason).not.toBe(needsAttention.reason);
  });

  it("does not select a nested full frame pasted inside a healthy editor", () => {
    const screen = ["local ready | idle", "agent main | session actual |", rule, refusal, rule].join("\n");
    expect(read(screen).reason).not.toBe(needsAttention.reason);
  });

  async function send(screen: string, runtime: string, selection: string | null) {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const rig = rigRepo.createRig("team");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime });
      const session = sessionRegistry.registerSession(node.id, "worker@team");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: "worker@team" });
      if (selection) sessionRegistry.recordCommunityHarnessSelection(session.id, selection);
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmuxAdapter = {
        hasSession: async () => true,
        probeSession: async () => ({ state: "present" as const }),
        capturePaneContent: async () => screen,
        getPaneCommand: async () => runtime,
        isPaneInMode: async () => false,
        sendText, sendKeys,
      } as unknown as TmuxAdapter;
      const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter, sleep: async () => {} });
      const result = await transport.send("worker@team", "A new turn");
      expect(result.ok).toBe(true);
      expect(sendText).toHaveBeenCalledWith("worker@team", "A new turn");
      expect(sendKeys).toHaveBeenCalledWith("worker@team", ["Enter"]);
      return result;
    } finally { db.close(); }
  }

  it("sends a new turn with the OpenClaw advisory from its recorded selection", async () => {
    const result = await send(refusal, "openclaw", "openclaw");
    expect(result.warning).toContain("OpenClaw refused its last local turn and OpenRig hasn't recovered it; this message submits a new turn.");
    expect(result.warning).toContain("rig capture worker@team");
    expect(result.warning).not.toContain("producer-link");
  });

  it.each([
    ["openclaw", null],
    ["other-harness", "other-harness"],
  ])("keeps a refusal-shaped send to %s without an OpenClaw advisory when selection is %s", async (runtime, selection) => {
    const result = await send(refusal, runtime!, selection);
    expect(result.warning).not.toContain("OpenClaw refused");
  });

  it.each(["openclaw", "other-harness"])("preserves existing idle send behavior for %s", async runtime => {
    const result = await send("❯ ", runtime, runtime);
    expect(result.warning).toBeUndefined();
  });
});
