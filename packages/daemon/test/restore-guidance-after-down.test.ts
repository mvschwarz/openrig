// A seat's working guidance across `rig down` then `rig up --existing` (an exact resume).
//
// The specimen (0.6.6, ovh08, 2026-10-09): a fresh launch merged the seat's role, culture and SOP
// into its CLAUDE.md as OpenRig managed blocks. After `rig down` and `rig up <rig> --existing`, the
// lead resumed on the same session and the result said `fully_restored`, but the cwd had no
// CLAUDE.md: ordinary teardown strips OpenRig's managed blocks (deleting a file left empty), and
// the OPR.0.5.7.1 D6a containment replays no startup content into an exact resume.
//
// Root's narrow amendment to D6a (qitem-20261009081619-d1537b0f), pinned here: before the native
// harness starts, only MISSING managed guidance blocks are put back from the saved startup
// selection. Existing blocks and user text are untouched; nothing is sent to the conversation; no
// startup action runs; the activity-hook restore is unchanged. A block that can't be put back is
// disclosed without changing the seat's native status, and the rig is not fully_restored.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { mergeManagedBlock, MANAGED_BLOCK_START, MANAGED_BLOCK_END } from "../src/domain/managed-blocks.js";
import { appendIsCleanupSafe } from "../src/domain/restore-guidance.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";

const TOKEN = "tok-lead";

