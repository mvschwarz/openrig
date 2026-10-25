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
import { classifyPaneActivity, classifyStyledFrame, hasExpectedStagedText, inspectStartupStagedText, probeSessionActivity, promptTextIsFaint, SessionTransport, type TransportReadinessChecker } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard, resolveGuardTarget, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { recordRotation, requestedToken, rotatedToken, rotation, rowsWith as claudeRows, seat as claudeSeat } from "./helpers/claude-sweeper-seat.js";

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

  it("classifies an idle Codex 0.153 `»` composer placeholder as agent_idle", () => {
    const result = classifyPaneActivity([
      "  Tip: You can resume a previous conversation by running codex resume",
      "» Ask Codex to do anything",
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

  it("classifies idle Claude auto mode footer (with vim prefix) as agent_idle (#808)", () => {
    const result = classifyPaneActivity([
      "❯ ",
      "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  it("classifies idle Claude bypass permissions, plan mode, and shortcut footers as agent_idle (#808)", () => {
    for (const footer of [
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
      "  -- NORMAL -- ⏵⏵ auto mode on (shift+tab to cycle)",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      "  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)",
      "  ⏸ plan mode on (shift+tab to cycle)",
      "  -- INSERT -- ⏸ plan mode on (shift+tab to cycle)",
    ]) {
      const result = classifyPaneActivity([
        "❯ ",
        footer,
      ].join("\n"));
      expect(result.state).toBe("agent_idle");
      expect(result.reason).toBe("idle_status_bar");
    }
  });

  it("classifies typed Claude prompt text above an auto mode footer as attention, not idle (#808)", () => {
    const result = classifyPaneActivity([
      "❯ I am still typing a message",
      "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("prompt_draft");
    expect(result.evidence).toContain("still typing");
  });

  it("does not classify working Claude seat in auto mode as idle when mid-work evidence is present (#808)", () => {
    const result = classifyPaneActivity([
      "✻ Thinking… (15s)",
      "❯ ",
      "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
  });

  it("recognizes unframed idle Claude seat in auto mode with vim prefix (#808)", () => {
    const result = classifyPaneActivity([
      "● Ready.",
      "",
      "❯ ",
      "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
  });

  it("classifies an earlier selection question above an empty composer with a suffixed shortcut footer as selection_prompt (#808)", () => {
    const result = classifyPaneActivity([
      "❯ 1. First option",
      "  2. Second option",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────",
      "  ? for shortcuts · 2 shells",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("selection_prompt");
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

  // #79 — Codex 0.153 variants draw the composer prompt as `»`. The shared
  // glyph set (composer-prompts.ts) must classify it exactly like `❯`/`›`.
  it("classifies a `»` composer as idle", () => {
    const result = classifyPaneActivity(["prior output", "» "].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_prompt");
  });

  it("classifies a `»` draft above the Codex footer as a prompt draft", () => {
    const result = classifyPaneActivity([
      "prior output",
      "» half typed input",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("prompt_draft");
  });

  it("classifies a `»` numbered selection as attention", () => {
    const result = classifyPaneActivity(["» 1. Yes", "  2. No"].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("selection_prompt");
  });
});

describe("shared composer matchers", () => {
  it("hasExpectedStagedText matches Claude `❯` staged text", () => {
    expect(hasExpectedStagedText("prior\n❯ deploy the release\n────────────\nhint", "deploy the release", "claude-code")).toBe(true);
  });

  it("hasExpectedStagedText matches Codex `›` staged text", () => {
    expect(hasExpectedStagedText("prior\n› deploy the release\n", "deploy the release", "codex")).toBe(true);
  });

  it("hasExpectedStagedText matches Codex 0.153 `»` staged text", () => {
    expect(hasExpectedStagedText("prior\n» deploy the release\n", "deploy the release", "codex")).toBe(true);
  });

  it("hasExpectedStagedText reads a Claude draft whose continuation starts with a Codex glyph", () => {
    const pane = [
      "prior output",
      "❯ please check this:",
      "› run the tests",
      "────────────",
      "hint bar",
    ].join("\n");
    // Runtime-scoped markers: the `›` continuation is part of the Claude draft,
    // not a second composer. The union-only read would take the `›` line as the
    // input marker and lose the drafted head.
    expect(hasExpectedStagedText(pane, "please check this:\n› run the tests", "claude-code")).toBe(true);
  });

  it("hasExpectedStagedText never treats a numbered selection as staged input", () => {
    expect(hasExpectedStagedText("prior\n❯ 1. Yes\n", "Yes", "claude-code")).toBe(false);
    expect(hasExpectedStagedText("prior\n» 1. Yes\n", "Yes", "codex")).toBe(false);
    // The broad prefix exclusion also catches compact options (`1.Yes`), which
    // the draft/selection classifier's spaced pattern deliberately does not.
    expect(hasExpectedStagedText("prior\n❯ 1.Yes\n", "Yes", "claude-code")).toBe(false);
    expect(hasExpectedStagedText("prior\n› 2.No\n", "2.No", "codex")).toBe(false);
  });

  it("inspectStartupStagedText reads a `»` composer body", () => {
    const pane = [
      "Previous turn",
      "» hello world",
      "────────────",
      "shift+tab to cycle",
    ].join("\n");

    expect(inspectStartupStagedText(pane, "hello world", "codex")).toBe("staged");
    expect(inspectStartupStagedText(pane, "something else", "codex")).toBe("unverified");
  });

  it("inspectStartupStagedText excludes a compact numbered option", () => {
    const pane = ["Previous turn", "❯ 1.Yes", "────────────", "shift+tab to cycle"].join("\n");

    expect(inspectStartupStagedText(pane, "1.Yes", "claude-code")).toBe("unverified");
  });

  // Review round 2 (mvschwarz on #635): with no runtime there is no way to say
  // which mixed-glyph line is the live composer, so the union read must fail
  // closed exactly as the pre-shared-matcher check did.
  it("unknown runtime refuses a mixed-glyph composer block", () => {
    const separators: string[][] = [[], [""], ["────────────"]];
    for (const separator of separators) {
      for (const glyph of ["›", "»"]) {
        const pane = [
          "❯ unrelated first line",
          ...separator,
          `${glyph} expected text`,
          "────────────",
          "shift+tab to cycle",
        ].join("\n");

        expect(hasExpectedStagedText(pane, "expected text")).toBe(false);
        expect(inspectStartupStagedText(pane, "expected text")).toBe("unverified");
      }
    }
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
  listPanes: (sessionName: string) => Promise<Array<{ id: string }>>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
  isPaneInMode: (paneId: string) => Promise<boolean | null>;
  cancelPaneMode: (target: string) => Promise<TmuxResult>;
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
    listPanes: overrides?.listPanes ?? (async () => []),
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
    isPaneInMode: overrides?.isPaneInMode ?? (async () => false),
    cancelPaneMode: overrides?.cancelPaneMode ?? (async () => ({ ok: true as const })),
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
    eventBus?: EventBus;
    runtimeAdapters?: Record<string, TransportReadinessChecker>;
  }) {
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      ...overrides,
    });
  }

  function seedCanonicalRig(runtime = "claude-code") {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker", runtime,
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
    // A pane that stays in its mode until cancelPaneMode runs, recording every call in order.
    function modalPane(opts: { leaves: boolean; callOrder: string[]; capture?: string }) {
      let inMode = true;
      return mockTmux({
        sendText: async () => { opts.callOrder.push("sendText"); return { ok: true }; },
        sendKeys: async (_t, keys) => { opts.callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
        ...(opts.capture !== undefined ? { capturePaneContent: async () => opts.capture! } : {}),
        isPaneInMode: async () => inMode,
        cancelPaneMode: async () => { opts.callOrder.push("cancelPaneMode"); if (opts.leaves) inMode = false; return { ok: true }; },
      });
    }

    it("leaves the mode, then sends the text and Enter", async () => {
      seedCanonicalRig();
      const callOrder: string[] = [];
      const transport = createTransport(modalPane({ leaves: true, callOrder }));

      const result = await transport.send("dev-impl@my-rig", "hello");
      expect(result.ok).toBe(true);
      expect(callOrder).toEqual(["cancelPaneMode", "sendText", "sendKeys:Enter"]);
    });

    it("leaves the mode before a submitOnly Enter", async () => {
      seedCanonicalRig();
      const callOrder: string[] = [];
      const transport = createTransport(modalPane({ leaves: true, callOrder, capture: "❯ staged message" }));

      const result = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: "staged message" });
      expect(result.ok).toBe(true);
      expect(callOrder).toEqual(["cancelPaneMode", "sendKeys:Enter"]);
    });

    it("types nothing when the pane cannot leave the mode", async () => {
      seedCanonicalRig();
      const callOrder: string[] = [];
      const transport = createTransport(modalPane({ leaves: false, callOrder }));

      const result = await transport.send("dev-impl@my-rig", "hello");
      expect(result).toMatchObject({ ok: false, reason: "pane_in_mode", sent: false });
      expect(result.error).toContain("could not leave it");
      expect(result.error).toContain("No text was sent.");
      expect(callOrder).toEqual(["cancelPaneMode"]);
    });

    it("sends no submitOnly Enter when the pane cannot leave the mode", async () => {
      seedCanonicalRig();
      const callOrder: string[] = [];
      const transport = createTransport(modalPane({ leaves: false, callOrder, capture: "❯ staged message" }));

      const result = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: "staged message" });
      expect(result).toMatchObject({ ok: false, reason: "pane_in_mode" });
      expect(result.error).toContain("Nothing was submitted.");
      expect(callOrder).toEqual(["cancelPaneMode"]);
    });

    it("sends as before when the mode is unknown", async () => {
      seedCanonicalRig();
      const callOrder: string[] = [];
      const cancelPaneMode = vi.fn(async () => ({ ok: true as const }));
      const transport = createTransport(mockTmux({
        sendText: async () => { callOrder.push("sendText"); return { ok: true }; },
        sendKeys: async (_t, keys) => { callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
        isPaneInMode: async () => null,
        cancelPaneMode,
      }));

      const result = await transport.send("dev-impl@my-rig", "hello");
      expect(result.ok).toBe(true);
      expect(callOrder).toEqual(["sendText", "sendKeys:Enter"]);
      expect(cancelPaneMode).not.toHaveBeenCalled();
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
    expect(result.error).toContain("the Enter reported a failure");
    expect(result.error).toContain("submission outcome is unconfirmed");
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

  it.each(["new render", "unchanged render", "additional render", "indentation-only redraw", "different message"])(
    "send with verify compares indented multiline envelopes: %s",
    async (mode) => {
      seedCanonicalRig();
      const message = "From: sender-agent@demo\nTo: dev-impl@my-rig\nSent: 2026-10-11T05:00:00Z\n---\nPlease check this task.";
      // Claude renders submitted multiline messages with two-space continuation indentation.
      const rendered = "❯ " + message.split("\n").join("\n  ");
      let submitted = false;
      const prior = mode === "new render" || mode === "different message" ? "prior output"
        : mode === "indentation-only redraw" ? "❯ " + message : rendered;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => {
          if (submitted && mode === "indentation-only redraw") return rendered + "\n❯ ";
          const added = submitted && mode !== "unchanged render" ? "\n" + (
            mode === "different message" ? rendered.replace("To: dev-impl", "To: other-seat") : rendered
          ) : "";
          return prior + added + "\n❯ ";
        },
      });
      const transport = createTransport(tmux, { sleep: async () => undefined });

      const result = await transport.send("dev-impl@my-rig", message, { verify: true });

      expect(result.ok).toBe(true);
      const expectedVerified = mode === "new render" || mode === "additional render";
      expect(result.verified).toBe(expectedVerified);
      expect(result.outcome).toBe(expectedVerified ? "delivered" : "rendered-unconfirmed");
    },
  );

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

  it.each(["same envelope, different body", "unsent composer", "old transcript plus unsent copy", "quoted prompt in composer"])(
    "send with verify rejects false confirmation: %s",
    async (mode) => {
      seedCanonicalRig();
      const message = "From: sender-agent@demo\nTo: dev-impl@my-rig\nSent: 10-11 05:00Z\n---\nPlease check this task.";
      const rendered = "❯ " + message.split("\n").join("\n  ");
      const composer = "────────────────────\n" + rendered +
        (mode === "quoted prompt in composer" ? "\n  ❯ quoted prompt" : "") + "\n────────────────────\n? for shortcuts";
      const prior = mode === "old transcript plus unsent copy" ? rendered + "\n" : "";
      let submitted = false;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => prior + (submitted
          ? mode === "same envelope, different body"
            ? rendered.replace("Please check this task.", "Please check a different task.") + "\n❯ "
            : composer
          : "❯ "),
      });
      const result = await createTransport(tmux, { sleep: async () => undefined })
        .send("dev-impl@my-rig", message, { verify: true });
      expect(result).toMatchObject({ ok: true, verified: false, outcome: "rendered-unconfirmed" });
    },
  );

  it.each(["different tail", "full message", "truncated message"])(
    "send with verify compares the full envelope after a long shared opening: %s",
    async (mode) => {
      seedCanonicalRig();
      const message = "From: sender-agent@demo\nTo: dev-impl@my-rig\nSent: 10-11 05:00Z\n---\n" +
        "A shared opening longer than forty characters belongs to both messages.\nRequested tail.";
      const rendered = "❯ " + message.split("\n").join("\n  ");
      let submitted = false;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => !submitted ? "❯ " :
          (mode === "different tail" ? rendered.replace("Requested tail.", "Other tail.")
            : mode === "truncated message" ? rendered.split("\n").slice(0, -1).join("\n") : rendered) + "\n❯ ",
      });
      const result = await createTransport(tmux, { sleep: async () => undefined })
        .send("dev-impl@my-rig", message, { verify: true });
      expect(result).toMatchObject({ ok: true, verified: mode === "full message",
        outcome: mode === "full message" ? "delivered" : "rendered-unconfirmed" });
    },
  );

  it.each(["wrapped full", "wrapped wrong tail", "wrapped staged", "wrapped redraw"])(
    "send with verify compares full envelopes across wrapping: %s",
    async (mode) => {
      seedCanonicalRig();
      const message = "From: sender-agent@demo\nTo: dev-impl@my-rig\nSent: 10-11 05:00Z\n---\n" +
        "This long shared opening exceeds forty characters and wraps at a word boundary. Requested tail.";
      const rendered = "❯ " + message.split("\n").join("\n  ");
      const wrapped = rendered.replace("and wraps", "and\n  wraps");
      let submitted = false;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => !submitted
          ? (mode === "wrapped redraw" ? rendered + "\n❯ " : "❯ ")
          : (mode === "wrapped wrong tail" ? wrapped.replace("Requested tail.", "Other tail.") : wrapped) +
            (mode === "wrapped staged" ? "\n────────────────────\n? for shortcuts" : "\n❯ "),
      });
      const result = await createTransport(tmux, { sleep: async () => undefined })
        .send("dev-impl@my-rig", message, { verify: true });
      expect(result).toMatchObject({ ok: true, verified: mode === "wrapped full",
        outcome: mode === "wrapped full" ? "delivered" : "rendered-unconfirmed" });
    },
  );

  it.each(["same-line suffix", "next-line suffix", "exact block", "canonical suffix", "canonical exact", "footer suffix"])(
    "send with verify counts complete envelope blocks: %s",
    async (mode) => {
      seedCanonicalRig();
      const header = "From: sender-agent@demo\nTo: dev-impl@my-rig\nSent: 10-11 05:00Z\n---\n";
      const footer = "\n---\n↩ Reply: rig send sender-agent@demo \"...\"";
      const canonical = mode.startsWith("canonical") || mode === "footer suffix";
      const message = header + "Requested body." + (canonical ? footer : "");
      let rendered = message;
      if (mode === "same-line suffix") rendered += " Extra body.";
      if (mode === "next-line suffix") rendered += "\nExtra body.";
      if (mode === "canonical suffix") rendered = rendered.replace("Requested body.", "Requested body. Extra body.");
      if (mode === "footer suffix") rendered += " Extra footer text.";
      let submitted = false;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => !submitted ? "❯ " : "❯ " + rendered.split("\n").join("\n  ") + "\n❯ ",
      });
      const result = await createTransport(tmux, { sleep: async () => undefined })
        .send("dev-impl@my-rig", message, { verify: true });
      const verified = mode === "exact block" || mode === "canonical exact";
      expect(result).toMatchObject({ ok: true, verified, outcome: verified ? "delivered" : "rendered-unconfirmed" });
    },
  );

  it.each(["From suffix", "Claude quote suffix", "Codex quote suffix", "empty framed input", "quoted framed draft"])(
    "send with verify retains columns at envelope and composer boundaries: %s",
    async (mode) => {
      seedCanonicalRig();
      const message = "From: sender-agent@demo\nTo: dev-impl@my-rig\n---\nRequested body.\n---\n↩ Reply: rig send sender-agent@demo \"...\"";
      const suffix = mode === "From suffix" ? "\nFrom: extra body text"
        : mode === "Claude quote suffix" ? "\n❯ extra quoted body"
        : mode === "Codex quote suffix" ? "\n› extra quoted body" : "";
      const rendered = "❯ " + (message + suffix).split("\n").join("\n  ");
      const framed = "\n────────────────────\n❯ " + (mode === "quoted framed draft" ? "draft\n  ❯ quoted prompt" : "") +
        "\n────────────────────\n? for shortcuts";
      const verified = mode === "empty framed input" || mode === "quoted framed draft";
      let submitted = false;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => !submitted ? "❯ " : rendered + (verified ? framed : "\n❯ "),
      });
      const result = await createTransport(tmux, { sleep: async () => undefined })
        .send("dev-impl@my-rig", message, { verify: true });
      expect(result).toMatchObject({ ok: true, verified, outcome: verified ? "delivered" : "rendered-unconfirmed" });
    },
  );

  it.each(["Claude reply", "Claude status", "Claude spinner", "Claude dotted status", "Claude thinking", "Codex plain output", "blank-separated reply", "Codex reply", "Codex status", "quoted reply suffix", "quoted status suffix", "plain suffix", "assistant quotes envelope", "assistant quotes prompt then envelope", "next incoming after reply"])(
    "send with verify separates user envelopes from agent output: %s",
    async (mode) => {
      seedCanonicalRig();
      const message = "From: sender-agent@demo\nTo: dev-impl@my-rig\n---\nRequested body.\n---\n↩ Reply: rig send sender-agent@demo \"...\"";
      const render = (text: string) => "❯ " + text.split("\n").join("\n  ");
      const marker = mode === "Claude status" ? "✻ Working… (2s · thinking)"
        : mode === "Claude spinner" ? "⠋ Processing"
        : mode === "Claude dotted status" ? "· Working… (2s · thinking)"
        : mode === "Claude thinking" ? "✻ Thinking… (esc to interrupt)"
        : mode === "Codex plain output" ? "Assistant output without a role glyph"
        : mode === "Codex reply" ? "• Agent reply"
        : mode === "Codex status" ? "◦ Working (2s • esc to interrupt)" : "⏺ Agent reply";
      let output = render(message) + "\n" + marker;
      if (mode === "Codex plain output") output = output.replace(/^❯/, "›");
      if (mode === "Claude thinking" || mode === "blank-separated reply") output = render(message) + "\n\n" + marker + "\n";
      if (mode === "quoted reply suffix") output = render(message + "\n⏺ quoted reply");
      if (mode === "quoted status suffix") output = render(message + "\n◦ Working (2s • esc to interrupt)");
      if (mode === "plain suffix") output = message + "\n⏺ extra plain body";
      if (mode === "assistant quotes envelope") output = render(message.replace("Requested body.", "Other body.")) + "\n⏺ Agent reply\n" + message;
      if (mode === "assistant quotes prompt then envelope") output = render(message.replace("Requested body.", "Other body.")) + "\n⏺ Agent reply\n❯ example command\n" + message;
      if (mode === "next incoming after reply") output = render(message.replace("Requested body.", "Other body.")) + "\n⏺ Agent reply\n" + render(message);
      let submitted = false;
      const tmux = mockTmux({
        sendKeys: async () => { submitted = true; return { ok: true }; },
        capturePaneContent: async () => !submitted ? "❯ " : output + "\n────────────────────\n❯ \n────────────────────\n? for shortcuts",
      });
      const result = await createTransport(tmux, { sleep: async () => undefined })
        .send("dev-impl@my-rig", message, { verify: true });
      const verified = ["Claude reply", "Claude status", "Claude spinner", "Claude dotted status", "Claude thinking", "Codex plain output", "blank-separated reply", "Codex reply", "Codex status", "next incoming after reply"].includes(mode);
      expect(result).toMatchObject({ ok: true, verified, outcome: verified ? "delivered" : "rendered-unconfirmed" });
    },
  );

  it("send with verify keeps raw multiline captures free of joined-line padding", async () => {
    seedCanonicalRig();
    const message = "First logical line.\nSecond logical line crosses forty characters.";
    let submitted = false;
    const captures: unknown[] = [];
    const tmux = mockTmux({
      sendKeys: async () => { submitted = true; return { ok: true }; },
      capturePaneContent: async (_session, _lines, options) => {
        captures.push(options);
        const first = options?.joinWrappedLines ? "First logical line.          " : "First logical line.";
        return !submitted ? "❯ " : "❯ " + first + "\n  Second logical line crosses forty characters.\n❯ ";
      },
    });
    const result = await createTransport(tmux, { sleep: async () => undefined })
      .send("dev-impl@my-rig", message, { verify: true });
    expect(result).toMatchObject({ ok: true, verified: true, outcome: "delivered" });
    expect(captures.every(options => options === undefined)).toBe(true);
  });

  it.each(["raw", "envelope without timestamp"])("send with verify excludes current input: %s", async (mode) => {
    seedCanonicalRig();
    const message = mode === "raw" ? "Please check this task."
      : "From: sender-agent@demo\nTo: dev-impl@my-rig\n---\nPlease check this task.";
    let submitted = false;
    const tmux = mockTmux({
      sendKeys: async () => { submitted = true; return { ok: true }; },
      capturePaneContent: async () => submitted ? "❯ " + message.split("\n").join("\n  ") : "❯ ",
    });
    const result = await createTransport(tmux, { sleep: async () => undefined })
      .send("dev-impl@my-rig", message, { verify: true });
    expect(result).toMatchObject({ ok: true, verified: false, outcome: "rendered-unconfirmed" });
  });

  it.each(["❯", "›", "»"].flatMap(glyph =>
    ["raw staged", "raw submitted", "envelope staged", "envelope submitted", "quoted draft", "quoted prompt in draft", "after reply", "flat transcript boundary"]
      .map(mode => [glyph, mode] as const),
  ))("send verification recognises composer %s: %s", async (glyph, mode) => {
    seedCanonicalRig(glyph === "❯" ? "claude-code" : "codex");
    const message = mode.startsWith("raw") ? "Please check this task."
      : "From: sender-agent@demo\nTo: dev-impl@my-rig\n---\nPlease check this task.";
    const render = (text: string) => glyph + " " + text.split("\n").join("\n  ");
    const verified = mode === "raw submitted" || mode === "envelope submitted" || mode === "after reply" || mode === "flat transcript boundary";
    let submitted = false;
    const tmux = mockTmux({
      sendKeys: async () => { submitted = true; return { ok: true }; },
      capturePaneContent: async () => {
        if (!submitted) return "Prior output\n" + glyph + " ";
        if (mode === "quoted draft") return glyph + " Check this envelope:\n  " + message.split("\n").join("\n  ");
        if (mode === "quoted prompt in draft") return render(message) + "\n  " + glyph + " quoted prompt";
        if (mode === "flat transcript boundary") return message + "\n" + glyph + " previous input\nAgent reply\n" + glyph + " ";
        const previous = mode === "after reply"
          ? render(message.replace("Please check this task.", "A different task.")) + "\nAgent reply\n" : "";
        return previous + render(message) + (verified ? "\n" + glyph + " " : "");
      },
    });
    const result = await createTransport(tmux, { sleep: async () => undefined })
      .send("dev-impl@my-rig", message, { verify: true });
    expect(result).toMatchObject({ ok: true, verified,
      outcome: verified ? "delivered" : "rendered-unconfirmed" });
  });

  it.each([
    ["raw", "same-column below draft"], ["raw", "below framed draft"],
    ["envelope", "same-column below draft"], ["envelope", "below framed draft"],
    ["envelope", "assistant quoted envelope"],
    ["envelope", "flat body »"], ["envelope", "flat body ›"], ["envelope", "flat body ❯"],
  ])("Claude verification keeps existing boundaries: %s %s", async (kind, shape) => {
    const rig = rigRepo.createRig("verification");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const address = "worker@verification";
    const session = sessionRegistry.registerSession(node.id, address);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: address });
    let message = kind === "raw" ? "Check the blue ledger, then report its total."
      : `From: sender@fixture\nTo: ${address}\nSent: 10-13 10:00Z\n---\nCheck the blue ledger.\nReport its total.\n---\n↩ Reply: rig send sender@fixture "..."`;
    const render = (glyph: string, text: string) => glyph + " " + text.split("\n").join("\n  ");
    let post = render("❯", message) + "\n» reply quotation below live input";
    if (shape === "below framed draft") post = "────────────────────\n" + render("❯", message) + "\n────────────────────\n? for shortcuts\n» later quote";
    if (shape === "assistant quoted envelope") post = "❯ Different request\nAssistant reply with quotation:\n" + render("»", message) + "\n❯ ";
    if (shape.startsWith("flat body")) {
      message = message.replace("Check the blue ledger.", shape.slice(-1) + " Check the blue ledger.");
      post = message + "\n❯ ";
    }
    let submitted = false;
    const tmux = mockTmux({
      sendKeys: async () => { submitted = true; return { ok: true }; },
      capturePaneContent: async () => submitted ? post : "❯ ",
    });
    const result = await createTransport(tmux, { sleep: async () => undefined }).send(address, message, { verify: true });
    const verified = shape === "flat body »";
    expect(result).toMatchObject({ ok: true, verified,
      outcome: verified ? "delivered" : "rendered-unconfirmed" });
  });

  it("unknown-runtime verification keeps existing boundaries", async () => {
    const { node } = seedCanonicalRig();
    db.prepare("UPDATE nodes SET runtime = NULL WHERE id = ?").run(node.id);
    expect(db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(node.id)).toEqual({ runtime: null });
    const message = "Check the blue ledger, then report its total.";
    let submitted = false;
    const tmux = mockTmux({
      sendKeys: async () => { submitted = true; return { ok: true }; },
      capturePaneContent: async () => submitted ? "❯ " + message + "\n» reply quotation below live input" : "❯ ",
    });
    const result = await createTransport(tmux, { sleep: async () => undefined })
      .send("dev-impl@my-rig", message, { verify: true });
    expect(result).toMatchObject({ ok: true, verified: false, outcome: "rendered-unconfirmed" });
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

  it.each(["draft_input_busy", "draft_input_unknown", "draft_input_changed"])(
    "a %s refusal at the text step is labeled not_reached and sends no Enter (fake receipt, not a real-guard proof)", async (code) => {
    seedCanonicalRig();
    const keys: string[][] = [];
    const tmux = mockTmux({
      sendText: async () => ({ ok: false, code, message: "held by the guard" }),
      sendKeys: async (_target, k) => { keys.push(k); return { ok: true as const }; },
    });
    const result = await createTransport(tmux).send("dev-impl@my-rig", "hello");
    expect(result).toMatchObject({ ok: false, reason: code, outcome: "failed", sent: false, inputPhase: "not_reached" });
    expect(keys).toEqual([]);
  });

  it("a draft refusal of Enter after a successful paste stays written with sent:true", async () => {
    seedCanonicalRig();
    const texts: string[] = [];
    const tmux = mockTmux({
      sendText: async (_target, text) => { texts.push(text); return { ok: true as const }; },
      sendKeys: async () => ({ ok: false, code: "draft_input_changed", message: "Enter was not sent." }),
    });
    const result = await createTransport(tmux).send("dev-impl@my-rig", "hello");
    expect(texts).toEqual(["hello"]);
    expect(result).toMatchObject({ ok: false, reason: "draft_input_changed", outcome: "failed", sent: true, inputPhase: "written" });
  });

  it("a generic failed text write stays attempted, never not_reached", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({ sendText: async () => ({ ok: false, code: "session_not_found", message: "gone" }) });
    const result = await createTransport(tmux).send("dev-impl@my-rig", "hello");
    expect(result).toMatchObject({ ok: false, reason: "send_failed", inputPhase: "attempted" });
    expect(result.sent).toBeUndefined();
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

  it("a fresh Claude working hook cannot override a visible MCP approval menu", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const capture = vi.fn(async () => [
      "2 new MCP servers found in this project",
      "Select any you wish to enable.",
      "MCP servers may execute code or access system resources. All tool calls",
      "require approval. Learn more in the MCP documentation.",
      "❯ [✔] dummy1",
      "  [✔] dummy2",
      "     Enable selected",
      "Space to select · Esc to reject all",
    ].join("\n"));
    const transport = createTransport(mockTmux({ capturePaneContent: capture, sendText: sendTextSpy }), {
      agentActivityStore,
    });

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(result.activity).toMatchObject({ state: "needs_input", reason: "selection_prompt" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("uses the recorded pane when a fresh Claude hook checks a split session", async () => {
    const { node } = seedCanonicalRig();
    sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const captures: string[] = [];
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      listPanes: async () => [{ id: "%7" }],
      capturePaneContent: async (target) => {
        captures.push(target);
        return target === "%7"
          ? "2 new MCP servers found in this project\nSelect any you wish to enable.\nMCP servers may execute code or access system resources. All tool calls\nrequire approval. Learn more in the MCP documentation.\n❯ [✔] dummy1\n  [✔] dummy2\n     Enable selected\nSpace to select · Esc to reject all"
          : "idle prompt\n❯ ";
      },
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, { agentActivityStore, eventBus });

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(captures).toContain("%7");
    expect(captures).not.toContain("dev-impl@my-rig");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("uses the recorded pane for Codex foreground verification in a split session", async () => {
    const { node } = seedCanonicalRig("codex");
    sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
    const paneCommands: string[] = [];
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      getPaneCommand: async (target) => {
        paneCommands.push(target);
        return target === "%7" ? "-codex" : "-bash";
      },
      capturePaneContent: async () => "idle prompt\n❯ ",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(result.reason).not.toBe("target_runtime_unverified");
    expect(paneCommands).toContain("%7");
    expect(paneCommands).not.toContain("dev-impl@my-rig");
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps busy sends advisory when a fresh Claude working hook has no visible prompt", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const capture = vi.fn(async () => "Working on task...\n⠋ Processing files\nesc to interrupt");
    const transport = createTransport(mockTmux({ capturePaneContent: capture, sendText: sendTextSpy }), {
      agentActivityStore,
    });

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(result.warning).toContain("target pane appears mid-task");
    expect(capture).toHaveBeenCalledTimes(1);
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
    // This tests the classification of fresh hook evidence and expiry AFTER a running observation, not
    // classification speed: freeze the deadline clock and its race timer, and advance only at the poll,
    // as the 1 ms expiry tests above do. A real 1 ms wait discards a first observation that a slow runner
    // can't finish in time, and then reads target_activity_unknown.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({
        capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
        sendText: sendTextSpy,
      });
      const sleep = vi.fn(async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); });
      const transport = createTransport(tmux, {
        agentActivityStore,
        sleep,
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
      expect(result.attempts).toBe(2);
      expect(result.waitedMs).toBe(1);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
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

  // ── #1084: --wait-for-idle must not hold the seat's serial lease ──
  function attachGuard(tmux: TmuxAdapter): SeatDeliveryGuard {
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    (tmux as unknown as { deliveryGuard?: SeatDeliveryGuard }).deliveryGuard = guard;
    return guard;
  }

  function transportWithGuard(tmux: TmuxAdapter, overrides?: {
    sleep?: (ms: number) => Promise<void>;
    waitForIdlePollMs?: number;
  }) {
    // createFullTestDb predates the guard/outbox migrations; the guard's own
    // tests exec these schemas the same way.
    attachGuard(tmux);
    return createTransport(tmux, { sleep: async () => undefined, waitForIdlePollMs: 1, ...overrides });
  }

  it("#1084: a wait-for-idle send does not hold the delivery lease while waiting", async () => {
    seedCanonicalRig();
    let bSent = false;
    let waitPolling = false;
    const order: string[] = [];
    const tmux = mockTmux({
      // Running until B's write lands, idle after: the wait can only resolve
      // once B has gone through, which requires the lease to be free.
      capturePaneContent: async () => {
        waitPolling = true;
        return bSent ? IDLE_PANE : BUSY_PANE;
      },
      sendText: async (_t, text) => {
        order.push(text);
        if (text === "B") bSent = true;
        return { ok: true as const };
      },
    });
    const transport = createTransport(tmux, {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      waitForIdlePollMs: 1,
    });
    attachGuard(tmux);

    const a = transport.send("dev-impl@my-rig", "A", { waitForIdleMs: 500 });
    while (!waitPolling) await new Promise((resolve) => setTimeout(resolve, 1));
    const b = await transport.send("dev-impl@my-rig", "B");
    const aResult = await a;

    expect(b.ok).toBe(true);
    expect(aResult.ok).toBe(true);
    expect(aResult.sent).toBe(true);
    expect(aResult.activity?.state).toBe("idle");
    // B's write landed while A was still waiting — the lease was free.
    expect(order).toEqual(["B", "A"]);
  });

  it("#1084: a pre-waited send re-checks readiness just before typing and refuses a new prompt", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    // The wait sees busy then idle (resolves); the in-lease re-check sees a
    // freshly posted picker and must refuse with the existing reason.
    const tmux = mockTmux({
      capturePaneContent: scriptedPanes([BUSY_PANE, IDLE_PANE, MENU_PANE]),
      sendText: sendTextSpy,
    });
    const transport = transportWithGuard(tmux);
    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("needs_input");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("#1084: a wait-mode send with the typing guard enabled retains immediately without waiting", async () => {
    const { node } = seedCanonicalRig();
    let captures = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => { captures++; return IDLE_PANE; },
      sendText: sendTextSpy,
    });
    const guard = attachGuard(tmux);
    await guard.set(node.id, true, "test", "test holds the seat");
    const transport = createTransport(tmux, { sleep: async () => undefined, waitForIdlePollMs: 1 });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("retained");
    expect(result.reason).toBe("typing_guard_enabled");
    expect(captures).toBe(0);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("#1084: a late wait failure surfaces instead of silently waiting twice", async () => {
    seedCanonicalRig();
    let sleeps = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const localTmux = mockTmux({
      capturePaneContent: async () => BUSY_PANE,
      sendText: sendTextSpy,
    });
    attachGuard(localTmux);
    const localTransport = createTransport(localTmux, {
      // Second poll sleep throws: a late failure inside the lease-free wait.
      sleep: async () => { sleeps++; if (sleeps === 2) throw new Error("timer fault"); },
      waitForIdlePollMs: 1,
    });

    const result = await localTransport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1000 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("guard_unavailable");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("#1084: idle at a dead budget still sends via one unraced observation", async () => {
    seedCanonicalRig();
    const started = Date.now();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const localTmux = mockTmux({
      // Busy until the budget is nearly spent, then idle — but slow to read,
      // so a raced observation against the leftover budget would lose it.
      // Flip early enough that the slow read still resolves in-budget.
      capturePaneContent: async () =>
        Date.now() - started >= 2700
          ? new Promise<string>((resolve) => setTimeout(() => resolve(IDLE_PANE), 200))
          : BUSY_PANE,
      sendText: sendTextSpy,
    });
    attachGuard(localTmux);
    const localTransport = createTransport(localTmux, {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      waitForIdlePollMs: 300,
    });

    const result = await localTransport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 3000 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.activity?.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
  });

  it("#1103 follow-up: a rewait timeout names the original --wait-for-idle value, not the remaining budget", async () => {
    seedCanonicalRig();
    const clock = steppedClock();
    try {
      const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
      // The pre-wait burns 20ms (two busy polls) then sees idle and resolves;
      // the seat is busy again at the re-check, so the remaining 80ms is
      // rewaited to expiry inside the lease. The timeout message must name the
      // configured 100ms, not the 80ms the second wait actually ran.
      const tmux = mockTmux({
        capturePaneContent: scriptedPanes([BUSY_PANE, BUSY_PANE, IDLE_PANE, BUSY_PANE]),
        sendText: sendTextSpy,
      });
      const transport = transportWithGuard(tmux, { sleep: clock.sleep, waitForIdlePollMs: 10 });
      const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 100 });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("wait_for_idle_timeout");
      expect(result.error).toContain("when the 100ms wait ended");
      expect(result.waitedMs).toBe(100);
      expect(sendTextSpy).not.toHaveBeenCalled();
    } finally { clock.restore(); }
  });

  // A terminal seat's shell runs every typed line, so it gets the exact text, never the envelope.
  function seedTerminalSeat() {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "infra.ui", { role: "ui", runtime: "terminal" });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@term-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "infra-ui@term-rig" });
  }
  const HEREDOC = "cat <<'EOF'\nSent: as typed\nEOF";

  it("send to a terminal seat types exactText exactly, with no envelope and no delivered segment", async () => {
    seedTerminalSeat();
    const sent: string[] = [];
    const tmux = mockTmux({ getPaneCommand: async () => "zsh", sendText: async (_t, text) => { sent.push(text); return { ok: true }; } });
    // The write moment is 30s after the compose stamp: an enveloped send would gain "delivered +30s".
    const transport = createTransport(tmux, { now: () => new Date("2026-08-06T17:42:39Z") });

    const result = await transport.send("infra-ui@term-rig", H_ENVELOPE, { exactText: HEREDOC, stampISO: "2026-08-06T17:42:09Z" });

    expect(result.ok).toBe(true);
    expect(result.envelopeOmitted).toBe(true);
    expect(sent).toEqual([HEREDOC]);
  });

  it("send to an agent seat ignores exactText and keeps the envelope", async () => {
    seedCanonicalRig();
    const sent: string[] = [];
    const transport = createTransport(mockTmux({ sendText: async (_t, text) => { sent.push(text); return { ok: true }; } }));

    const result = await transport.send("dev-impl@my-rig", H_ENVELOPE, { exactText: "hi" });

    expect(result.ok).toBe(true);
    expect(result.envelopeOmitted).toBeUndefined();
    expect(sent).toEqual([H_ENVELOPE]);
  });

  it("enveloped fan-out to a terminal seat and an agent seat gives each the right text", async () => {
    seedCanonicalRig(); // dev-impl@my-rig, claude-code
    seedTerminalSeat(); // infra-ui@term-rig, terminal
    const sent = new Map<string, string>();
    const tmux = mockTmux({ getPaneCommand: async () => "zsh", sendText: async (target, text) => { sent.set(target, text); return { ok: true }; } });
    const transport = createTransport(tmux);

    const result = await transport.broadcast(
      { sessions: ["dev-impl@my-rig", "infra-ui@term-rig"] },
      "make test",
      { envelopeSender: "orch@my-rig", stampISO: "2026-08-06T17:42:09Z" },
    );

    expect(result.sent).toBe(2);
    expect(sent.get("infra-ui@term-rig")).toBe("make test");
    expect(sent.get("dev-impl@my-rig")).toContain("From: orch@my-rig");
    expect(sent.get("dev-impl@my-rig")).toContain("make test");
    const byName = new Map(result.results.map((r) => [r.sessionName, r]));
    expect(byName.get("infra-ui@term-rig")?.envelopeOmitted).toBe(true);
    expect(byName.get("dev-impl@my-rig")?.envelopeOmitted).toBeUndefined();
  });

  it("a person's send (a seat actor) to a terminal seat still gets the exact text", async () => {
    seedTerminalSeat();
    const sent: string[] = [];
    const transport = createTransport(mockTmux({ getPaneCommand: async () => "zsh", sendText: async (_t, text) => { sent.push(text); return { ok: true }; } }));
    const result = await transport.send("infra-ui@term-rig", H_ENVELOPE, { exactText: "make test", actorSession: "dev-impl@my-rig" });
    expect(result).toMatchObject({ ok: true, envelopeOmitted: true });
    expect(sent).toEqual(["make test"]);
  });

  it("an urgent send to a terminal seat types the exact text without the urgent line, and keeps the mark", async () => {
    seedTerminalSeat();
    const sent: string[] = [];
    const transport = createTransport(mockTmux({ getPaneCommand: async () => "zsh", sendText: async (_t, text) => { sent.push(text); return { ok: true }; } }));
    const result = await transport.send("infra-ui@term-rig", H_ENVELOPE, { exactText: "make test", actorSession: "dev-impl@my-rig", urgent: { by: "dev-impl@my-rig" } });
    expect(result).toMatchObject({ ok: true, envelopeOmitted: true, urgent: { by: "dev-impl@my-rig" } });
    expect(sent).toEqual(["make test"]);
  });

  it("a terminal seat known only by its composed name (binding, no session row): exact text for a person; a watchdog notice carries only its marker (with no delivery guard here, it types as given)", async () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "infra.logs", { role: "logs", runtime: "terminal" });
    sessionRegistry.updateBinding(node.id, { tmuxSession: "infra-logs@term-rig" });
    const sent: string[] = [];
    const transport = createTransport(mockTmux({ getPaneCommand: async () => "zsh", sendText: async (_t, text) => { sent.push(text); return { ok: true }; } }));

    const personal = await transport.send("infra-logs@term-rig", H_ENVELOPE, { exactText: "tail -f app.log", actorSession: "dev-impl@my-rig" });
    expect(personal).toMatchObject({ ok: true, envelopeOmitted: true });
    expect(sent).toEqual(["tail -f app.log"]);

    const notice = await transport.send("infra-logs@term-rig", "[OpenRig watchdog] a reminder", { actorSession: "watchdog@system", openrigNotice: true });
    expect(notice).toMatchObject({ ok: true });
    expect(sent).toEqual(["tail -f app.log", "[OpenRig watchdog] a reminder"]);
  });

  it("a person's send from a seat in a rig named system still gets the exact text", async () => {
    seedTerminalSeat();
    const sent: string[] = [];
    const transport = createTransport(mockTmux({ getPaneCommand: async () => "zsh", sendText: async (_t, text) => { sent.push(text); return { ok: true }; } }));
    const result = await transport.send("infra-ui@term-rig", H_ENVELOPE, { exactText: "make test", actorSession: "ops-member@system" });
    expect(result).toMatchObject({ ok: true, envelopeOmitted: true });
    expect(sent).toEqual(["make test"]);
  });
});

// #1084/#1103 edge cases, contributed by z4cc in review (taken verbatim,
// credit theirs): a real SeatDeliveryGuard, a stub pane whose busy/idle
// state the test flips, and writes that call guard.checkInput() the way the
// real adapter does.
const LEASE_SEAT = "dev-impl@my-rig";
const LEASE_BUSY = "Working on task...\n⠋ Processing files\nesc to interrupt";
const LEASE_IDLE = "› Use /skills to list available skills\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig";

function leaseGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

async function leaseUntil(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("wait-for-idle outside the seat delivery lease (review cases)", () => {
  let db: Database.Database;
  let busy: boolean;
  let writes: string[];
  let blockWrite: Map<string, Promise<void>>;
  let transport: SessionTransport;
  let sessionRegistry: SessionRegistry;
  let target: GuardTarget;
  let guard: SeatDeliveryGuard;
  let tmux: Record<string, unknown>;

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
    const session = sessionRegistry.registerSession(node.id, LEASE_SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: LEASE_SEAT });

    target = { nodeId: node.id, session: LEASE_SEAT, occupant: "g1", pane: "%1" };
    guard = new SeatDeliveryGuard(db, (name) => (name === LEASE_SEAT || name === node.id ? { ...target } : null));
    busy = true;
    writes = [];
    blockWrite = new Map();
    tmux = {
      deliveryGuard: guard,
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      capturePaneContent: async () => (busy ? LEASE_BUSY : LEASE_IDLE),
      sendText: async (_target: string, text: string) => {
        guard.checkInput(LEASE_SEAT);
        writes.push(`start ${text}`);
        await (blockWrite.get(text) ?? Promise.resolve());
        writes.push(`end ${text}`);
        return { ok: true as const };
      },
      sendKeys: async () => ({ ok: true as const }),
      getPaneCommand: async () => null,
      getPanePid: async () => null,
      listPanes: async () => [],
    };
    transport = new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux as unknown as TmuxAdapter,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      waitForIdlePollMs: 5,
    });
  });

  afterEach(() => { db.close(); });

  it("re-checks a seat that turned busy again between the wait and the write", async () => {
    const blocker = leaseGate();
    blockWrite.set("blocker", blocker.opened);
    const holding = transport.send(LEASE_SEAT, "blocker");
    await leaseUntil(() => writes.includes("start blocker"));
    busy = false;
    const waiter = transport.send(LEASE_SEAT, "after idle", { waitForIdleMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    busy = true;
    blocker.open();
    await holding;
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toEqual(["start blocker", "end blocker"]);
    busy = false;
    const result = await waiter;
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(writes).toEqual(["start blocker", "end blocker", "start after idle", "end after idle"]);
  });

  it("refuses with guard_target_changed when the occupant is replaced during the wait", async () => {
    const pending = transport.send(LEASE_SEAT, "for the old occupant", { waitForIdleMs: 3000 });
    await new Promise((r) => setTimeout(r, 40));
    target = { ...target, occupant: "g2", pane: "%9" };
    busy = false;
    const result = await pending;
    expect(result).toMatchObject({ ok: false, sent: false, reason: "guard_target_changed" });
    expect(writes).toEqual([]);
  });

  it("refuses with guard_target_changed when the typing guard goes on and the occupant changes during the wait", async () => {
    const pending = transport.send(LEASE_SEAT, "for the old occupant", { waitForIdleMs: 3000 });
    await new Promise((r) => setTimeout(r, 40));
    await guard.set(target.nodeId, true, "person", "protect a draft");
    target = { ...target, occupant: "g2", pane: "%9" };
    busy = false;
    const result = await pending;
    expect(result).toMatchObject({ ok: false, sent: false, reason: "guard_target_changed" });
    expect(writes).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_entries WHERE delivery_state = 'retained'").get()).toEqual({ n: 0 });
  });

  it("refuses a missing session at once with session_missing", async () => {
    (tmux as unknown as { probeSession: unknown }).probeSession = async () => ({ state: "absent" as const });
    (tmux as unknown as { hasSession: unknown }).hasSession = async () => false;
    const started = Date.now();
    const result = await transport.send(LEASE_SEAT, "hi", { waitForIdleMs: 1500 });
    expect(result).toMatchObject({ ok: false, reason: "session_missing" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("retains a wait send to a guarded external_cli seat, as main does", async () => {
    sessionRegistry.updateBinding(target.nodeId, { attachmentType: "external_cli", externalSessionName: "ext-1" });
    await guard.set(target.nodeId, true, "person", "protect a draft");
    const result = await transport.send(LEASE_SEAT, "hi", { waitForIdleMs: 1500 });
    expect(result).toMatchObject({ ok: true, outcome: "retained" });
  });

  it("retains a forced wait send to a guarded seat, as main does", async () => {
    await guard.set(target.nodeId, true, "person", "protect a draft");
    const result = await transport.send(LEASE_SEAT, "hi", { waitForIdleMs: 1500, force: true });
    expect(result).toMatchObject({ ok: true, outcome: "retained" });
  });
});

// Claude renders its prompt suggestion faint (SGR 2) in the composer. The shape follows a real Claude
// 2.1.282 capture: `❯` and a no-break space, then the faint text. A plain capture drops the styling.
describe("a Claude prompt suggestion is not a person's draft", () => {
  const BORDER = "─".repeat(60);
  const SUGGESTION = "yes run the tests and open the PR";
  const plainPrompt = `❯\u00a0${SUGGESTION}`;
  const faintPrompt = `\x1b[39m❯\u00a0\x1b[2m${SUGGESTION}\x1b[0m`;
  const PASTE = "❯\u00a0[Pasted text #2 +29 lines]";
  // The observed layout: a framed composer, a blank row, then the mode bar.
  const framedLayout = (prompt: string, history = "● Done.") => [history, "", "✻ Baked for 1m 18s", "", `${"─".repeat(40)} dev-build@starter ─`, prompt, BORDER, "",
    "  ⏵⏵ accept edits on (shift+tab to cycle)", ""].join("\n");
  // A warning row under the mode bar, as when Claude can't auto-update into a read-only npm prefix.
  const warningLayout = (prompt: string, status = "✻ Crunched for 2s", history = "● Ready.") => [history, "", status, "", BORDER, prompt, BORDER,
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents", "  ✘ Auto-update failed: no write permission to npm prefix · Run claude doctor", ""].join("\n");
  // An unframed prompt directly above the mode bar.
  const unframedLayout = (prompt: string) => ["● Ready.", "", prompt, "  ⏵⏵ accept edits on (shift+tab to cycle)", ""].join("\n");
  const probe = (plain: string, styled: string, runtime = "claude-code") => probeSessionActivity({
    sessionName: "dev-build@starter", runtime, attachmentType: "tmux",
    tmuxAdapter: mockTmux({ capturePaneContent: async (_pane: string, _lines?: number, opts?: { escapeSequences?: boolean }) =>
      opts?.escapeSequences ? styled : plain }),
  });

  it("from a plain capture: the framed layout reads idle; the warning-row and unframed layouts read a suggestion as a draft", () => {
    expect(classifyPaneActivity(framedLayout(plainPrompt))).toMatchObject({ state: "agent_idle" });
    expect(classifyPaneActivity(warningLayout(plainPrompt))).toMatchObject({ state: "attention", reason: "prompt_draft" });
    expect(classifyPaneActivity(unframedLayout(plainPrompt))).toMatchObject({ state: "attention", reason: "prompt_draft" });
  });

  it("promptTextIsFaint is true only when the last prompt line has text and all of it is faint", () => {
    expect(promptTextIsFaint(framedLayout(faintPrompt))).toBe(true);
    expect(promptTextIsFaint(framedLayout(plainPrompt))).toBe(false); // no styling never proves faint
    expect(promptTextIsFaint(framedLayout(PASTE))).toBe(false); // a pasted placeholder
    expect(promptTextIsFaint(framedLayout("❯\u00a0owned\x1b[2m ghost suffix\x1b[22m"))).toBe(false); // typed text, then a suggestion
    expect(promptTextIsFaint(framedLayout("❯\u00a0\x1b[2mghost\x1b[22m typed"))).toBe(false); // a reset mid-line
    expect(promptTextIsFaint(framedLayout(`❯\u00a0\x1b[38;5;2m${SUGGESTION}\x1b[39m`))).toBe(false); // a 256-colour value of 2
    expect(promptTextIsFaint(framedLayout(`❯\u00a0\x1b[38;2;2;2;2m${SUGGESTION}\x1b[39m`))).toBe(false); // an RGB colour of 2;2;2
    expect(promptTextIsFaint(framedLayout("❯\u00a0"))).toBe(false); // an empty composer
    expect(promptTextIsFaint(framedLayout("❯\u00a0", faintPrompt))).toBe(false); // an empty composer below an older faint prompt
  });

  it("classifyStyledFrame finds a suggestion only in its own frame's current composer", () => {
    expect(classifyStyledFrame(warningLayout(faintPrompt)).suggestion).toMatchObject({ state: "agent_idle" });
    // A faint prompt in scrollback above a typed composer proves nothing about the composer.
    expect(classifyStyledFrame(warningLayout("❯\u00a0typed by hand", undefined, faintPrompt)).suggestion).toBeNull();
    expect(classifyStyledFrame(warningLayout("❯\u00a0typed by hand")).suggestion).toBeNull();
    // An empty composer below an older faint prompt: the composer decides, not the scrollback line.
    expect(classifyStyledFrame(warningLayout("❯\u00a0", undefined, faintPrompt)).suggestion).toBeNull();
    expect(classifyStyledFrame(warningLayout(PASTE)).suggestion).toBeNull();
  });

  it.each([["warning-row", warningLayout], ["unframed", unframedLayout]] as const)(
    "the %s layout: a faint suggestion reads idle; typed text and a pasted placeholder still need input", async (_label, layout) => {
      expect(await probe(layout(plainPrompt), layout(faintPrompt))).toMatchObject({ state: "idle" });
      expect(await probe(layout(plainPrompt), layout(plainPrompt))).toMatchObject({ state: "needs_input", reason: "prompt_draft" });
      expect(await probe(layout(PASTE), layout(PASTE))).toMatchObject({ state: "needs_input", reason: "prompt_draft" });
    });

  it("between the two captures: a stable suggestion reads idle, a changed one stays a draft, newer attention or work is kept", async () => {
    expect(await probe(warningLayout(plainPrompt), warningLayout(faintPrompt))).toMatchObject({ state: "idle" });
    // The suggestion changed: the first capture's draft text isn't what the styled frame shows.
    expect(await probe(warningLayout(plainPrompt), warningLayout("\x1b[39m❯\u00a0\x1b[2mshow me the diff\x1b[0m")))
      .toMatchObject({ state: "needs_input", reason: "prompt_draft" });
    // Evidence is compacted and truncated, so the full composer text is what must match: drafts that
    // differ only in internal spacing, or share their first 240 characters, are different text.
    expect(await probe(warningLayout("❯\u00a0yes run  the tests and open the PR"), warningLayout(faintPrompt)))
      .toMatchObject({ state: "needs_input", reason: "prompt_draft" });
    const long = "word ".repeat(60);
    expect(await probe(warningLayout(`❯\u00a0${long}first`), warningLayout(`\x1b[39m❯\u00a0\x1b[2m${long}second\x1b[0m`)))
      .toMatchObject({ state: "needs_input", reason: "prompt_draft" });
    // Typed text in the styled frame.
    expect(await probe(warningLayout(plainPrompt), warningLayout(plainPrompt))).toMatchObject({ state: "needs_input", reason: "prompt_draft" });
    // The seat started work: its live status row in the styled frame is kept.
    expect(await probe(warningLayout(plainPrompt), warningLayout(faintPrompt, "✻ Onioning… (2m 38s · ↓ 10.9k tokens · thought for 8s)")))
      .toMatchObject({ state: "running" });
    // A permission prompt appeared: the styled frame's attention is kept.
    expect(await probe(warningLayout(plainPrompt), warningLayout(faintPrompt, "Do you want to proceed?")))
      .toMatchObject({ state: "needs_input", reason: "permission_prompt" });
  });

  it("only a Claude seat gets the styled check", async () => {
    const captures: Array<boolean> = [];
    await probeSessionActivity({
      sessionName: "dev-build@starter", runtime: "codex", attachmentType: "tmux",
      tmuxAdapter: mockTmux({ capturePaneContent: async (_pane: string, _lines?: number, opts?: { escapeSequences?: boolean }) => {
        captures.push(opts?.escapeSequences === true); return unframedLayout(plainPrompt); } }),
    });
    expect(captures).toEqual([false]);
  });
});

describe("startup readiness reconciliation on session interaction (#7)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRig(runtime = "codex") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "worker-1", { role: "worker", runtime });
    const session = sessionRegistry.registerSession(node.id, "worker-1@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "worker-1@test-rig" });
    return { rig, node, session };
  }

  function seedStartupFailureEvent(rigId: string, nodeId: string, sessionId: string, overrides?: Record<string, unknown>) {
    return db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(
      rigId,
      nodeId,
      "node.startup_failed",
      JSON.stringify({
        type: "node.startup_failed",
        sessionId,
        stage: "readiness_check",
        hasPendingWork: false,
        error: "Readiness timeout after 30s — harness did not become interactive: transient auth delay",
        requestedResumeToken: null,
        requestedResumeType: null,
        ...overrides,
      }),
    );
  }

  it("reconciles failed startup status to ready on successful send when adapter reports ready", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");

    seedStartupFailureEvent(rig.id, node.id, session.id, {
      stage: "readiness_check",
      hasPendingWork: false,
      error: "Readiness timeout after 30s — harness did not become interactive: transient auth delay",
    });

    const initialInventory = getNodeInventory(db, rig.id);
    expect(initialInventory[0]?.startupStatus).toBe("failed");
    expect(initialInventory[0]?.latestError).toBe("Readiness timeout after 30s — harness did not become interactive: transient auth delay");

    const emittedEvents: unknown[] = [];
    eventBus.subscribe((evt) => {
      if (evt.type === "node.startup_ready") emittedEvents.push(evt);
    });

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);
    expect(checkReadyMock).toHaveBeenCalledTimes(1);

    const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
      startup_status: string;
      startup_completed_at: string | null;
    };
    expect(sessionRow.startup_status).toBe("ready");
    expect(sessionRow.startup_completed_at).not.toBeNull();

    const updatedInventory = getNodeInventory(db, rig.id);
    expect(updatedInventory[0]?.startupStatus).toBe("ready");
    expect(updatedInventory[0]?.latestError).toBeNull();

    expect(emittedEvents).toEqual([
      expect.objectContaining({
        type: "node.startup_ready",
        rigId: rig.id,
        nodeId: node.id,
        previousStatus: "failed",
      }),
    ]);
  });

  it("reconciles attention_required startup status to ready without routing through attention-cleared path", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "attention_required");

    seedStartupFailureEvent(rig.id, node.id, session.id, {
      stage: "readiness_check",
      hasPendingWork: false,
      error: "Startup requires attention",
    });

    const emittedReady: unknown[] = [];
    const emittedAttentionCleared: unknown[] = [];
    eventBus.subscribe((evt) => {
      if (evt.type === "node.startup_ready") emittedReady.push(evt);
      if (evt.type === "seat.attention_cleared") emittedAttentionCleared.push(evt);
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: vi.fn().mockResolvedValue({ ready: true }) },
      },
    });

    const result = await transport.send("worker-1@test-rig", "hello");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("ready");

    expect(emittedAttentionCleared).toHaveLength(0);
    expect(emittedReady).toEqual([
      expect.objectContaining({
        type: "node.startup_ready",
        rigId: rig.id,
        nodeId: node.id,
        previousStatus: "attention_required",
      }),
    ]);
  });

  it("reconciles failed startup status to ready on successful capture", async () => {
    const { rig, node, session } = seedRig("claude-code");
    sessionRegistry.updateStartupStatus(session.id, "failed");

    seedStartupFailureEvent(rig.id, node.id, session.id, {
      stage: "readiness_check",
      hasPendingWork: false,
      error: "Readiness timeout after 30s",
    });

    const emittedReady: unknown[] = [];
    eventBus.subscribe((evt) => {
      if (evt.type === "node.startup_ready") emittedReady.push(evt);
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux({
        capturePaneContent: async () => "› Current idle prompt\n────────────\n",
      }),
      eventBus,
      runtimeAdapters: {
        "claude-code": { checkReady: vi.fn().mockResolvedValue({ ready: true }) },
      },
    });

    const captured = await transport.capture("worker-1@test-rig");
    expect(captured).not.toBeNull();

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("ready");
    expect(emittedReady).toEqual([
      expect.objectContaining({
        type: "node.startup_ready",
        rigId: rig.id,
        nodeId: node.id,
        previousStatus: "failed",
      }),
    ]);
  });

  describe("a Claude seat with no launch record (#1477 section 2)", () => {
    const resumeToken = "00000000-0000-4000-8000-000000001477";
    function seedClaude(status: "failed" | "attention_required") {
      const { rig, node, session } = seedRig("claude-code");
      sessionRegistry.updateStartupStatus(session.id, status);
      sessionRegistry.updateResumeToken(session.id, "claude_id", resumeToken);
      sessionRegistry.updateBinding(node.id, { tmuxPane: "%1" });
      seedStartupFailureEvent(rig.id, node.id, session.id, { requestedResumeToken: resumeToken, requestedResumeType: "claude_id" });
      return { rig, node, session };
    }
    const transportWith = (checkReady: (binding: NodeBinding, opts?: { resumeToken?: string | null }) => Promise<{ ready: boolean }>) =>
      new SessionTransport({ db, rigRepo, sessionRegistry, eventBus,
        tmuxAdapter: mockTmux({ capturePaneContent: async () => "› Current idle prompt\n────────────\n" }),
        runtimeAdapters: { "claude-code": { checkReady } as never } });
    const startupStatus = (id: string) => (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(id) as { startup_status: string }).startup_status;

    it("passes the seat's real binding and its recorded resume token to the readiness check", async () => {
      const { node } = seedClaude("attention_required");
      const check = vi.fn(async () => ({ ready: false }));
      await transportWith(check).capture("worker-1@test-rig");
      expect(check).toHaveBeenCalledTimes(1);
      const [binding, options] = check.mock.calls[0] as unknown as [NodeBinding, { resumeToken?: string }];
      expect(binding).toMatchObject({ nodeId: node.id, tmuxSession: "worker-1@test-rig", tmuxPane: "%1" });
      expect(options).toEqual({ resumeToken: resumeToken });
    });

    it.each(["failed", "attention_required"] as const)("promotes a %s seat the real adapter proves, with no attention-cleared event", async from => {
      const { session } = seedClaude(from);
      const { adapter } = claudeSeat();
      const cleared: unknown[] = [];
      eventBus.subscribe(evt => { if (evt.type === "seat.attention_cleared") cleared.push(evt); });
      await transportWith((binding, opts) => adapter.checkReady(binding, opts)).capture("worker-1@test-rig");
      expect(startupStatus(session.id)).toBe("ready");
      expect(cleared).toEqual([]);
    });

    it("passes the rotation recorded with the token, and the real adapter promotes a rotated seat by it", async () => {
      const { session } = seedClaude("attention_required");
      recordRotation(db, session.id);
      const check = vi.fn(async () => ({ ready: false }));
      await transportWith(check).capture("worker-1@test-rig");
      expect(check.mock.calls[0]![1]).toEqual({ resumeToken: rotatedToken, resumeRotation: rotation });
      const { adapter } = claudeSeat();
      await transportWith((binding, opts) => adapter.checkReady(binding, opts)).capture("worker-1@test-rig");
      expect(startupStatus(session.id)).toBe("ready");
    });

    // The anchor (#1477, the maintainer's shape) is the reconcile's own existing comparison; these pin it beside the proof.
    describe("the requested conversation", () => {
      const reconcile = async (session: { id: string }) => {
        const { adapter } = claudeSeat();
        await transportWith((binding, opts) => adapter.checkReady(binding, opts)).capture("worker-1@test-rig");
        return startupStatus(session.id);
      };
      const reseed = (ids: ReturnType<typeof seedClaude>, fields: Record<string, unknown>) => {
        db.prepare("DELETE FROM events WHERE type = 'node.startup_failed'").run();
        seedStartupFailureEvent(ids.rig.id, ids.node.id, ids.session.id, fields);
      };

      it("leaves flagged a seat whose record and process are on another conversation than the one it asked for", async () => {
        const ids = seedClaude("attention_required");
        reseed(ids, { requestedResumeToken: requestedToken, requestedResumeType: "claude_id" });
        expect(await reconcile(ids.session)).toBe("attention_required");
      });

      it("promotes a seat whose recorded rotation started from the requested conversation, which the process names", async () => {
        const ids = seedClaude("attention_required");
        recordRotation(db, ids.session.id);
        reseed(ids, { requestedResumeToken: resumeToken, requestedResumeType: "claude_id" });
        expect(await reconcile(ids.session)).toBe("ready");
      });

      it("promotes a fresh launch (null request)", async () => {
        const fresh = seedClaude("attention_required");
        reseed(fresh, { requestedResumeToken: null, requestedResumeType: null });
        expect(await reconcile(fresh.session)).toBe("ready");
      });

      it("keeps the reconcile's existing hold for an older event without the request fields", async () => {
        const older = seedClaude("attention_required");
        db.prepare("DELETE FROM events WHERE type = 'node.startup_failed' AND node_id = ?").run(older.node.id);
        db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'node.startup_failed', ?)").run(older.rig.id, older.node.id,
          JSON.stringify({ type: "node.startup_failed", sessionId: older.session.id, stage: "readiness_check", hasPendingWork: false, error: "x" }));
        expect(await reconcile(older.session)).toBe("attention_required");
      });

      it("still compares the process with the record after an in-process /resume", async () => {
        const ids = seedClaude("attention_required");
        db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run(rotatedToken, ids.session.id);
        reseed(ids, { requestedResumeToken: resumeToken, requestedResumeType: "claude_id" });
        expect(await reconcile(ids.session)).toBe("attention_required");
      });
    });

    it("leaves a seat whose pane runs another conversation flagged", async () => {
      const { session } = seedClaude("attention_required");
      const { adapter, set } = claudeSeat();
      set(claudeRows({ command: "/x/claude --permission-mode auto --resume other --name seat@rig" }));
      await transportWith((binding, opts) => adapter.checkReady(binding, opts)).capture("worker-1@test-rig");
      expect(startupStatus(session.id)).toBe("attention_required");
    });
  });

  it("does not reconcile non-recoverable startup failure even if prompt is responsive", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");

    seedStartupFailureEvent(rig.id, node.id, session.id, {
      stage: "post_launch_files",
      hasPendingWork: true,
      error: "Post-launch file delivery failed: /workspace/file.txt: write error",
    });

    const emittedReady: unknown[] = [];
    eventBus.subscribe((evt) => {
      if (evt.type === "node.startup_ready") emittedReady.push(evt);
    });

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    expect(checkReadyMock).not.toHaveBeenCalled();
    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
    expect(emittedReady).toHaveLength(0);
  });

  it("does not reconcile if startup work is still pending according to attempt record", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");

    seedStartupFailureEvent(rig.id, node.id, session.id, {
      stage: "readiness_check",
      hasPendingWork: true,
      error: "Readiness timeout after 30s",
    });

    const emittedReady: unknown[] = [];
    eventBus.subscribe((evt) => {
      if (evt.type === "node.startup_ready") emittedReady.push(evt);
    });

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    expect(checkReadyMock).not.toHaveBeenCalled();
    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
    expect(emittedReady).toHaveLength(0);
  });

  it("recovers after delivered actions through send or capture without clearing the saved plan", async () => {
    const { rig, node, session } = seedRig("codex");

    // Drive real StartupOrchestrator: step 6 passes, actions delivered, step 10 post-delivery gate fails
    let stepCount = 0;
    const adapter: RuntimeAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
      checkReady: vi.fn(async () => {
        stepCount++;
        if (stepCount === 1) return { ready: true };
        return { ready: false, code: "update_gate", reason: "Native provider prerequisite failed after context delivery." };
      }),
      launchHarness: vi.fn(async () => ({ ok: true })),
    };

    const orchestrator = new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: mockTmux(),
      sleep: async () => {},
    });

    const startResult = await orchestrator.startNode({
      rigId: rig.id,
      nodeId: node.id,
      sessionId: session.id,
      binding: {
        id: "b1",
        nodeId: node.id,
        tmuxSession: "worker-1@test-rig",
        tmuxWindow: null,
        tmuxPane: null,
        cmuxWorkspace: null,
        cmuxSurface: null,
        updatedAt: "",
        cwd: ".",
      },
      adapter,
      plan: {
        runtime: "codex",
        cwd: ".",
        entries: [],
        startup: { files: [], actions: [] },
        conflicts: [],
        noOps: [],
        diagnostics: [],
      },
      resolvedStartupFiles: [
        {
          path: "role.md",
          absolutePath: "/tmp/role.md",
          ownerRoot: "/tmp",
          deliveryHint: "auto",
          required: true,
          appliesOn: ["fresh_start"],
        },
      ],
      startupActions: [{ type: "slash_command", value: "/init", phase: "after_files", appliesOn: ["fresh_start"], idempotent: true }],
      isRestore: false,
    });

    expect(startResult.ok).toBe(false);
    expect(startResult.startupStatus).toBe("attention_required");

    // StartupOrchestrator recorded event with stage: "post_delivery_readiness" and hasPendingWork: false
    const failedEventRow = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1").get(node.id) as { payload: string };
    const failedEvent = JSON.parse(failedEventRow.payload);
    expect(failedEvent.stage).toBe("post_delivery_readiness");
    expect(failedEvent.hasPendingWork).toBe(false);

    const planBefore = db.prepare("SELECT resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?").get(node.id) as { resolved_files_json: string; startup_actions_json: string };
    expect(planBefore.resolved_files_json).toContain("role.md");

    // Gate clears: adapter reports ready on interaction
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: vi.fn().mockResolvedValue({ ready: true }) },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo recovered");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
      startup_status: string;
      startup_completed_at: string | null;
    };
    expect(sessionRow.startup_status).toBe("ready");
    expect(sessionRow.startup_completed_at).not.toBeNull();

    // Saved plan was not cleared, consumed, or modified
    const planAfter = db.prepare("SELECT resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?").get(node.id) as { resolved_files_json: string; startup_actions_json: string };
    expect(planAfter).toEqual(planBefore);
  });

  describe("attempt fence across probe and write", () => {
    it("does not overwrite a newer startup attempt when probe returns ready", async () => {
      const { rig, node, session } = seedRig("codex");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

      let onProbeStart!: () => void;
      const probeStarted = new Promise<void>((r) => {
        onProbeStart = r;
      });
      let resolveProbe!: (value: { ready: boolean }) => void;
      const probePromise = new Promise<{ ready: boolean }>((res) => {
        resolveProbe = res;
      });

      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        sleep: async () => {},
        runtimeAdapters: {
          codex: {
            checkReady: vi.fn().mockImplementation(() => {
              onProbeStart();
              return probePromise;
            }),
          },
        },
      });

      const sendPromise = transport.send("worker-1@test-rig", "echo ping");

      await probeStarted;

      // Real newer StartupOrchestrator attempt starts while probe is still out
      const secondAdapter: RuntimeAdapter = {
        runtime: "codex",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        launchHarness: vi.fn(async () => ({ ok: true })),
        checkReady: vi.fn(async () => ({ ready: false, reason: "newer second attempt failed" })),
      };

      const orchestrator = new StartupOrchestrator({
        db,
        sessionRegistry,
        eventBus,
        tmuxAdapter: mockTmux(),
        sleep: async () => {},
      });

      const secondStartupPromise = orchestrator.startNode({
        rigId: rig.id,
        nodeId: node.id,
        sessionId: session.id,
        binding: {
          id: "b1",
          nodeId: node.id,
          attachmentType: "tmux",
          tmuxSession: "worker-1@test-rig",
          tmuxWindow: null,
          tmuxPane: null,
          cmuxWorkspace: null,
          cmuxSurface: null,
          updatedAt: "",
          cwd: ".",
        },
        adapter: secondAdapter,
        plan: {
          runtime: "codex",
          cwd: ".",
          entries: [],
          startup: { files: [], actions: [] },
          conflicts: [],
          noOps: [],
          diagnostics: [],
        },
        resolvedStartupFiles: [],
        startupActions: [],
        isRestore: false,
        readinessTimeoutMs: 1,
      });

      // Newer StartupOrchestrator attempt finishes failed before older probe commits
      const secondResult = await secondStartupPromise;
      expect(secondResult.ok).toBe(false);

      // Now older probe returns ready
      resolveProbe({ ready: true });
      await sendPromise;

      const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
        startup_status: string;
        startup_completed_at: string | null;
      };
      expect(sessionRow.startup_status).toBe("failed");
      expect(sessionRow.startup_completed_at).toBeNull();

      const readyEvents = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(node.id);
      expect(readyEvents).toHaveLength(0);

      const latestEventRow = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1").get(node.id) as { payload: string };
      const latestEvent = JSON.parse(latestEventRow.payload);
      expect(latestEvent.error).toContain("newer second attempt failed");
    });

    it("does not overwrite a newer startup attempt when probe returns attention code", async () => {
      const { rig, node, session } = seedRig("codex");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

      let resolveProbe!: (value: { ready: boolean; code?: string }) => void;
      const probePromise = new Promise<{ ready: boolean; code?: string }>((res) => {
        resolveProbe = res;
      });

      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: {
          codex: { checkReady: vi.fn().mockImplementation(() => probePromise) },
        },
      });

      const sendPromise = transport.send("worker-1@test-rig", "echo ping");

      await new Promise((r) => setTimeout(r, 20));

      // Newer startup attempt starts
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'node.startup_pending', ?)").run(
        rig.id,
        node.id,
        JSON.stringify({ type: "node.startup_pending", sessionId: session.id }),
      );

      resolveProbe({ ready: false, code: "update_gate" });
      await sendPromise;

      const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
      expect(sessionRow.startup_status).toBe("failed");
    });
  });

  // #1405: the shared classifier drives the adapter's readiness here, through the real startup flow.
  describe("Claude's not-logged-in footer and a current login refusal through startup", () => {
    const frame = ["", "─".repeat(40), "❯ ", "─".repeat(40), "                    Not logged in · Run /login", "  ⏵⏵ accept edits on (shift+tab to cycle)"];
    const footerOnly = [" ▐▛███▛█   Claude Code v2.1.296", ...frame].join("\n");
    const refused = [" ▐▛███▛█   Claude Code v2.1.296", "", "❯ /init", "", "● Not logged in · Please run /login", ...frame].join("\n");
    const readiness = (paneContent: string) => {
      const probe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent });
      return probe.status === "resumed" ? { ready: true } : { ready: false, code: probe.code, reason: probe.detail };
    };

    async function startWithPanes(panes: string[]) {
      const { rig, node, session } = seedRig("claude-code");
      let reads = 0;
      const adapter: RuntimeAdapter = {
        runtime: "claude-code",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => readiness(panes[Math.min(reads++, panes.length - 1)]!)),
        launchHarness: vi.fn(async () => ({ ok: true })),
      };
      const orchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: mockTmux(), sleep: async () => {} });
      const result = await orchestrator.startNode({
        rigId: rig.id, nodeId: node.id, sessionId: session.id,
        binding: { id: "b1", nodeId: node.id, tmuxSession: "worker-1@test-rig", tmuxWindow: null, tmuxPane: null,
          cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
        adapter,
        plan: { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
        resolvedStartupFiles: [],
        startupActions: [{ type: "slash_command", value: "/init", phase: "after_files", appliesOn: ["fresh_start"], idempotent: true }],
        isRestore: false,
      });
      const status = (db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string }).startup_status;
      const failed = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1").get(node.id) as { payload: string } | undefined;
      return { result, status, reads: (adapter.checkReady as ReturnType<typeof vi.fn>).mock.calls.length, failedStage: failed ? JSON.parse(failed.payload).stage : null };
    }

    it("starts a seat that shows only the footer and delivers its startup context", async () => {
      const started = await startWithPanes([footerOnly]);
      expect(started.result.ok).toBe(true);
      expect(started.status).toBe("ready");
      expect(started.failedStage).toBeNull();
    });

    it("needs attention when a current refusal is visible at the post-delivery observation", async () => {
      const started = await startWithPanes([footerOnly, refused]);
      expect(started.result.ok).toBe(false);
      expect(started.status).toBe("attention_required");
      expect(started.failedStage).toBe("post_delivery_readiness");
    });

    it("does not see a refusal that appears only after the one post-delivery observation", async () => {
      const started = await startWithPanes([footerOnly, footerOnly, refused]);
      expect(started.reads).toBe(2);
      expect(started.result.ok).toBe(true);
      expect(started.status).toBe("ready");
      // A later read of the same pane reports it; startup does not wait or poll for one.
      expect(readiness(refused)).toMatchObject({ ready: false, code: "login_required" });
    });
  });

  describe("remaining Claude resume identity work at both readiness points", () => {
    it("counts remaining Claude resume identity check as required work at initial readiness check (point 1)", async () => {
      const { rig, node, session } = seedRig("claude-code");
      db.prepare("UPDATE sessions SET resume_token = ?, resume_type = ? WHERE id = ?").run(
        "token-abc",
        "codex_thread_id",
        session.id,
      );

      const adapter: RuntimeAdapter = {
        runtime: "claude-code",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => ({ ready: false, reason: "initial readiness timeout" })),
        launchHarness: vi.fn(async () => ({ ok: true, resumeToken: "token-abc" })),
      };

      const orchestrator = new StartupOrchestrator({
        db,
        sessionRegistry,
        eventBus,
        tmuxAdapter: mockTmux(),
        sleep: async () => {},
      });

      const startResult = await orchestrator.startNode({
        rigId: rig.id,
        nodeId: node.id,
        sessionId: session.id,
        binding: {
          id: "b1",
          nodeId: node.id,
          tmuxSession: "worker-1@test-rig",
          tmuxWindow: null,
          tmuxPane: null,
          cmuxWorkspace: null,
          cmuxSurface: null,
          updatedAt: "",
          cwd: ".",
        },
        adapter,
        plan: {
          runtime: "claude-code",
          cwd: ".",
          entries: [],
          startup: { files: [], actions: [] },
          conflicts: [],
          noOps: [],
          diagnostics: [],
        },
        resolvedStartupFiles: [],
        startupActions: [],
        isRestore: false,
        resumeToken: "token-abc",
        resumeType: "codex_thread_id",
        readinessTimeoutMs: 1,
      });

      expect(startResult.ok).toBe(false);

      const eventRow = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1").get(node.id) as { payload: string };
      const event = JSON.parse(eventRow.payload);
      expect(event.stage).toBe("readiness_check");
      expect(event.hasPendingWork).toBe(true);

      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: {
          "claude-code": { checkReady: vi.fn().mockResolvedValue({ ready: true }) },
        },
      });

      await transport.send("worker-1@test-rig", "echo ping");
      const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
      expect(sessionRow.startup_status).not.toBe("ready");
    });

    it("counts remaining Claude resume identity check as required work at post-delivery gate (point 2)", async () => {
      const { rig, node, session } = seedRig("claude-code");
      db.prepare("UPDATE sessions SET resume_token = ?, resume_type = ? WHERE id = ?").run(
        "token-abc",
        "codex_thread_id",
        session.id,
      );

      let stepCount = 0;
      const adapter: RuntimeAdapter = {
        runtime: "claude-code",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 1, failed: [] })),
        checkReady: vi.fn(async () => {
          stepCount++;
          if (stepCount === 1) return { ready: true };
          return { ready: false, code: "update_gate", reason: "gate after files" };
        }),
        launchHarness: vi.fn(async () => ({ ok: true, resumeToken: "token-abc" })),
      };

      const orchestrator = new StartupOrchestrator({
        db,
        sessionRegistry,
        eventBus,
        tmuxAdapter: mockTmux(),
        sleep: async () => {},
      });

      const startResult = await orchestrator.startNode({
        rigId: rig.id,
        nodeId: node.id,
        sessionId: session.id,
        binding: {
          id: "b1",
          nodeId: node.id,
          tmuxSession: "worker-1@test-rig",
          tmuxWindow: null,
          tmuxPane: null,
          cmuxWorkspace: null,
          cmuxSurface: null,
          updatedAt: "",
          cwd: ".",
        },
        adapter,
        plan: {
          runtime: "claude-code",
          cwd: ".",
          entries: [],
          startup: { files: [], actions: [] },
          conflicts: [],
          noOps: [],
          diagnostics: [],
        },
        resolvedStartupFiles: [],
        startupActions: [{ type: "slash_command", value: "/init", phase: "after_files", appliesOn: ["fresh_start"], idempotent: true }],
        isRestore: false,
        resumeToken: "token-abc",
        resumeType: "codex_thread_id",
      });

      expect(startResult.ok).toBe(false);

      const eventRow = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1").get(node.id) as { payload: string };
      const event = JSON.parse(eventRow.payload);
      expect(event.stage).toBe("post_delivery_readiness");
      expect(event.hasPendingWork).toBe(true);

      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: {
          "claude-code": { checkReady: vi.fn().mockResolvedValue({ ready: true }) },
        },
      });

      await transport.send("worker-1@test-rig", "echo ping");
      const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
      expect(sessionRow.startup_status).not.toBe("ready");
    });

    it("leaves seat failed when stored Claude session identity changes during initial readiness read and that read fails", async () => {
      const { rig, node, session } = seedRig("claude-code");
      db.prepare("UPDATE sessions SET resume_token = ?, resume_type = ? WHERE id = ?").run(
        "token-A",
        "claude_id",
        session.id,
      );

      const adapter: RuntimeAdapter = {
        runtime: "claude-code",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => {
          // Stored Claude session identity changes while initial readiness read is in progress
          db.prepare("UPDATE sessions SET resume_token = ?, resume_type = ? WHERE id = ?").run(
            "token-B",
            "claude_id",
            session.id,
          );
          return { ready: false, reason: "initial readiness read failed" };
        }),
        launchHarness: vi.fn(async () => ({ ok: true, resumeToken: "token-A" })),
      };

      const orchestrator = new StartupOrchestrator({
        db,
        sessionRegistry,
        eventBus,
        tmuxAdapter: mockTmux(),
        sleep: async () => {},
      });

      const startResult = await orchestrator.startNode({
        rigId: rig.id,
        nodeId: node.id,
        sessionId: session.id,
        binding: {
          id: "b1",
          nodeId: node.id,
          attachmentType: "tmux",
          tmuxSession: "worker-1@test-rig",
          tmuxWindow: null,
          tmuxPane: null,
          cmuxWorkspace: null,
          cmuxSurface: null,
          updatedAt: "",
          cwd: ".",
        },
        adapter,
        plan: {
          runtime: "claude-code",
          cwd: ".",
          entries: [],
          startup: { files: [], actions: [] },
          conflicts: [],
          noOps: [],
          diagnostics: [],
        },
        resolvedStartupFiles: [],
        startupActions: [],
        isRestore: false,
        resumeToken: "token-A",
        resumeType: "claude_id",
        readinessTimeoutMs: 1,
      });

      expect(startResult.ok).toBe(false);

      const eventRow = db.prepare(
        "SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1",
      ).get(node.id) as { payload: string };
      const event = JSON.parse(eventRow.payload);
      expect(event.stage).toBe("readiness_check");
      expect(event.hasPendingWork).toBe(true);
      expect(event.requestedResumeToken).toBe("token-A");
      expect(event.requestedResumeType).toBe("claude_id");

      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: {
          "claude-code": { checkReady: vi.fn().mockResolvedValue({ ready: true }) },
        },
      });

      await transport.capture("worker-1@test-rig");
      const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
        startup_status: string;
        startup_completed_at: string | null;
      };
      expect(sessionRow.startup_status).toBe("failed");
      expect(sessionRow.startup_completed_at).toBeNull();

      const readyEvents = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(node.id);
      expect(readyEvents).toHaveLength(0);
    });

    it("leaves seat in non-ready state without completion stamp when startup_failed event lacks requested identity fields", async () => {
      const { rig, node, session } = seedRig("claude-code");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      db.prepare("UPDATE sessions SET resume_token = ?, resume_type = ? WHERE id = ?").run(
        "token-stored",
        "claude_id",
        session.id,
      );

      // Failure event without requestedResumeToken and requestedResumeType
      seedStartupFailureEvent(rig.id, node.id, session.id, {
        stage: "readiness_check",
        hasPendingWork: false,
        requestedResumeToken: undefined,
        requestedResumeType: undefined,
      });

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: {
          "claude-code": { checkReady: checkReadyMock },
        },
      });

      const result = await transport.send("worker-1@test-rig", "echo ping");
      expect(result.ok).toBe(true);

      const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
        startup_status: string;
        startup_completed_at: string | null;
      };
      expect(sessionRow.startup_status).toBe("attention_required");
      expect(sessionRow.startup_completed_at).toBeNull();

      const readyEvents = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(node.id);
      expect(readyEvents).toHaveLength(0);
    });

    it("recovers explicit fresh launch when startup_failed event carries requestedResumeToken as null", async () => {
      const { rig, node, session } = seedRig("claude-code");
      sessionRegistry.updateStartupStatus(session.id, "failed");

      seedStartupFailureEvent(rig.id, node.id, session.id, {
        stage: "readiness_check",
        hasPendingWork: false,
        requestedResumeToken: null,
        requestedResumeType: null,
      });

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: {
          "claude-code": { checkReady: checkReadyMock },
        },
      });

      const result = await transport.send("worker-1@test-rig", "echo ping");
      expect(result.ok).toBe(true);

      const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
        startup_status: string;
        startup_completed_at: string | null;
      };
      expect(sessionRow.startup_status).toBe("ready");
      expect(sessionRow.startup_completed_at).not.toBeNull();

      const readyEvents = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(node.id);
      expect(readyEvents).toHaveLength(1);
    });

    it("recovers when startup_failed event carries matching requested identity", async () => {
      const { rig, node, session } = seedRig("claude-code");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      sessionRegistry.updateResumeToken(session.id, "claude_id", "token-match", "hook");

      seedStartupFailureEvent(rig.id, node.id, session.id, {
        stage: "readiness_check",
        hasPendingWork: false,
        requestedResumeToken: "token-match",
        requestedResumeType: "claude_id",
      });

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        sleep: async () => {},
        runtimeAdapters: {
          "claude-code": { checkReady: checkReadyMock },
        },
      });

      const result = await transport.send("worker-1@test-rig", "echo ping");
      expect(result.ok).toBe(true);

      const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
        startup_status: string;
        startup_completed_at: string | null;
      };
      expect(sessionRow.startup_status).toBe("ready");
      expect(sessionRow.startup_completed_at).not.toBeNull();

      const readyEvents = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(node.id);
      expect(readyEvents).toHaveLength(1);
    });

    it("recovers when startup_failed event carries verified rotated identity", async () => {
      const { rig, node, session } = seedRig("claude-code");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      sessionRegistry.updateResumeToken(session.id, "claude_id", "token-new", "hook");
      db.prepare("UPDATE sessions SET resume_rotated_from = ?, resume_rotated_process = ?, resume_launch_process = ? WHERE id = ?")
        .run("token-old", JSON.stringify({ pid: 11, startedAt: "start" }), JSON.stringify({ token: "token-old", pid: 11, startedAt: "start" }), session.id);

      seedStartupFailureEvent(rig.id, node.id, session.id, {
        stage: "readiness_check",
        hasPendingWork: false,
        requestedResumeToken: "token-old",
        requestedResumeType: "claude_id",
      });

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        sleep: async () => {},
        runtimeAdapters: {
          "claude-code": { checkReady: checkReadyMock },
        },
      });

      const result = await transport.send("worker-1@test-rig", "echo ping");
      expect(result.ok).toBe(true);

      const sessionRow = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
        startup_status: string;
        startup_completed_at: string | null;
      };
      expect(sessionRow.startup_status).toBe("ready");
      expect(sessionRow.startup_completed_at).not.toBeNull();

      const readyEvents = db.prepare("SELECT * FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(node.id);
      expect(readyEvents).toHaveLength(1);
    });
  });

  describe("missing or ambiguous provenance is not proof of completion", () => {
    it("does not recover when event has error prefix but missing stage", async () => {
      const { rig, node, session } = seedRig("codex");
      sessionRegistry.updateStartupStatus(session.id, "failed");

      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(
        rig.id,
        node.id,
        "node.startup_failed",
        JSON.stringify({ type: "node.startup_failed", sessionId: session.id, error: "Readiness timeout after 30s" }),
      );

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: { codex: { checkReady: checkReadyMock } },
      });

      await transport.send("worker-1@test-rig", "echo ping");
      expect(checkReadyMock).not.toHaveBeenCalled();

      const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
      expect(sessionRow.startup_status).toBe("failed");
    });

    it("does not recover when no startup event exists in the events table", async () => {
      const { rig, node, session } = seedRig("codex");
      sessionRegistry.updateStartupStatus(session.id, "failed");

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: { codex: { checkReady: checkReadyMock } },
      });

      await transport.send("worker-1@test-rig", "echo ping");
      expect(checkReadyMock).not.toHaveBeenCalled();

      const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
      expect(sessionRow.startup_status).toBe("failed");
    });

    it("does not recover when latest event belongs to an older completed attempt or different session", async () => {
      const { rig, node, session } = seedRig("codex");
      sessionRegistry.updateStartupStatus(session.id, "failed");

      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(
        rig.id,
        node.id,
        "node.startup_ready",
        JSON.stringify({ type: "node.startup_ready", sessionId: "old-session-999" }),
      );

      const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
      const transport = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        eventBus,
        runtimeAdapters: { codex: { checkReady: checkReadyMock } },
      });

      await transport.send("worker-1@test-rig", "echo ping");
      expect(checkReadyMock).not.toHaveBeenCalled();

      const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
      expect(sessionRow.startup_status).toBe("failed");
    });
  });

  it("seat rebound to another pane that sits at a trust gate while probe runs is not committed", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const checkReadyMock = vi.fn().mockImplementation(async () => {
      sessionRegistry.updateBinding(node.id, { tmuxPane: "%99" });
      return { ready: false, code: "update_gate" };
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
  });

  it("newer ready written while probe runs stays ready and is not changed to attention", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const checkReadyMock = vi.fn().mockImplementation(async () => {
      sessionRegistry.updateStartupStatus(session.id, "ready");
      return { ready: false, code: "update_gate" };
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("ready");
  });

  it("session exits while probe runs is not rewritten to ready", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const checkReadyMock = vi.fn().mockImplementation(async () => {
      sessionRegistry.updateStatus(session.id, "exited");
      return { ready: true };
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
  });

  it("new occupant generation starts while probe runs is not committed", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const currentMax = (db.prepare("SELECT MAX(generation_ordinal) as m FROM occupant_tenures WHERE node_id = ?").get(node.id) as { m: number | null }).m ?? 0;

    const checkReadyMock = vi.fn().mockImplementation(async () => {
      db.prepare("INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind) VALUES (?, ?, ?, ?, ?)").run(
        "g-next",
        node.id,
        currentMax + 1,
        "uuid-gen-next",
        "adopt",
      );
      return { ready: true };
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
  });

  it("new session starts while probe runs is not committed to old session", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const checkReadyMock = vi.fn().mockImplementation(async () => {
      sessionRegistry.registerSession(node.id, "worker-1-v2@test-rig");
      return { ready: true };
    });

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
  });

  it("capture and send return normally when the readiness check itself fails or throws", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const checkReadyMock = vi.fn().mockRejectedValue(new Error("tmux probe failure"));
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux({
        capturePaneContent: async () => "output content\n",
      }),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const sendResult = await transport.send("worker-1@test-rig", "echo ping");
    expect(sendResult.ok).toBe(true);

    const captureResult = await transport.capture("worker-1@test-rig");
    expect(captureResult.ok).toBe(true);
    expect(captureResult.content).toBe("output content\n");
  });

  it("reuses in-flight readiness check across concurrent interactions", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    let resolveProbe!: (value: { ready: boolean }) => void;
    const probePromise = new Promise<{ ready: boolean }>((res) => {
      resolveProbe = res;
    });
    const checkReadyMock = vi.fn().mockImplementation(() => probePromise);

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux({
        capturePaneContent: async () => "prompt\n",
      }),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const [sendPromise, capturePromise] = [
      transport.send("worker-1@test-rig", "echo ping"),
      transport.capture("worker-1@test-rig"),
    ];

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(checkReadyMock).toHaveBeenCalledTimes(1);

    resolveProbe({ ready: true });
    await Promise.all([sendPromise, capturePromise]);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("ready");
  });

  it("does not reconcile to ready if hasPendingFreshStartup is true", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");

    seedStartupFailureEvent(rig.id, node.id, session.id, {
      freshContextPending: true,
      stage: "readiness_check",
      hasPendingWork: false,
    });

    const emittedReady: unknown[] = [];
    eventBus.subscribe((evt) => {
      if (evt.type === "node.startup_ready") emittedReady.push(evt);
    });

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    expect(checkReadyMock).not.toHaveBeenCalled();

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
    expect(emittedReady).toHaveLength(0);
  });

  it("updates to attention_required if adapter checkReady returns attention code", async () => {
    const { rig, node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    seedStartupFailureEvent(rig.id, node.id, session.id, { stage: "readiness_check", hasPendingWork: false });

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: false, code: "update_gate" });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);

    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("attention_required");
  });

  it("does not check adapter readiness if startup_status is already ready", async () => {
    const { session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "ready");

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);
    expect(checkReadyMock).not.toHaveBeenCalled();
  });

  it("does not reconcile if message is retained by delivery guard", async () => {
    const { node, session } = seedRig("codex");
    sessionRegistry.updateStartupStatus(session.id, "failed");

    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    await guard.set(node.id, true, "person", "protect draft");

    const checkReadyMock = vi.fn().mockResolvedValue({ ready: true });
    const tmux = mockTmux();
    (tmux as unknown as { deliveryGuard: SeatDeliveryGuard }).deliveryGuard = guard;

    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux,
      eventBus,
      runtimeAdapters: {
        codex: { checkReady: checkReadyMock },
      },
    });

    const result = await transport.send("worker-1@test-rig", "echo ping");
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("retained");
    expect(result.sent).toBe(false);

    expect(checkReadyMock).not.toHaveBeenCalled();
    const sessionRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(sessionRow.startup_status).toBe("failed");
  });
});


