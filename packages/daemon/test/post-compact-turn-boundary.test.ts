// A Claude seat that just compacted shows its compaction output and PostCompact hook results above the input box, every row
// indented. The pane classifier then can't see the status head in its window and reads unknown, so the managed compaction's
// post-compaction turn boundary, a pane-only send, waited until the screen changed: about 70 s in a native Claude Code 2.1.309
// run, and 21 minutes on a seat whose hooks didn't reach the daemon. This screen is that run's, with its path made generic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

const ABOVE = [
  "     user message as the action request. The restore protocol is: load/read the",
  "     claude-compaction-restore skill, run \"node",
  "     ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs",
  "     --out /tmp/claude-compaction-restore --json\" yourself when needed, read the",
  "     generated restore-instructions.md, read the generated touched-files.md,",
  "     identify remembered important files, read those files in full, read",
  "     root/as-built/codemap docs before real work, then reply with \"restored from",
  "     packet at <path>; resumed at step <X>\" with the files you read in full. If",
  "     any step fails, report the failure explicitly. OpenRig also wrote a",
  "     pending restore marker at /home/user/project/.openrig/compaction/restore-pe",
  "     nding/worker@my-rig.json.\"}",
  "     PostCompact [\"${OPENRIG_NODE:-node}\"",
  "     \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs\"]",
  "     completed successfully",
  "     PostCompact [\"${OPENRIG_NODE:-node}\"",
  "     \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs\" --runtime claude]",
  "     completed successfully",
  "  ⎿  Read GUIDE.md (2 lines)",
  "",
];
const BOX = [
  "───────────────────────────────────────────────────────────────── worker@my-rig ─",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle)",
  "",
];
const AFTER_COMPACT = [...ABOVE, ...BOX].join("\n");
// A working seat whose task list is taller than the classifier's window: its live status row is out of view, and the box
// below still looks complete and empty. Claude marks tasks with figures' squares (◻ ◼, or □ ■ without them).
const LIVE = "✻ Compacting conversation… (3s · ↓ 242 tokens)";
const HIDDEN_WORK = [LIVE, ...Array.from({ length: 21 }, (_, i) => `  □ Pending task ${i + 1}`), ...BOX].join("\n");
const HIDDEN_WORK_GLYPHS = [LIVE, "  ⎿  ◼ Running the migration", ...Array.from({ length: 20 }, (_, i) => `     ◻ Pending task ${i + 1}`), ...BOX].join("\n");
// A seat streaming a reply taller than the window: Claude hides its status while it streams, and the reply's "●" is out of
// view. From the same native run, during its restore reply and before that turn's Stop hook, with the path made generic.
const STREAMING_REPLY = [
  "  Status: FULL",
  "  Ranges and reason: Read in this window.",
  "  ────────────────────────────────────────",
  "  Item: Pending marker restore-pending/worker@my-rig.json",
  "  Status: FULL",
  "  Ranges and reason: Whole file. Session, transcript and packet paths confirmed.",
  "  ────────────────────────────────────────",
  "  Item: post-compact-extra.md",
  "  Status: FULL",
  "  Ranges and reason: One line, read in full.",
  "  ────────────────────────────────────────",
  "  Item: Restore map RESTORE-MAP.md",
  "  Status: FULL",
  "  Ranges and reason: Whole file, all 5 sections, marker on last line.",
  "  ────────────────────────────────────────",
  "  Item: refocusing/SKILL.md",
  "  Status:",
  "  Ranges and reason:",
  "",
  ...BOX,
].join("\n");
const CLAUDE = { runtime: "claude-code" } as const;
const BOUNDARY = { runtime: "claude-code", postCompactTurnBoundary: true } as const;