function mockTmux(opts: { noPane?: boolean } = {}): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    getPanePid: vi.fn(async () => 1234),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => (opts.noPane ? [] : [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

const nodeFs = {
  exists: (p: string) => fs.existsSync(p),
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
  mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
};

interface SeatOptions {
  podAware?: boolean;
  runtime?: "claude-code" | "codex";
  claudeManagedBlockFile?: "CLAUDE.md" | "CLAUDE.local.md";
  userText?: string;
  /** An extra "auto" startup file whose content marks it as a skill. */
  autoSkillFile?: boolean;
  /** An extra guidance startup file that applies on fresh start only (like the onboarding files). */
  freshOnlyFile?: boolean;
  /** An extra older "auto" .md startup file (classified from its content). */
  autoGuidanceFile?: boolean;
}

describe("a seat's guidance across rig down then rig up --existing (exact resume)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;
  let tmp: string;
  let cwd: string;
  let spec: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-guidance-"));
    cwd = path.join(tmp, "seat");
    spec = path.join(tmp, "spec");
    fs.mkdirSync(cwd);
    fs.mkdirSync(spec);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A seat launched fresh: its saved startup context records a role guidance entry, an SOP startup
   *  file, the activity hooks and a send_text startup action, and its guidance file holds both
   *  guidance blocks exactly as the launch wrote them. */
  function launchedSeat(opts: SeatOptions = {}): { rigId: string; guidanceFile: string } {
    const runtime = opts.runtime ?? "claude-code";
    fs.writeFileSync(path.join(spec, "lead.md"), "You lead this team.");
    fs.writeFileSync(path.join(spec, "SOP.md"), "How work flows here.");
    const rig = rigRepo.createRig("poc");
    if (opts.claudeManagedBlockFile) rigRepo.setRigClaudeManagedBlockFile(rig.id, opts.claudeManagedBlockFile);
    let sessionName = "r01-lead";
    let podId: string | undefined;
    if (opts.podAware) {
      podId = "pod-orch";
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run(podId, rig.id, "orch");
      sessionName = "orch-lead@poc";
    }
    const node = rigRepo.addNode(rig.id, opts.podAware ? "orch.lead" : "lead", { role: "lead", runtime, cwd, ...(podId ? { podId } : {}) });
    const sess = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(sess.id, "running");
    if (opts.podAware) {
      sessionRegistry.updateResumeToken(sess.id, runtime === "codex" ? "codex_id" : "claude_id", TOKEN);
    } else {
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
        .run("claude_name", TOKEN, "resume_if_possible", sess.id);
    }
    const entries = [
      { category: "guidance", effectiveId: "lead-role", sourceSpec: "agent", sourcePath: spec,
        resourcePath: "lead.md", absolutePath: path.join(spec, "lead.md"), mergeStrategy: "managed_block" },
      { category: "runtime_resource", effectiveId: "activity-hooks", sourceSpec: "agent", sourcePath: spec,
        resourcePath: "hooks", absolutePath: path.join(spec, "hooks"), resourceType: "claude_activity_hooks" },
    ];
    const files: ResolvedStartupFile[] = [{
      path: "SOP.md", absolutePath: path.join(spec, "SOP.md"), ownerRoot: spec,
      deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"],
    }];
    if (opts.freshOnlyFile) {
      fs.writeFileSync(path.join(spec, "onboarding.md"), "Onboarding: how this world works.");
      files.push({ path: "onboarding.md", absolutePath: path.join(spec, "onboarding.md"), ownerRoot: spec,
        deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start"] });
    }
    if (opts.autoGuidanceFile) {
      fs.writeFileSync(path.join(spec, "NOTES.md"), "Team notes, an older auto startup file.");
      files.push({ path: "NOTES.md", absolutePath: path.join(spec, "NOTES.md"), ownerRoot: spec,
        deliveryHint: "auto", required: false, appliesOn: ["fresh_start", "restore"] });
    }
    if (opts.autoSkillFile) {
      fs.writeFileSync(path.join(spec, "helper.md"), "# SKILL\nA skill, never merged into guidance.");
      files.push({ path: "helper.md", absolutePath: path.join(spec, "helper.md"), ownerRoot: spec,
        deliveryHint: "auto", required: false, appliesOn: ["fresh_start", "restore"] });
    }
    const actions = [{ type: "send_text", value: "STARTUP-PROMPT-MUST-NOT-REPLAY", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true }];
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
      .run(node.id, JSON.stringify(entries), JSON.stringify(files), JSON.stringify(actions), runtime);
    const guidanceFile = path.join(cwd, runtime === "codex" ? "AGENTS.md" : (opts.claudeManagedBlockFile ?? "CLAUDE.md"));
    if (opts.userText) fs.writeFileSync(guidanceFile, opts.userText);
    mergeManagedBlock(nodeFs, guidanceFile, "lead-role", "You lead this team.");
    mergeManagedBlock(nodeFs, guidanceFile, "SOP.md", "How work flows here.");
    if (opts.freshOnlyFile) mergeManagedBlock(nodeFs, guidanceFile, "onboarding.md", "Onboarding: how this world works.");
    if (opts.autoGuidanceFile) mergeManagedBlock(nodeFs, guidanceFile, "NOTES.md", "Team notes, an older auto startup file.");
    return { rigId: rig.id, guidanceFile };
  }

  /** `rig down` (the real teardown), then `rig up --existing` from its auto snapshot. Records
   *  the guidance file's content at the moment the native harness was started. */
  async function downThenUpExisting(rigId: string, guidanceFile: string, opts: SeatOptions & { betweenDownAndUp?: () => void; noPane?: boolean } = {}) {
    const runtime = opts.runtime ?? "claude-code";
    const tmux = mockTmux({ noPane: opts.noPane });
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus })
      .teardown(rigId);
    expect(down.snapshotId).toBeTruthy();
    opts.betweenDownAndUp?.();
    const fileAtHarnessStart: Array<string | null> = [];
    const observe = () => { fileAtHarnessStart.push(fs.existsSync(guidanceFile) ? fs.readFileSync(guidanceFile, "utf-8") : null); };
    const claudeResume = {
      canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
      resume: vi.fn(async () => { observe(); return { ok: true as const }; }),
    } as unknown as ClaudeResumeAdapter;
    const codexResume = { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter;
    const adapter = {
      runtime,
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async (plan: { entries: Array<{ effectiveId: string }> }) =>
        ({ projected: plan.entries.map((e) => e.effectiveId), skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => {
        observe();
        return { ok: true as const, resumeToken: TOKEN, resumeType: runtime === "codex" ? "codex_id" : "claude_id" };
      }),
    };
    const restore = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume, codexResume,
      // The pane's process tree shows the same native session resumed (the joined-resume proof).
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "zsh" },
        { pid: 1235, ppid: 1234, command: runtime === "codex" ? `codex resume ${TOKEN}` : `claude --resume ${TOKEN}` },
      ],
    });
    const up = await restore.restore(down.snapshotId!, { adapters: { [runtime]: adapter as never } });
    expect(up.ok).toBe(true);
    if (!up.ok) throw new Error("restore did not run");
    expect(fileAtHarnessStart, "the native harness was started exactly once").toHaveLength(1);
    return { result: up.result, adapter, tmux, claudeResume, fileAtHarnessStart: fileAtHarnessStart[0] };
  }

  it("the reported case: after down, an exact resume finds its role and SOP blocks back before the harness starts", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const { result, claudeResume, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile);
    expect(claudeResume.resume).toHaveBeenCalledTimes(1); // the same native session, resumed
    expect(fileAtHarnessStart, "CLAUDE.md when the harness started").not.toBeNull();
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(fileAtHarnessStart).toContain("You lead this team.");
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(fileAtHarnessStart).toContain("How work flows here.");
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed");
    expect(lead?.guidanceGaps).toBeUndefined();
    expect(result.rigResult).toBe("fully_restored");
  });

  it("the pod-aware launch path also has the blocks back before launchHarness starts the resumed session", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true });
    const { result, adapter, claudeResume, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true });
    expect(adapter.launchHarness).toHaveBeenCalledTimes(1);
    expect(claudeResume.resume).not.toHaveBeenCalled();
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(result.nodes[0]?.status).toBe("resumed");
    expect(result.rigResult).toBe("fully_restored");
  });

  it.each([
    { runtime: "claude-code" as const, claudeManagedBlockFile: "CLAUDE.local.md" as const, file: "CLAUDE.local.md" },
    { runtime: "codex" as const, claudeManagedBlockFile: undefined, file: "AGENTS.md" },
  ])("puts the blocks back in the seat's own guidance file ($file) and nowhere else", async ({ runtime, claudeManagedBlockFile, file }) => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime, claudeManagedBlockFile });
    expect(path.basename(guidanceFile)).toBe(file);
    const { fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime });
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    for (const other of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].filter((f) => f !== file)) {
      expect(fs.existsSync(path.join(cwd, other)), `${other} must not be written`).toBe(false);
    }
  });

  it("only a missing block is put back: an existing block keeps its content, and user text is preserved", async () => {
    const { rigId, guidanceFile } = launchedSeat({ userText: "# My project notes\nKeep tests fast.\n" });
    const { fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => {
        // After down: the user's text survived teardown. Someone re-adds the role block with
        // different words; the SOP block is still missing. The sources have changed since.
        const afterDown = fs.readFileSync(guidanceFile, "utf-8");
        expect(afterDown).toContain("# My project notes");
        expect(afterDown).not.toContain("OpenRig MANAGED BLOCK");
        mergeManagedBlock(nodeFs, guidanceFile, "lead-role", "An operator's own edit of the role.");
        fs.writeFileSync(path.join(spec, "lead.md"), "Newer role text that must not replace the existing block.");
        fs.writeFileSync(path.join(spec, "SOP.md"), "Current SOP text.");
      },
    });
    expect(fileAtHarnessStart).toContain("# My project notes\nKeep tests fast.");
    expect(fileAtHarnessStart).toContain("An operator's own edit of the role.");
    expect(fileAtHarnessStart).not.toContain("Newer role text");
    // The missing block is rebuilt from the saved source path's CURRENT bytes (not a byte snapshot).
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(fileAtHarnessStart).toContain("Current SOP text.");
  });

  it.each([false, true])("replays nothing into the conversation (pod-aware: %s): no startup files delivered, no send_text, no actions", async (podAware) => {
    const { rigId, guidanceFile } = launchedSeat({ podAware });
    const { adapter, tmux } = await downThenUpExisting(rigId, guidanceFile, { podAware });
    for (const call of adapter.deliverStartup.mock.calls) expect((call as unknown[])[0] ?? []).toEqual([]);
    const sent = [...(tmux.sendText as ReturnType<typeof vi.fn>).mock.calls].map((c) => String(c[1] ?? ""));
    expect(sent.join("\n")).not.toContain("STARTUP-PROMPT-MUST-NOT-REPLAY");
  });

  it("the activity-hook restore is unchanged: the adapter projects only the saved hooks, never guidance", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const { adapter } = await downThenUpExisting(rigId, guidanceFile);
    expect(adapter.project).toHaveBeenCalledTimes(1);
    const entries = (adapter.project.mock.calls[0]![0] as { entries: Array<{ category: string; effectiveId: string }> }).entries;
    expect(entries.map((e) => [e.category, e.effectiveId])).toEqual([["runtime_resource", "activity-hooks"]]);
  });

  it("a block whose source is gone is disclosed: the seat stays resumed, the rig is not fully_restored", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const { result } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.rmSync(path.join(spec, "SOP.md")),
    });
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed"); // the native session is running; that stays true
    expect(lead?.guidanceGaps).toEqual(["SOP.md"]);
    expect(result.rigResult).toBe("partially_restored");
    expect(result.warnings.join("\n")).toContain("SOP.md");
    expect(result.warnings.join("\n")).toMatch(/no longer exists/);
    const content = fs.readFileSync(guidanceFile, "utf-8");
    expect(content).toContain(MANAGED_BLOCK_START("lead-role")); // what could be put back, was
  });

  it("an auto startup file that is a skill (by its content) is not put into the guidance file", async () => {
    const { rigId, guidanceFile } = launchedSeat({ autoSkillFile: true });
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile);
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(fileAtHarnessStart).not.toContain(MANAGED_BLOCK_START("helper.md"));
    expect(fileAtHarnessStart).not.toContain("A skill, never merged into guidance.");
    expect(result.rigResult).toBe("fully_restored"); // a skill is not a guidance gap
  });

  it("a block with only one marker is reported, and nothing is written to that file", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const halfBlock = `# Notes\n${MANAGED_BLOCK_START("SOP.md")}\nhalf of an old block, its END marker lost\n`;
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.writeFileSync(guidanceFile, halfBlock),
    });
    // Appending even the other missing block would let the next rig down strip from the lone BEGIN
    // to that block's END (review50-r2, round 1 F1), so the file is left exactly as it is.
    expect(fileAtHarnessStart).toBe(halfBlock);
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed");
    expect([...(lead?.guidanceGaps ?? [])].sort()).toEqual(["SOP.md", "lead-role"]);
    expect(result.rigResult).toBe("partially_restored");
    expect(result.warnings.join("\n")).toMatch(/only part of this block/);
  });

  it("a live seat that needs attention keeps that status and also discloses its guidance gap", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const { result } = await downThenUpExisting(rigId, guidanceFile, {
      noPane: true, // the joined-resume proof can't find a pane: attention_required, session preserved
      betweenDownAndUp: () => fs.rmSync(path.join(spec, "SOP.md")),
    });
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("attention_required");
    expect(lead?.guidanceGaps).toEqual(["SOP.md"]);
  });

  it("an unmatched marker anywhere in the file: nothing is written, so the next rig down can't take the person's notes", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const stray = `# Preface\n<!-- BEGIN OpenRig MANAGED BLOCK: someone-elses-block -->\nMy own notes, written after that stray marker.\n`;
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.writeFileSync(guidanceFile, stray),
    });
    expect(fileAtHarnessStart).toBe(stray); // not written at all
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed");
    expect([...(lead?.guidanceGaps ?? [])].sort()).toEqual(["SOP.md", "lead-role"]);
    expect(result.rigResult).toBe("partially_restored");
    expect(result.warnings.join("\n")).toMatch(/would strip together with other text/);
    // And the next rig down leaves the notes alone (on the base this file was never written either).
    await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture, eventBus }).teardown(rigId);
    expect(fs.readFileSync(guidanceFile, "utf-8")).toContain("My own notes, written after that stray marker.");
  });

  it("guidance merged at a fresh start only (like onboarding) is put back too: it was in the file until rig down", async () => {
    const { rigId, guidanceFile } = launchedSeat({ freshOnlyFile: true });
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile);
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("onboarding.md"));
    expect(fileAtHarnessStart).toContain("Onboarding: how this world works.");
    expect(result.rigResult).toBe("fully_restored");
  });

  it("an older auto startup file is put back when readable, and disclosed when its source can't be read", async () => {
    const readable = launchedSeat({ autoGuidanceFile: true });
    const first = await downThenUpExisting(readable.rigId, readable.guidanceFile);
    expect(first.fileAtHarnessStart).toContain(MANAGED_BLOCK_START("NOTES.md"));
    expect(first.result.rigResult).toBe("fully_restored");
  });

  it("an older auto startup file whose source is gone is a disclosed gap, never a silent fully_restored", async () => {
    const { rigId, guidanceFile } = launchedSeat({ autoGuidanceFile: true });
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.rmSync(path.join(spec, "NOTES.md")),
    });
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md")); // the rest still comes back
    expect(fileAtHarnessStart).not.toContain(MANAGED_BLOCK_START("NOTES.md"));
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed");
    expect(lead?.guidanceGaps).toEqual(["NOTES.md"]);
    expect(result.rigResult).toBe("partially_restored");
    expect(result.warnings.join("\n")).toMatch(/can't be read/);
  });

  it("a truncated current BEGIN (no closing -->), then notes: nothing written, the notes survive the next rig down", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const truncated = `# Preface\n<!-- BEGIN OpenRig MANAGED BLOCK: \nMy own notes after a marker cut short.\n`;
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.writeFileSync(guidanceFile, truncated),
    });
    expect(fileAtHarnessStart).toBe(truncated);
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed");
    expect([...(lead?.guidanceGaps ?? [])].sort()).toEqual(["SOP.md", "lead-role"]);
    expect(result.rigResult).toBe("partially_restored");
    await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture, eventBus }).teardown(rigId);
    expect(fs.readFileSync(guidanceFile, "utf-8")).toContain("My own notes after a marker cut short.");
  });

  it("a truncated legacy BEGIN, then notes: the current-form blocks come back, and the notes still survive the next rig down", async () => {
    // Decided by effect: the blocks added are in the current form, and cleanup's legacy pattern
    // strips only up to a legacy END, so adding them can't make the next rig down take the notes.
    const { rigId, guidanceFile } = launchedSeat();
    const truncated = `# Preface\n<!-- BEGIN RIGGED MANAGED BLOCK: \nMy own notes after a legacy marker cut short.\n`;
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.writeFileSync(guidanceFile, truncated),
    });
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(result.rigResult).toBe("fully_restored");
    await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture, eventBus }).teardown(rigId);
    const after = fs.readFileSync(guidanceFile, "utf-8");
    expect(after).toContain("My own notes after a legacy marker cut short.");
    expect(after).not.toContain(MANAGED_BLOCK_START("lead-role"));
  });

  it("an END marker with text after it on the same line, then notes: nothing written, the notes survive the next rig down", async () => {
    const { rigId, guidanceFile } = launchedSeat();
    const tricky = `# Preface\n${MANAGED_BLOCK_START("a")}\nblock a\n${MANAGED_BLOCK_END("a")} my note on the same line\nMy own notes below it.\n`;
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, {
      betweenDownAndUp: () => fs.writeFileSync(guidanceFile, tricky),
    });
    expect(fileAtHarnessStart).toBe(tricky);
    const lead = result.nodes.find((n) => n.logicalId === "lead");
    expect(lead?.status).toBe("resumed");
    expect([...(lead?.guidanceGaps ?? [])].sort()).toEqual(["SOP.md", "lead-role"]);
    expect(result.rigResult).toBe("partially_restored");
    await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture, eventBus }).teardown(rigId);
    expect(fs.readFileSync(guidanceFile, "utf-8")).toContain("My own notes below it.");
  });

  it("decides by cleanup's own effect: refuses every hazard shape, allows ordinary files", () => {
    const add = [{ blockId: "lead-role", content: "You lead this team." }];
    const legacyBegin = "<!-- BEGIN RIGGED MANAGED BLOCK: old -->";
    const legacyEnd = "<!-- END RIGGED MANAGED BLOCK: old -->";
    const unsafe = {
      "truncated BEGIN": "# P\n<!-- BEGIN OpenRig MANAGED BLOCK: \nnotes\n",
      "stray BEGIN for another id": `# P\n${MANAGED_BLOCK_START("x")}\nnotes\n`,
      "END with text after it": `${MANAGED_BLOCK_START("a")}\nA\n${MANAGED_BLOCK_END("a")} note\nnotes\n`,
    };
    for (const [name, content] of Object.entries(unsafe)) expect(appendIsCleanupSafe(content, add), name).toBe(false);
    const safe = {
      "plain notes": "# My notes\nKeep tests fast.\n",
      "an existing complete block": `# N\n${MANAGED_BLOCK_START("SOP.md")}\nS\n${MANAGED_BLOCK_END("SOP.md")}\nmore\n`,
      "a punctuated id": `${MANAGED_BLOCK_START("openrig-onboarding-01.md")}\nO\n${MANAGED_BLOCK_END("openrig-onboarding-01.md")}\n`,
      "a complete legacy block": `# N\n${legacyBegin}\nL\n${legacyEnd}\n`,
      "an empty file": "",
      "no trailing newline": "# My notes",
      // The added blocks are in the current form; cleanup strips a legacy BEGIN only up to a legacy END.
      "a truncated legacy BEGIN": "# P\n<!-- BEGIN RIGGED MANAGED BLOCK: \nnotes\n",
    };
    for (const [name, content] of Object.entries(safe)) expect(appendIsCleanupSafe(content, add), name).toBe(true);
  });
});
