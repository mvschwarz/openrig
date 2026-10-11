import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("agent pane activity classifier", () => {
  it("classifies active Working pane as agent_active", () => {
    const result = classifyPaneActivity("Working on task...\n⠋ Processing files\nesc to interrupt");

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
  });

  it("classifies numbered runtime prompts as attention, not idle", () => {
    const result = classifyPaneActivity([
      "› 1. Yes, continue",
      "  2. No, cancel",
      "",
      "  Press enter to continue",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("selection_prompt");
  });

  it("classifies numbered runtime prompts with a Codex footer as attention, not idle", () => {
    const result = classifyPaneActivity([
      "Some runtime update requires a choice.",
      "",
      "› 1. Update now",
      "  2. Skip this version",
      "  3. Remind me later",
      "",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("selection_prompt");
  });

  it("classifies idle Codex footer at the bottom as agent_idle", () => {
    const result = classifyPaneActivity([
      "› Summarize recent commits",
      "",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  // Codex 0.157 (measured on 0.157.1): empty composer shows a fixed placeholder and the footer
  // is the same idle and mid-turn; the Working/esc-to-interrupt row tells them apart when shown
  // (Codex hides it while streaming — the send path guards that case, see send-prompt-guard tests).
  it("classifies an idle Codex 0.157 composer placeholder as agent_idle", () => {
    const result = classifyPaneActivity([
      "  Tip: You can resume a previous conversation by running codex resume",
      "› Ask Codex to do anything",
      "  GPT-5.5 medium · ~/code/projects/openrig · Verify assigned outcome",
      "  ← for agents · ? for shortcuts                       ⚠ 1 warning · f2 to view",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_prompt");
  });

  it("keeps a working Codex 0.157 pane with the same placeholder and footer as agent_active", () => {
    const result = classifyPaneActivity([
      "◦ Working (11s • esc to interrupt) · 1 background terminal running · /ps to view",
      "› Ask Codex to do anything",
      "  GPT-5.5 medium · ~/code/projects/openrig · Verify assigned outcome",
      "  ← for agents · ? for shortcuts                       ⚠ 1 warning · f2 to view",
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
  });

  // Codex 0.158 (redacted live pane tails): same placeholder, footer is a status line plus
  // `? for shortcuts`. Its Working row can sit well above the composer, past the 8-line window,
  // when queued or incoming message blocks come in between.
  const CODEX_0158_FOOTER = [
    "› Ask Codex to do anything",
    "",
    "  gpt-6-sol high · ~/code/projects/openrig · Read the task",
    "  ? for shortcuts                                     ⚠ 3 warnings · f2 to view",
  ];

  it("classifies an idle Codex 0.158 composer placeholder as agent_idle", () => {
    const result = classifyPaneActivity([
      "• Done. The change is committed and the tests pass.",
      "",
      "  5:47 PM",
      "",
      "",
      ...CODEX_0158_FOOTER,
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_prompt");
  });

  it("keeps a working Codex 0.158 pane as agent_active", () => {
    const result = classifyPaneActivity([
      "• Working (1h 09m 39s • esc to interrupt)",
      "  └ Tip: Use /title to choose what appears in your terminal's title.",
      "",
      "",
      ...CODEX_0158_FOOTER,
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
  });

  it("reads the Codex placeholder as active when its Working row sits more than 8 lines above it", () => {
    const result = classifyPaneActivity([
      "• Working (1h 09m 39s • esc to interrupt)",
      "  └ Tip: Use /title to choose what appears in your terminal's title.",
      "",
      ...Array.from({ length: 10 }, (_, i) => `  incoming message line ${i + 1}`),
      "",
      ...CODEX_0158_FOOTER,
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
    expect(result.evidence).toBe("• Working (1h 09m 39s • esc to interrupt)");
  });

  it("keeps completed Working prose more than 8 lines above the placeholder as history: idle", () => {
    for (const prose of ["• Working directory: /tmp/project", "• Working tree is clean."]) {
      const result = classifyPaneActivity([
        prose,
        ...Array.from({ length: 10 }, (_, i) => `  output line ${i + 1}`),
        "",
        ...CODEX_0158_FOOTER,
      ].join("\n"));

      expect(result.state, prose).toBe("agent_idle");
      expect(result.reason, prose).toBe("idle_prompt");
    }
  });

  it("reads a far turn-status row with a reasoning-summary header as active", () => {
    const result = classifyPaneActivity([
      "• Exploring the test fixtures (2m 03s • esc to interrupt)",
      ...Array.from({ length: 10 }, (_, i) => `  incoming message line ${i + 1}`),
      "",
      ...CODEX_0158_FOOTER,
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.evidence).toBe("• Exploring the test fixtures (2m 03s • esc to interrupt)");
  });

  it("still reads a bare prompt with stale Working text beyond the 8-line window as idle", () => {
    const result = classifyPaneActivity([
      "◦ Working (9m 26s • esc to interrupt)",
      ...Array.from({ length: 10 }, (_, i) => `  output line ${i + 1}`),
      "❯ ",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_prompt");
  });

  it("does not treat typed Codex 0.157 composer text as the idle placeholder", () => {
    const result = classifyPaneActivity([
      "› run the test suite and report",
      "  GPT-5.5 medium · ~/code/projects/openrig · Verify assigned outcome",
      "  ← for agents · ? for shortcuts",
    ].join("\n"));

    expect(result.state).not.toBe("agent_idle");
  });

  it("classifies idle Claude edit-accept footer at the bottom as agent_idle", () => {
    const result = classifyPaneActivity([
      "❯ ",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  it("classifies typed Claude prompt text above an idle footer as attention, not idle", () => {
    const result = classifyPaneActivity([
      "❯ I am still typing a message",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("prompt_draft");
    expect(result.evidence).toContain("still typing");
  });

  it("does not treat a prior submitted Codex prompt separated from the footer by a blank as a draft", () => {
    const result = classifyPaneActivity([
      "› Summarize recent commits",
      "",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  it("does not classify stale active scrollback as active when current idle footer is below it", () => {
    const result = classifyPaneActivity([
      "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
      "",
      "› Use /skills to list available skills",
      "",
      "  gpt-5.5 xhigh fast · Context [█▉   ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
  });

  it.each([
    "✶ Synthesizing… (6s · ↑ 284 tokens · thinking)",
    "✢ Reviewing... (3s · ↓ 107 tokens · thinking)",
  ])("classifies Claude Code thinking status as agent_active without depending on the status verb: %s", (statusLine) => {
    const result = classifyPaneActivity([
      "⏺ Skill(openrig-user)",
      "  ⎿  Successfully loaded skill",
      "",
      statusLine,
      "",
      "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
      "❯ ",
      "────────────────────────────────────────────────────────────────────────────────",
      "  paste again to expand                                      ◉ xhigh · /effort",
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
    expect(result.evidence).toContain("thinking");
  });

  it("does not classify tmux focus-events guidance as idle", () => {
    const result = classifyPaneActivity("tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach");

    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("no_activity_signal");
  });

  it("does not classify stale idle footer as idle when current active work is below it", () => {
    const result = classifyPaneActivity([
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
      "",
      "• Reading 1 file...",
      "",
      "◦ Working (0m 3s • esc to interrupt)",
    ].join("\n"));

    expect(result.state).toBe("agent_active");
  });

  it("classifies empty capture as unknown", () => {
    const result = classifyPaneActivity("\n\n");

    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("empty_capture");
  });
});

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
  isPaneInMode: (paneId: string) => Promise<boolean | null>;
}>): TmuxAdapter {
  const hasSession = overrides?.hasSession ?? (async () => true);
  return {
    hasSession,
    // Derived classified probe (OPR.0.5.4.2): present/absent from the mock's
    // hasSession; a throwing hasSession propagates (the fail-closed class).
    probeSession: async (name: string) =>
      (await hasSession(name)) ? { state: "present" as const } : { state: "absent" as const },
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle prompt\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
    isPaneInMode: overrides?.isPaneInMode ?? (async () => false),
  } as unknown as TmuxAdapter;
}

describe("SessionTransport", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTransport(tmux?: TmuxAdapter, overrides?: {
    agentActivityStore?: AgentActivityStore;
    sleep?: (ms: number) => Promise<void>;
    waitForIdlePollMs?: number;
    now?: () => Date;
  }) {
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      ...overrides,
    });
  }

  function seedCanonicalRig() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
    return { rig, node, session };
  }

  function seedLegacyRig() {
    const rig = rigRepo.createRig("r00-legacy");
    const node = rigRepo.addNode(rig.id, "worker-a", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "r00-legacy-worker-a");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r00-legacy-worker-a" });
    return { rig, node, session };
  }

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", {
      role: "orchestrator",
      runtime: "claude-code",
    });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
    return { rig, node, session };
  }

  // Test 1: send calls sendText -> delay -> sendKeys Enter
  it("send calls sendText then sendKeys Enter with delay", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    const tmux = mockTmux({
      sendText: async () => { callOrder.push("sendText"); return { ok: true }; },
      sendKeys: async (_t, keys) => { callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["sendText", "sendKeys:Enter"]);
  });

  describe("#331: pane in tmux copy mode", () => {
    it("refuses before typing anything, since copy mode would swallow the Enter", async () => {
      seedCanonicalRig();
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const transport = createTransport(mockTmux({ sendText, sendKeys, isPaneInMode: async () => true }));

      const result = await transport.send("dev-impl@my-rig", "hello");
      expect(result).toMatchObject({ ok: false, reason: "pane_in_mode", sent: false });
      expect(result.error).toContain("copy mode");
      expect(result.error).toContain("No text was sent.");
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("refuses a submitOnly Enter while the pane is in copy mode", async () => {
      seedCanonicalRig();
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const transport = createTransport(mockTmux({
        sendKeys,
        capturePaneContent: async () => "❯ staged message",
        isPaneInMode: async () => true,
      }));

      const result = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: "staged message" });
      expect(result).toMatchObject({ ok: false, reason: "pane_in_mode" });
      expect(result.error).toContain("Nothing was submitted.");
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("sends as before when the mode is unknown", async () => {
      seedCanonicalRig();
      const callOrder: string[] = [];
      const transport = createTransport(mockTmux({
        sendText: async () => { callOrder.push("sendText"); return { ok: true }; },
        sendKeys: async (_t, keys) => { callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
        isPaneInMode: async () => null,
      }));

      const result = await transport.send("dev-impl@my-rig", "hello");
      expect(result.ok).toBe(true);
      expect(callOrder).toEqual(["sendText", "sendKeys:Enter"]);
    });
  });

  // Test 2: send to canonical session name resolves correctly
  it("send to canonical session name resolves correctly", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "message");
  });

  // Test 3: send to legacy session name resolves correctly
  it("send to legacy session name resolves correctly", async () => {
    seedLegacyRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("r00-legacy-worker-a", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("r00-legacy-worker-a", "message");
  });

  // Test 4: send to missing session returns error with guidance
  it("send to missing session returns error with guidance", async () => {
    const tmux = mockTmux({ hasSession: async () => false });
    const transport = createTransport(tmux);

    const result = await transport.send("nonexistent", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session_missing");
    expect(result.error).toContain("not found");
    expect(result.error).toContain("rig ps");
  });

  // Test 5: send where sendKeys Enter fails returns "text visible but not submitted"
  it("send where Enter fails returns submit_failed with guidance", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("submit_failed");
    expect(result.error).toContain("visible");
    expect(result.error).toContain("not submitted");
  });

  // Test 6: send with verify captures pane and checks for text
  it("send with verify checks pane for sent text", async () => {
    seedCanonicalRig();
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        return captureCount < 3 ? "some output\n❯ " : "some output\nhello\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // OPR.99.0.6.3: a confirmed render is the strong positive outcome.
    expect(result.outcome).toBe("delivered");
  });

  it("send with verify does not false-positive on pre-existing pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    // OPR.99.0.6.3: text + Enter both succeeded, only the render re-confirm
    // missed — the honest middle, NOT a failure.
    expect(result.outcome).toBe("rendered-unconfirmed");
  });

  // OPR.99.0.6.3 — honest delivery-outcome vocabulary
  it("verify capture throwing after a successful send is the middle outcome, not a failure", async () => {
    seedCanonicalRig();
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        // Pre-verify + mid-work captures succeed; the post-send verify capture throws
        // (e.g. pane busy mid-redraw).
        if (captureCount >= 3) throw new Error("pane busy");
        return "some output\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("rendered-unconfirmed");
  });

  it("DISCRIMINATOR: a redraw-race send and a genuine transport failure surface differently", async () => {
    seedCanonicalRig();
    // Redraw-race: send + submit succeed, post-capture cannot re-confirm.
    const racyTmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const middle = await createTransport(racyTmux).send("dev-impl@my-rig", "hello", { verify: true });

    // Genuine transport failure: Enter does not land.
    const brokenTmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const failure = await createTransport(brokenTmux).send("dev-impl@my-rig", "hello", { verify: true });

    // The acceptance criterion: the two states are NOT equal in surfaced outcome.
    expect(middle.ok).toBe(true);
    expect(middle.outcome).toBe("rendered-unconfirmed");
    expect(failure.ok).toBe(false);
    expect(failure.outcome).toBe("failed");
    expect(middle.outcome).not.toBe(failure.outcome);
  });

  it("send_failed and submit_failed carry outcome 'failed' (vocabulary symmetry, ok:false unchanged)", async () => {
    seedCanonicalRig();
    const noPaste = mockTmux({
      sendText: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    });
    const sendFailed = await createTransport(noPaste).send("dev-impl@my-rig", "hello");
    expect(sendFailed.ok).toBe(false);
    expect(sendFailed.reason).toBe("send_failed");
    expect(sendFailed.outcome).toBe("failed");

    const noEnter = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    });
    const submitFailed = await createTransport(noEnter).send("dev-impl@my-rig", "hello");
    expect(submitFailed.ok).toBe(false);
    expect(submitFailed.reason).toBe("submit_failed");
    expect(submitFailed.outcome).toBe("failed");
  });

  it("send without verify carries no outcome field (additive, verify-scoped)", async () => {
    seedCanonicalRig();
    const transport = createTransport(mockTmux());
    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(result.outcome).toBeUndefined();
  });

  // Test 7: send with mid-work detected → DELIVER WITH ADVISORY (OPR.0.4.3.28 fast-follow —
  // mid_work downgraded from a hard refuse to a non-blocking advisory; busy is not a block).
  it("send with mid-work detected DELIVERS with a non-blocking advisory (not a refusal)", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing files\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("mid-task");
    expect(result.warning).toContain("busy is advisory");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  // Test 8: --force on a mid-work pane still sends (now a back-compat no-op — the default path
  // already delivers-with-advisory, so --force changes nothing but must not break).
  it("send with mid-work + force still sends anyway (--force is a back-compat no-op now)", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { force: true });
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send with wait-for-idle waits through running pane activity and sends after idle", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    let captureCount = 0;
    const sendTextSpy = vi.fn(async () => {
      callOrder.push("sendText");
      return { ok: true as const };
    });
    const tmux = mockTmux({
      capturePaneContent: async () => {
        callOrder.push("capture");
        captureCount++;
        return captureCount === 1
          ? "Working on task...\n⠋ Processing files\nesc to interrupt"
          : "› Use /skills to list available skills\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig";
      },
      sendText: sendTextSpy,
      sendKeys: async () => {
        callOrder.push("sendKeys");
        return { ok: true as const };
      },
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "hello");
    expect(callOrder).toEqual(["capture", "capture", "sendText", "sendKeys"]);
  });

  it("send with wait-for-idle waits through current Claude thinking evidence and sends after idle", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    let captureCount = 0;
    const sendTextSpy = vi.fn(async () => {
      callOrder.push("sendText");
      return { ok: true as const };
    });
    const tmux = mockTmux({
      capturePaneContent: async () => {
        callOrder.push("capture");
        captureCount++;
        return captureCount === 1
          ? [
              "⏺ Skill(openrig-user)",
              "  ⎿  Successfully loaded skill",
              "",
              "✶ Synthesizing… (6s · ↑ 284 tokens · thinking)",
              "",
              "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
              "❯ ",
              "────────────────────────────────────────────────────────────────────────────────",
              "  paste again to expand                                      ◉ xhigh · /effort",
            ].join("\n")
          : [
              "Ready for QA.",
              "",
              "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
              "❯ ",
              "────────────────────────────────────────────────────────────────────────────────",
              "  paste again to expand                                      ◉ xhigh · /effort",
            ].join("\n");
      },
      sendText: sendTextSpy,
      sendKeys: async () => {
        callOrder.push("sendKeys");
        return { ok: true as const };
      },
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "hello");
    expect(callOrder).toEqual(["capture", "capture", "sendText", "sendKeys"]);
  });

  it.each([0, 5])("send with wait-for-idle times out on running activity without sending text (capture cost %ims)", async (captureCostMs) => {
    seedCanonicalRig();
    // These cases test expiry AFTER a running observation, not classification speed.
    // Freeze both the deadline clock and its race timer; advance only at the poll.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({
        capturePaneContent: async () => {
          const end = performance.now() + captureCostMs;
          while (performance.now() < end) { /* controlled classification CPU cost */ }
          return "Working on task...\n⠋ Processing files\nesc to interrupt";
        },
        sendText: sendTextSpy,
      });
      const sleep = vi.fn(async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); });
      const transport = createTransport(tmux, { sleep, waitForIdlePollMs: 1 });

      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("wait_for_idle_timeout");
      expect(result.sent).toBe(false);
      expect(result.activity?.state).toBe("running");
      expect(sendTextSpy).not.toHaveBeenCalled();
      expect(result.attempts).toBe(2);
      expect(result.waitedMs).toBe(1);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 5])("send with wait-for-idle times out on persistent Claude thinking evidence without sending text (capture cost %ims)", async (captureCostMs) => {
    seedCanonicalRig();
    // These cases test expiry AFTER a running observation, not classification speed.
    // Freeze both the deadline clock and its race timer; advance only at the poll.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({
        capturePaneContent: async () => {
          const end = performance.now() + captureCostMs;
          while (performance.now() < end) { /* controlled classification CPU cost */ }
          return [
            "⏺ Skill(openrig-user)",
            "  ⎿  Initializing…",
            "",
            "✢ Reviewing... (3s · ↓ 107 tokens · thinking)",
            "",
            "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
            "❯ ",
            "────────────────────────────────────────────────────────────────────────────────",
            "  paste again to expand                                      ◉ xhigh · /effort",
          ].join("\n");
        },
        sendText: sendTextSpy,
      });
      const sleep = vi.fn(async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); });
      const transport = createTransport(tmux, { sleep, waitForIdlePollMs: 1 });

      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("wait_for_idle_timeout");
      expect(result.sent).toBe(false);
      expect(result.activity?.state).toBe("running");
      expect(sendTextSpy).not.toHaveBeenCalled();
      expect(result.attempts).toBe(2);
      expect(result.waitedMs).toBe(1);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("send with wait-for-idle hard-stops on attention prompts without sending text", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Codex update available.",
        "",
        "› 1. Update now",
        "  2. Skip this version",
        "  3. Remind me later",
        "",
        "  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("needs_input");
    expect(result.activity?.reason).toBe("selection_prompt");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  // D2: an UNKNOWN observation is retried within the caller's ONE deadline and never
  // authorizes the send. The wait loop reads Date.now(); a stepped clock makes the
  // deadline and the attempt count exact.
  function steppedClock() {
    let t = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => t);
    const slept: number[] = [];
    return { sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, restore: () => spy.mockRestore() };
  }
  const IDLE_PANE = "› Use /skills to list available skills\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig";
  const BUSY_PANE = "Working on task...\n⠋ Processing files\nesc to interrupt";
  const MENU_PANE = ["Codex update available.", "", "› 1. Update now", "  2. Skip this version", "",
    "  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig"].join("\n");
  const UNREADABLE = Symbol("unreadable");
  function scriptedPanes(script: Array<string | typeof UNREADABLE>) {
    let i = 0;
    return async () => {
      const step = script[Math.min(i++, script.length - 1)]!;
      if (step === UNREADABLE) throw new Error("capture failed");
      return step;
    };
  }

  it("send with wait-for-idle retries an unknown observation and sends once explicit idle arrives", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE, IDLE_PANE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: true, sent: true, attempts: 2, activity: { state: "idle" } });
      expect(clock.slept[0]).toBe(10); // one poll interval; the later sleep is the paste→Enter delay
      expect(sendTextSpy).toHaveBeenCalledTimes(1);
    } finally { clock.restore(); }
  });

  it("send with wait-for-idle still refuses a positive prompt that appears after an unknown observation", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE, MENU_PANE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: false, reason: "target_needs_input", sent: false, attempts: 2, activity: { state: "needs_input" } });
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  it("send with wait-for-idle on perpetual unknown keeps ONE deadline and reports the last unknown observation", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: false, reason: "target_activity_unknown", sent: false, attempts: 6, waitedMs: 50,
        activity: { state: "unknown", reason: "capture_failed" } });
      expect(result.error).toBe("Target activity could not be determined (capture_failed) when the 50ms wait ended (6 observations). No text was sent.");
      // The deadline is never renewed: total sleep equals the caller's timeout.
      expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(50);
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  it.each([
    ["busy then unknown", [BUSY_PANE, BUSY_PANE, BUSY_PANE, BUSY_PANE, BUSY_PANE, UNREADABLE], "target_activity_unknown", "unknown", /could not be determined \(capture_failed\) when the 50ms wait ended \(6 observations\)/],
    ["unknown then busy", [UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE, BUSY_PANE], "wait_for_idle_timeout", "running", /still busy \(.+\) when the 50ms wait ended \(6 observations\)/],
  ] as const)("send with wait-for-idle at the deadline names the LAST observation (%s)", async (_label, script, reason, state, message) => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([...script]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: false, reason, sent: false, attempts: 6, activity: { state } });
      expect(result.error).toMatch(message);
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  it("send with wait-for-idle refuses when the recipient binding changes during an unknown retry", async () => {
    const { node } = seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE, IDLE_PANE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, {
        sleep: async (ms) => { await clock.sleep(ms); sessionRegistry.updateBinding(node.id, { tmuxPane: "%rebound" }); },
        waitForIdlePollMs: 10,
      });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: false, reason: "target_runtime_conflict", sent: false });
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  // review-r1's controls on #603 (bbf35f0a), kept verbatim in substance.
  it("R1-a: a deadline shorter than one poll still keeps ONE deadline (2 observations, total sleep = deadline)", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 5 });
      expect(result).toMatchObject({ ok: false, reason: "target_activity_unknown", sent: false, attempts: 2, waitedMs: 5 });
      expect(clock.slept).toEqual([5]);
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  it("R1-b: unknown up to the deadline, then explicit idle AT the deadline observation, sends exactly once", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE, IDLE_PANE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: true, sent: true, attempts: 6, activity: { state: "idle" } });
      expect(clock.slept.slice(0, 5).reduce((a, b) => a + b, 0)).toBe(50);
      expect(sendTextSpy).toHaveBeenCalledTimes(1);
    } finally { clock.restore(); }
  });

  it("R1-c: a positive prompt AT the deadline observation still refuses as needs-input, not as a timeout", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE, UNREADABLE, MENU_PANE]), sendText: sendTextSpy });
      const transport = createTransport(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: false, reason: "target_needs_input", sent: false, attempts: 6 });
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  it("R1-d: REAL timers: perpetual unknown never sends and returns within the deadline plus scheduling slack", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ capturePaneContent: scriptedPanes([UNREADABLE]), sendText: sendTextSpy });
    const transport = createTransport(tmux, { waitForIdlePollMs: 10 });
    const t0 = performance.now();
    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 60 });
    const wall = performance.now() - t0;
    expect(result).toMatchObject({ ok: false, reason: "target_activity_unknown", sent: false });
    expect(result.waitedMs!).toBeGreaterThanOrEqual(60);
    expect(result.attempts!).toBeGreaterThanOrEqual(2);
    expect(wall).toBeLessThan(60 + 250);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("R1-e: a non-positive or non-finite wait is still refused before any observation (no infinite loop)", async () => {
    seedCanonicalRig();
    const capture = vi.fn(async () => { throw new Error("capture failed"); });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ capturePaneContent: capture, sendText: sendTextSpy }), { sleep: async () => undefined, waitForIdlePollMs: 10 });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: bad });
      expect(result.ok).toBe(false);
      expect(result.sent).toBe(false);
    }
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  // dev50-qa's deadline controls on #603 (ca840761): an observation that completes, or a poll
  // that wakes, after the deadline must never lead to paste or Enter. The capture "costs" time by
  // advancing the stepped clock; the sleep can oversleep.
  it.each([
    ["an overslept poll after an unknown", [UNREADABLE, IDLE_PANE], 0, 60],
    ["a slow idle capture after an unknown", [UNREADABLE, IDLE_PANE], 80, 0],
    ["a slow unreadable capture after an unknown", [UNREADABLE, UNREADABLE], 80, 0],
  ] as const)("QA603: %s never pastes or presses Enter after the 50ms deadline", async (_label, script, cost, oversleep) => {
    seedCanonicalRig();
    let t = 1_000_000;
    let captures = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => t);
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const sendKeysSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({
        sendText: sendTextSpy, sendKeys: sendKeysSpy,
        capturePaneContent: async () => {
          const n = captures++;
          if (n > 0) t += cost;
          const step = script[Math.min(n, script.length - 1)]!;
          if (step === UNREADABLE) throw new Error("controlled unreadable pane");
          return step;
        },
      });
      const transport = createTransport(tmux, { waitForIdlePollMs: 10, sleep: async (ms) => { t += oversleep || ms; } });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });
      expect(result).toMatchObject({ ok: false, sent: false, reason: "target_activity_unknown", activity: { state: "unknown" } });
      expect(result.waitedMs).toBeLessThanOrEqual(50);
      expect(sendTextSpy).not.toHaveBeenCalled();
      expect(sendKeysSpy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("QA603_ASYNC: an unresolved retry observation cannot outlive the 50ms wait and later authorize input", async () => {
    seedCanonicalRig();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      let captures = 0;
      const sentAt: number[] = [];
      const tmux = mockTmux({
        capturePaneContent: async () => {
          if (captures++ === 0) throw new Error("first controlled unknown");
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
          return IDLE_PANE;
        },
        sendText: async () => { sentAt.push(Date.now() - 1_000_000); return { ok: true as const }; },
      });
      const transport = createTransport(tmux, { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitForIdlePollMs: 10 });
      let result: Awaited<ReturnType<typeof transport.send>> | null = null;
      const pending = transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 }).then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(51);
      expect(result).not.toBeNull();
      await vi.advanceTimersByTimeAsync(300);
      await pending;
      expect(sentAt).toEqual([]);
      expect(result).toMatchObject({ ok: false, sent: false, reason: "target_activity_unknown", waitedMs: 50, attempts: 2 });
    } finally { vi.useRealTimers(); }
  });

  it("D1 cancellation before waiting starts no observation or input", async () => {
    seedCanonicalRig();
    const controller = new AbortController();
    controller.abort();
    const capture = vi.fn(async () => IDLE_PANE);
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ capturePaneContent: capture, sendText, sendKeys }));
    const result = await transport.waitUntilIdle("dev-impl@my-rig", 50, controller.signal);
    expect(result).toMatchObject({ ok: false, reason: "preparation_cancelled", attempts: 0 });
    expect(capture).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("D1 cancellation during an in-flight observation discards idle and never observes again", async () => {
    seedCanonicalRig();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (text: string) => void;
    const captured = new Promise<string>((resolve) => { release = resolve; });
    const capture = vi.fn(async () => { entered(); return captured; });
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ capturePaneContent: capture, sendText, sendKeys }));
    const pending = transport.waitUntilIdle("dev-impl@my-rig", 1000, controller.signal);
    await started;
    controller.abort();
    release(IDLE_PANE);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: "preparation_cancelled", attempts: 1 });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("D1 cancellation between retries starts no second observation", async () => {
    seedCanonicalRig();
    const controller = new AbortController();
    const capture = vi.fn(async () => { throw new Error("controlled unreadable pane"); });
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = createTransport(mockTmux({ capturePaneContent: capture, sendText, sendKeys }), {
      waitForIdlePollMs: 10, sleep: async () => { controller.abort(); },
    });
    const result = await transport.waitUntilIdle("dev-impl@my-rig", 1000, controller.signal);
    expect(result).toMatchObject({ ok: false, reason: "preparation_cancelled", attempts: 1 });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("an ordinary send (no wait) is unchanged: one unknown observation proceeds with an advisory, no retry loop", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ capturePaneContent: async () => { throw new Error("capture failed"); }, sendText: sendTextSpy });
    const transport = createTransport(tmux, { sleep: async () => undefined, waitForIdlePollMs: 10 });
    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.attempts).toBeUndefined();
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
  });

  it("send with wait-for-idle prefers fresh hook activity and waits for hook idle", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "PreToolUse",
    });
    let sleepCount = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => {
        sleepCount++;
        if (sleepCount === 1) {
          agentActivityStore.recordHookEvent({
            runtime: "claude-code",
            sessionName: "dev-impl@my-rig",
            hookEvent: "Stop",
          });
        }
      },
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send with wait-for-idle treats fresh UserPromptSubmit hook evidence as running", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wait_for_idle_timeout");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("running");
    expect(result.activity?.reason).toBe("user_prompt_submit");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send with wait-for-idle hard-stops on fresh permission prompt hook evidence", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "Notification",
      subtype: "permission_prompt",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("needs_input");
    expect(result.activity?.reason).toBe("permission_prompt");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send with wait-for-idle treats fresh unknown hook evidence as unknown and does not fall through to pane idle", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "SessionStart",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "› idle\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_activity_unknown");
    expect(result.sent).toBe(false);
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send does not refuse on idle codex status lines truncated with unicode ellipsis", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Lane closed.",
        "",
        "  2 background terminals running · /ps to view · /stop to close",
        "",
        "› Summarize recent commits",
        "",
        "  gpt-5.4 xhigh fast · Context [████ ] · ~/.openrig/shared-docs/rigs/kerne…",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send does not refuse on idle prompt lines ending in ascii ellipsis", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "ready prompt...\n❯ ",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send does not refuse when Working text is stale scrollback above an idle Codex prompt", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
        "",
        "› Use /skills to list available skills",
        "",
        "  gpt-5.4 xhigh fast · Context [█▉   ] · ~/code/projects/openrig-hub · Fas…",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send does not refuse when Working text is stale scrollback above an idle Claude Code prompt", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "✢ Working… (5m 9s · ↑ 4.4k tokens)",
        "  ⎿  Tip: Use /btw to ask a quick side question",
        "",
        "❯ ",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send still refuses when prompt char line contains mid-work text (active Claude input)", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ Working on a task.",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow — mid_work downgraded to deliver-with-advisory
    expect(result.warning).toContain("mid-task");
  });

  it("send refuses when Codex trust-prompt choice line is the active pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "› 1. Yes, continue",
        "  2. Yes, allow all tools",
        "  3. No, cancel",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10: an interactive prompt now refuses with the precise target_needs_input (not the
    // generic mid_work) so the prompt/permission guard is independent of --force.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("send refuses when a full-screen Codex trust prompt has blank padding below it", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "> You are in /Users/admin/workspace",
        "",
        "  Do you trust the contents of this directory? Working with untrusted contents",
        "  comes with higher risk of prompt injection.",
        "",
        "› 1. Yes, continue",
        "  2. No, quit",
        "",
        "  Press enter to continue",
        "",
        "",
        "",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10: trust prompt → target_needs_input (precise prompt/permission guard).
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("send refuses when Claude Code trust-prompt choice line is the active pane content", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ 1. Yes",
        "  2. Yes, allow all edits in domain/ during this session",
        "  3. No",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10: trust prompt → target_needs_input (precise prompt/permission guard).
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("send still refuses when Working footer is present with no idle prompt below it", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Reading file…",
        "",
        "◦ Working (2m 3s • esc to interrupt)",
        "  ⎿  Processing 4 files",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow — mid_work downgraded to deliver-with-advisory
    expect(result.warning).toContain("mid-task");
  });

  it("send refuses when a Claude prompt draft is present above an idle footer", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ I am typing a human message",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "/compact Preserve current task.");

    // OPR.0.4.1.10: a prompt draft above the idle footer is an interactive-prompt state →
    // target_needs_input (a stray send must not land on the human's in-progress input).
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  // --- Realistic pane-fixture tests (test-infrastructure lane) ---
  //
  // These use full-screen-shaped fixtures with blank padding, scrollback,
  // status bars, and separator lines to match real tmux capturePaneContent
  // output. Ensures the non-blank-window approach in looksLikeMidWork()
  // handles realistic rendering, not just compact hand-written snippets.

  /** Build a realistic pane fixture with terminal-geometry structure. */
  function buildPaneFixture(opts: {
    scrollback?: string[];
    content: string[];
    statusBar?: string[];
    trailingBlanks?: number;
  }): string {
    const lines: string[] = [];
    if (opts.scrollback) lines.push(...opts.scrollback, "");
    lines.push(...opts.content);
    if (opts.statusBar) lines.push("", ...opts.statusBar);
    if (opts.trailingBlanks) lines.push(...Array(opts.trailingBlanks).fill(""));
    return lines.join("\n");
  }

  // NOTE: if the prior-idle Codex status bar ("gpt-5.4 ... Context [...]")
  // remains in the last 3 non-blank lines during active work, the idle
  // discriminator false-negatives (treats active-work as idle). In real
  // renders the status bar from a prior idle state is typically many lines
  // above the current working footer. This fixture models that realistic
  // distance. A fixture where the stale status bar is only 1-2 non-blank
  // lines above the working footer DOES expose a gap — filed as residual
  // in the return handoff.
  it("realistic: full-screen Codex active-working pane with scrollback + padding blocks", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "• Ran npm test --workspace @openrig/daemon",
          "  └ 1784 tests passed",
          "",
          "  gpt-5.4 high · Context [████ ] · ~/code/projects/openrig-hub",
          "",
          "• I'll read the session-transport.ts file.",
          "",
          "• Ran cat packages/daemon/src/domain/session-transport.ts",
          "  └ import type Database from 'better-sqlite3';",
          "    … +54 lines (ctrl + t to view transcript)",
        ],
        content: [
          "• Reading 3 files…",
          "",
          "◦ Working (2m 41s • esc to interrupt) · 6 background terminals running · /…",
        ],
        trailingBlanks: 6,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow — mid_work downgraded to deliver-with-advisory
    expect(result.warning).toContain("mid-task");
  });

  it("realistic: full-screen Codex idle-at-prompt with stale Working in scrollback + padding allows", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "• Ran npm test --workspace @openrig/daemon",
          "  └ 1784 tests passed",
          "",
          "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
          "",
          "✻ Worked for 9m 26s",
        ],
        content: [
          "› Use /skills to list available skills",
          "",
          "  gpt-5.4 xhigh fast · Context [█▉   ] · ~/code/projects/openrig-hub · Fast off",
        ],
        trailingBlanks: 4,
      }),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("realistic: full-screen Claude Code active-working pane with tool output + padding blocks", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "⏺ I'll read the session-transport.ts file to understand the current",
          "  implementation.",
          "",
          "⏺ Reading 1 file…",
          "  ⎿  Read packages/daemon/src/domain/session-transport.ts",
        ],
        content: [
          "✢ Working… (5m 9s · ↑ 4.4k tokens)",
          "  ⎿  Tip: Use /btw to ask a quick side question without",
          "     interrupting Claude's current work",
        ],
        trailingBlanks: 5,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow — mid_work downgraded to deliver-with-advisory
    expect(result.warning).toContain("mid-task");
  });

  it("realistic: full-screen Claude Code idle-at-prompt with stale Working in scrollback + edit-bar allows", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "✢ Working… (5m 9s · ↑ 4.4k tokens)",
          "  ⎿  Tip: Use /btw to ask a quick side question without",
          "     interrupting Claude's current work",
          "",
          "⏺ Done. Committed as abc1234.",
        ],
        content: [
          "──────────────────────────────────────────────────────────────",
          "❯ ",
          "──────────────────────────────────────────────────────────────",
          "  ⏵⏵ accept edits on (shift+tab to cycle)",
        ],
        trailingBlanks: 3,
      }),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("realistic: full-screen Codex trust-prompt with multi-line instructions + heavy padding blocks", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        content: [
          "> You are in /Users/admin/workspace",
          "",
          "  Do you trust the contents of this directory? Working with untrusted",
          "  contents comes with higher risk of prompt injection.",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "  Press enter to continue",
        ],
        trailingBlanks: 8,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10: full-screen trust prompt → target_needs_input (precise prompt/permission guard).
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("realistic: short-burst Codex work with stale status bar in last 3 non-blank blocks", async () => {
    // Short work burst: the Codex status bar from a prior idle state is only
    // 2 non-blank lines above the active "Working" footer. Both appear in the
    // last 3 non-blank lines. Current code false-negatives (allows) because
    // the status bar matches IDLE_STATUS_BAR_PATTERNS. The fix should tighten
    // the status-bar check to last-non-blank-line only so stale bars above
    // active work don't override.
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "› Use /skills to list available skills",
          "",
          "  gpt-5.4 high · Context [████ ] · ~/code/projects/openrig-hub",
        ],
        content: [
          "• Reading 1 file…",
          "",
          "◦ Working (0m 3s • esc to interrupt)",
        ],
        trailingBlanks: 4,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow — mid_work downgraded to deliver-with-advisory
    expect(result.warning).toContain("mid-task");
  });

  it("send to terminal session with foreground non-shell command refuses with mid_work", async () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "infra.ui", {
      role: "ui", runtime: "terminal",
    });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@term-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "infra-ui@term-rig" });

    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "VITE ready\npress h + enter to show help",
      getPaneCommand: async () => "node",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("infra-ui@term-rig", "printf 'hello\\n'");
    // OPR.0.4.3.28 fast-follow — a terminal foreground command maps to `running`, which now
    // delivers-with-advisory (was: mid_work refuse + no send). Busy is not a block.
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("mid-task");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  // Test 9: an UNEXPECTED probe throw (the fail-closed class — not the
  // classified no-server path, which one-honest-resolution-path.test.ts covers
  // with the real adapter) still surfaces as tmux_unavailable, honestly worded.
  it("send when the probe throws unexpectedly returns tmux_unavailable with guidance", async () => {
    const tmux = mockTmux({
      hasSession: async () => { throw new Error("no server running"); },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
    expect(result.error).toContain("tmux");
  });

  it("send to external_cli target fails honestly before tmux transport", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.send("orch1-lead@rigged-buildout", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("transport_unavailable");
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
  });

  // Test 10: capture returns pane content
  it("capture returns pane content for existing session", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "line1\nline2\nline3",
    });
    const transport = createTransport(tmux);

    const result = await transport.capture("dev-impl@my-rig");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("line1");
  });

  it("capture for external_cli target fails honestly before tmux transport", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.capture("orch1-lead@rigged-buildout");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
  });

  // Test 11: resolveSessions by rig returns running sessions
  it("resolveSessions by rig returns running sessions", async () => {
    seedCanonicalRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ rig: "my-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@my-rig");
    }
  });

  // Test 12: resolveSessions global returns all running sessions across all rigs
  it("resolveSessions global returns all running sessions across all rigs", async () => {
    seedCanonicalRig(); // rig "my-rig" with dev-impl@my-rig
    seedLegacyRig();    // rig "r00-legacy" with r00-legacy-worker-a
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ global: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(3);
      const names = result.sessions.map((s) => s.sessionName).sort();
      expect(names).toContain("dev-impl@my-rig");
      expect(names).toContain("r00-legacy-worker-a");
      expect(names).toContain("orch1-lead@rigged-buildout");
    }
  });

  // Test 13: resolveSessions by pod filters by logicalId prefix
  it("resolveSessions by pod filters by logicalId prefix", async () => {
    const rig = rigRepo.createRig("multi-rig");
    // dev pod
    const devNode = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const devSess = sessionRegistry.registerSession(devNode.id, "dev-impl@multi-rig");
    sessionRegistry.updateStatus(devSess.id, "running");
    sessionRegistry.updateBinding(devNode.id, { tmuxSession: "dev-impl@multi-rig" });
    // orch pod
    const orchNode = rigRepo.addNode(rig.id, "orch.lead", { role: "orchestrator", runtime: "claude-code" });
    const orchSess = sessionRegistry.registerSession(orchNode.id, "orch-lead@multi-rig");
    sessionRegistry.updateStatus(orchSess.id, "running");
    sessionRegistry.updateBinding(orchNode.id, { tmuxSession: "orch-lead@multi-rig" });

    const transport = createTransport();
    const result = await transport.resolveSessions({ pod: "dev", rig: "multi-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@multi-rig");
    }
  });

  it("broadcast includes external_cli targets as explicit transport_unavailable failures", async () => {
    seedCanonicalRig();
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.broadcast({ global: true }, "hello", { force: true });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionName: "orch1-lead@rigged-buildout",
          ok: false,
          reason: "transport_unavailable",
        }),
      ]),
    );
  });

  // Send/broadcast header (ruling 03c35295) — the fan-out threads the scale scope + a Sent stamp
  // through the daemon-side wrap, so every recipient's header carries the same envelope facts.
  it("multi-send fan-out renders the FULL recipient list + a Sent stamp on each recipient's To header", async () => {
    seedCanonicalRig(); // dev-impl@my-rig
    seedLegacyRig(); // r00-legacy-worker-a
    const sent: string[] = [];
    const tmux = mockTmux({ sendText: async (_t, text) => { sent.push(text); return { ok: true }; } });
    const transport = createTransport(tmux);

    await transport.broadcast(
      { sessions: ["dev-impl@my-rig", "r00-legacy-worker-a"] },
      "status",
      { envelopeSender: "orch@my-rig", stampISO: "2026-08-06T17:42:09Z" },
    );

    expect(sent).toHaveLength(2);
    for (const text of sent) {
      expect(text).toContain("To: dev-impl@my-rig, r00-legacy-worker-a"); // full list (WHO got it)
      expect(text).toContain("Sent: 08-06 17:42Z"); // the transport stamp
      expect(text).toContain("status");
    }
  });

  it("raw broadcast (no envelopeSender) is delivered unwrapped — no header change", async () => {
    seedCanonicalRig();
    const sent: string[] = [];
    const tmux = mockTmux({ sendText: async (_t, text) => { sent.push(text); return { ok: true }; } });
    const transport = createTransport(tmux);

    await transport.broadcast({ rig: "my-rig" }, "raw ping", {});

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("raw ping"); // unchanged (the --raw carve-out)
  });

  // ── GHOST-STAGE (h): delivered-at latency stamped at the WRITE moment ──
  const H_ENVELOPE =
    'From: a@r\nTo: dev-impl@my-rig\nSent: 08-06 17:42Z\n---\nhi\n---\n↩ Reply: rig send a@r "..."';

  it("(h) send() flags a delayed delivery on the Sent: line when the compose→write gap exceeds 10s", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    // write-moment clock is 30s after the compose stamp (opts.stampISO)
    const transport = createTransport(tmux, { now: () => new Date("2026-08-06T17:42:39Z") });
    await transport.send("dev-impl@my-rig", H_ENVELOPE, { stampISO: "2026-08-06T17:42:09Z" });
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendTextSpy.mock.calls[0]![1]).toContain("Sent: 08-06 17:42Z · delivered +30s");
  });

  it("(h) send() adds no delivered segment for a sub-threshold (3s) gap", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux, { now: () => new Date("2026-08-06T17:42:12Z") });
    await transport.send("dev-impl@my-rig", H_ENVELOPE, { stampISO: "2026-08-06T17:42:09Z" });
    expect(sendTextSpy.mock.calls[0]![1]).not.toContain(" · delivered ");
  });
});