describe("the managed compaction's post-compaction turn boundary reads a just-compacted Claude screen", () => {
  it("today that screen reads unknown, because the indented output above the box hides the status head", () => {
    expect(classifyPaneActivity(AFTER_COMPACT, CLAUDE)).toMatchObject({ state: "unknown", reason: "no_activity_signal" });
  });

  it("for the turn boundary, the same complete empty box with its mode footer reads idle", () => {
    expect(classifyPaneActivity(AFTER_COMPACT, BOUNDARY)).toMatchObject({ state: "agent_idle" });
  });

  it("the turn boundary still refuses live work, a typed draft or a dialog on that screen", () => {
    const working = [...ABOVE.slice(0, -1), "✻ Compacting conversation… (3s · ↓ 242 tokens)", "", ...BOX].join("\n");
    expect(classifyPaneActivity(working, BOUNDARY).state).toBe("agent_active");
    const draft = [...ABOVE, BOX[0], "❯ half-typed note", ...BOX.slice(2)].join("\n");
    expect(classifyPaneActivity(draft, BOUNDARY).state).not.toBe("agent_idle");
    const dialog = [...ABOVE.slice(0, 12), "────────────────────────────────────────────────────────────────────────────────",
      " Read file", " Read(/home/user/project/notes.txt)", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend", ""].join("\n");
    expect(classifyPaneActivity(dialog, BOUNDARY).state).toBe("attention");
  });

  it("a working seat whose task list hides its live status stays unknown for the turn boundary", () => {
    for (const pane of [HIDDEN_WORK, HIDDEN_WORK_GLYPHS]) {
      expect(classifyPaneActivity(pane, CLAUDE)).toMatchObject({ state: "unknown", reason: "no_activity_signal" });
      expect(classifyPaneActivity(pane, BOUNDARY)).toMatchObject({ state: "unknown", reason: "no_activity_signal" });
    }
  });

  it("a seat streaming a reply taller than the window stays unknown for the turn boundary", () => {
    expect(classifyPaneActivity(STREAMING_REPLY, CLAUDE)).toMatchObject({ state: "unknown", reason: "no_activity_signal" });
    expect(classifyPaneActivity(STREAMING_REPLY, BOUNDARY)).toMatchObject({ state: "unknown", reason: "no_activity_signal" });
  });
});

describe("through the real send: the turn boundary reaches a just-compacted seat that has no hook evidence", () => {
  let db: Database.Database;
  let transport: SessionTransport;
  let pane = AFTER_COMPACT;
  const sendText = vi.fn(async () => ({ ok: true as const }));
  const sendKeys = vi.fn(async () => ({ ok: true as const }));

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const node = rigRepo.addNode(rigRepo.createRig("my-rig").id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "worker@my-rig" });
    const tmux = {
      hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
      capturePaneContent: async () => pane, getPaneCommand: async () => null, getPanePid: async () => null,
      sendText, sendKeys,
    } as unknown as TmuxAdapter;
    transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      agentActivityStore: new AgentActivityStore({ db, eventBus }) });
    sendText.mockClear(); sendKeys.mockClear();
    pane = AFTER_COMPACT;
  });
  afterEach(() => db.close());

  it("with the enforcer's turn-boundary options it's delivered; the same pane-only send without them waits, and nothing is typed", async () => {
    const pending = await transport.send("worker@my-rig", "OpenRig post-compaction turn boundary.",
      { openrigNotice: true, waitForIdleMs: 50, readinessFromPaneOnly: true });
    expect(pending).toMatchObject({ ok: false, reason: "target_activity_unknown" });
    expect(sendText).not.toHaveBeenCalled();

    const boundary = await transport.send("worker@my-rig", "OpenRig post-compaction turn boundary.",
      { openrigNotice: true, waitForIdleMs: 50, readinessFromPaneOnly: true, postCompactTurnBoundary: true });
    expect(boundary.ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("the turn boundary isn't typed into a working seat whose task list or streaming reply hides its live status", async () => {
    for (const working of [HIDDEN_WORK, STREAMING_REPLY]) {
      pane = working;
      const result = await transport.send("worker@my-rig", "OpenRig post-compaction turn boundary.",
        { openrigNotice: true, waitForIdleMs: 50, readinessFromPaneOnly: true, postCompactTurnBoundary: true });
      expect(result).toMatchObject({ ok: false, reason: "target_activity_unknown" });
    }
    expect(sendText).not.toHaveBeenCalled();
  });
});
