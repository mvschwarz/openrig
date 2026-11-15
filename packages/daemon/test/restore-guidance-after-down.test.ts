// A seat's working guidance across `rig down` then `rig up --existing` (an exact resume).
//
// The case (0.6.6, 2026-10-09): a fresh launch merged the seat's role, culture and SOP
// into its CLAUDE.md as OpenRig managed blocks. After `rig down` and `rig up <rig> --existing`, the
// lead resumed on the same session and the result said `fully_restored`, but the cwd had no
// CLAUDE.md: ordinary teardown strips OpenRig's managed blocks (deleting a file left empty), and
// the replay containment sends no startup content into an exact resume.
//
// The narrow exception, pinned here: before the native harness starts, only MISSING managed
// guidance blocks are put back from the saved startup selection. Existing blocks and user text are
// untouched; nothing is sent to the conversation; no startup action runs; the activity-hook restore
// is unchanged. A block that can't be put back is disclosed without changing the seat's native
// status, and the rig is not fully_restored.

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
import { appendIsCleanupSafe, seatGuidance } from "../src/domain/restore-guidance.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { NodeStartupSnapshot } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { getNodeDetail } from "../src/domain/node-inventory.js";

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
  runtime?: "claude-code" | "codex" | "pi";
  claudeManagedBlockFile?: "CLAUDE.md" | "CLAUDE.local.md";
  userText?: string;
  /** An extra "auto" startup file whose content marks it as a skill. */
  autoSkillFile?: boolean;
  /** An extra guidance startup file that applies on fresh start only (like the onboarding files). */
  freshOnlyFile?: boolean;
  /** An extra older "auto" .md startup file (classified from its content). */
  autoGuidanceFile?: boolean;
  /** The saved selection carries the seat-skills bootstrap file, as for every seat with skill storage. */
  seatSkillsLine?: boolean;
  /** #875: a Pi launch that chose its own agent folder's AGENTS.md, recorded with the startup context. */
  piAgentFile?: boolean;
  /** A launch from before the context-entry floor: the saved selection has the built-in openrig-start.md and no floor. */
  legacyStart?: boolean;
}

/** The resume type each runtime records for its native session. */
const resumeTypeOf = (runtime: NonNullable<SeatOptions["runtime"]>): string =>
  runtime === "codex" ? "codex_id" : runtime === "pi" ? "pi_session_file" : "claude_id";

const SEAT_SKILLS_ASSET = path.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md");
const START_ASSET = path.join(import.meta.dirname, "../assets/guidance/openrig-start.md");
const CONTEXT_ENTRY_ASSET = path.join(import.meta.dirname, "../assets/guidance/openrig-context-entry.md");

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
      sessionRegistry.updateResumeToken(sess.id, resumeTypeOf(runtime), TOKEN);
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
    if (opts.seatSkillsLine) {
      files.push({ path: "openrig-seat-skills.md", absolutePath: SEAT_SKILLS_ASSET, ownerRoot: path.dirname(SEAT_SKILLS_ASSET),
        deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] });
    }
    if (opts.legacyStart) {
      files.push({ path: "openrig-start.md", absolutePath: START_ASSET, ownerRoot: path.dirname(path.dirname(START_ASSET)),
        deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] });
    }
    if (opts.autoSkillFile) {
      fs.writeFileSync(path.join(spec, "helper.md"), "# SKILL\nA skill, never merged into guidance.");
      files.push({ path: "helper.md", absolutePath: path.join(spec, "helper.md"), ownerRoot: spec,
        deliveryHint: "auto", required: false, appliesOn: ["fresh_start", "restore"] });
    }
    const actions = [{ type: "send_text", value: "STARTUP-PROMPT-MUST-NOT-REPLAY", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true }];
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
      .run(node.id, JSON.stringify(entries), JSON.stringify(files), JSON.stringify(actions), runtime);
    const guidanceFile = opts.piAgentFile ? path.join(tmp, "pi-state", sessionName, "agent", "AGENTS.md")
      : path.join(cwd, runtime === "claude-code" ? (opts.claudeManagedBlockFile ?? "CLAUDE.md") : "AGENTS.md");
    if (opts.piAgentFile) {
      fs.mkdirSync(path.dirname(guidanceFile), { recursive: true });
      db.prepare("UPDATE node_startup_context SET guidance_file = ? WHERE node_id = ?").run(guidanceFile, node.id);
    }
    if (opts.userText) fs.writeFileSync(guidanceFile, opts.userText);
    mergeManagedBlock(nodeFs, guidanceFile, "lead-role", "You lead this team.");
    mergeManagedBlock(nodeFs, guidanceFile, "SOP.md", "How work flows here.");
    if (opts.freshOnlyFile) mergeManagedBlock(nodeFs, guidanceFile, "onboarding.md", "Onboarding: how this world works.");
    if (opts.autoGuidanceFile) mergeManagedBlock(nodeFs, guidanceFile, "NOTES.md", "Team notes, an older auto startup file.");
    if (opts.legacyStart) mergeManagedBlock(nodeFs, guidanceFile, "openrig-start.md", fs.readFileSync(START_ASSET, "utf-8"));
    return { rigId: rig.id, guidanceFile };
  }

  /** `rig down` (the real teardown), then `rig up --existing` from its auto snapshot. Records
   *  the guidance file's content at the moment the native harness was started. */
  async function downThenUpExisting(rigId: string, guidanceFile: string, opts: SeatOptions & { betweenDownAndUp?: () => void; noPane?: boolean; routerLine?: "yes" | "no" } = {}) {
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
        return { ok: true as const, resumeToken: TOKEN, resumeType: resumeTypeOf(runtime) };
      }),
    };
    const restore = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume, codexResume,
      ...(opts.routerLine ? { routerLineSettings: { resolveOne: () => ({ value: opts.routerLine === "yes", source: "file", defaultValue: false }) } as never } : {}),
      // The pane's process tree shows the same native session resumed (the joined-resume proof).
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "zsh" },
        { pid: 1235, ppid: 1234, command: runtime === "codex" ? `codex resume ${TOKEN}` : runtime === "pi" ? `pi --session ${TOKEN}` : `claude --resume ${TOKEN}` },
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

  // The seat-skills line comes back only with the person's yes, as at a start: after a no, an exact resume leaves the file
  // without it and reports no gap.
  it.each(["no", "yes"] as const)("an exact resume after the answer %s puts the seat-skills line back only with a yes", async (routerLine) => {
    const { rigId, guidanceFile } = launchedSeat({ seatSkillsLine: true });
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { routerLine });
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    if (routerLine === "no") expect(fileAtHarnessStart).not.toContain("<!-- BEGIN OpenRig MANAGED BLOCK: openrig-seat-skills.md -->");
    else expect(fileAtHarnessStart).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: openrig-seat-skills.md -->");
    expect(result.nodes.find((n) => n.logicalId === "lead")?.guidanceGaps).toBeUndefined();
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

  // A seat launched before the context-entry floor existed: its exact resume puts back openrig-start.md and adds the floor
  // beside it, in the seat's own guidance file on either runtime. The person's text stays, and the floor is no guidance gap.
  // (This harness doesn't simulate Codex's native resume proof, so a Codex seat here reads attention_required with or
  // without the floor; the rig result is checked for Claude.)
  it.each([
    { runtime: "claude-code" as const, file: "CLAUDE.md" },
    { runtime: "codex" as const, file: "AGENTS.md" },
  ])("an exact resume of a seat saved before the context-entry floor gets the floor in its $file", async ({ runtime, file }) => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime, legacyStart: true, userText: "Person notes\n" });
    expect(path.basename(guidanceFile)).toBe(file);
    expect(fs.readFileSync(guidanceFile, "utf-8")).not.toContain(MANAGED_BLOCK_START("openrig-context-entry.md"));
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime });
    expect(fileAtHarnessStart).toContain("Person notes");
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("openrig-start.md"));
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("openrig-context-entry.md"));
    expect(fileAtHarnessStart).toContain(fs.readFileSync(CONTEXT_ENTRY_ASSET, "utf-8").trim());
    expect(fileAtHarnessStart!.indexOf(MANAGED_BLOCK_START("openrig-context-entry.md")))
      .toBeGreaterThan(fileAtHarnessStart!.indexOf(MANAGED_BLOCK_START("openrig-start.md")));
    expect(result.nodes[0]?.guidanceGaps).toBeUndefined();
    if (runtime === "claude-code") expect(result.rigResult).toBe("fully_restored");
  });

  it("a seat whose saved selection has no built-in openrig-start.md gets no floor (a custom start file isn't the anchor)", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true });
    const { fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true });
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(fileAtHarnessStart).not.toContain(MANAGED_BLOCK_START("openrig-context-entry.md"));
  });

  // #875: a Pi seat's blocks live in AGENTS.md. Down takes them out like a Codex seat's, and the exact resume puts them back.
  it("a Pi seat's exact resume puts back the blocks down took out of its AGENTS.md, and writes no other file", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "pi", userText: "Person notes\n" });
    let afterDown: string | null = null;
    const { result, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime: "pi",
      betweenDownAndUp: () => { afterDown = fs.readFileSync(guidanceFile, "utf-8"); } });
    expect(afterDown, "AGENTS.md after rig down").toBe("Person notes\n");
    expect(fileAtHarnessStart).toContain("Person notes\n");
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(result.nodes[0]?.guidanceGaps).toBeUndefined();
    for (const other of ["CLAUDE.md", "CLAUDE.local.md"]) expect(fs.existsSync(path.join(cwd, other)), other).toBe(false);
  });

  // #875 direction 2: this Pi seat's launch put its blocks in its own agent folder's AGENTS.md. Down takes them out of that
  // file, the exact resume puts them back there, and the person's tracked repository AGENTS.md is never written.
  it("a Pi seat whose launch chose its agent folder keeps the tracked repository AGENTS.md byte-identical across down and the exact resume", async () => {
    const tracked = "# Project guidance (tracked in git)\nRun the tests before pushing.\n";
    const repoFile = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(repoFile, tracked);
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "pi", piAgentFile: true, userText: "My own Pi notes\n" });
    expect(guidanceFile).not.toBe(repoFile);
    let afterDown: string | null = null;
    const { result, adapter, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime: "pi",
      betweenDownAndUp: () => {
        afterDown = fs.readFileSync(guidanceFile, "utf-8");
        expect(fs.readFileSync(repoFile, "utf-8"), "the tracked AGENTS.md after rig down").toBe(tracked);
      } });
    expect(afterDown, "the agent AGENTS.md after rig down keeps only the person's lines").toBe("My own Pi notes\n");
    expect(fileAtHarnessStart).toContain("My own Pi notes\n");
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(fs.readFileSync(repoFile, "utf-8"), "the tracked AGENTS.md after the exact resume").toBe(tracked);
    expect(result.nodes[0]?.guidanceGaps).toBeUndefined();
    // The restore hands the launch's recorded choice to the adapter, so a replayed start would use the same file.
    expect((adapter.project.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({ guidanceFile });
  });

  // #2432 X-F1: an older snapshot (no recorded choice) restored exactly after a newer launch recorded the agent file. The
  // seat resumes on the repository file, so the record must say so: inventory names it, and another rig's down in the same
  // cwd leaves the guidance this live seat reads.
  it("an older snapshot restored exactly after a newer recorded launch records the repository file it resumes on", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "pi" });
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE rig_id = ?").get(rigId) as { id: string }).id;
    const newer = path.join(tmp, "pi-state", "orch-lead@poc", "agent", "AGENTS.md");
    const recorded = () => (db.prepare("SELECT guidance_file FROM node_startup_context WHERE node_id = ?").get(nodeId) as { guidance_file: string | null }).guidance_file;
    await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime: "pi",
      // After the snapshot was taken, a newer fresh launch recorded the seat's agent file.
      betweenDownAndUp: () => { db.prepare("UPDATE node_startup_context SET guidance_file = ? WHERE node_id = ?").run(newer, nodeId); } });
    expect(recorded(), "the record names the file the resumed seat uses").toBeNull();
    expect(getNodeDetail(db, rigId, "orch.lead")!.installedResources.find((r) => r.id === "lead-role")).toMatchObject({ targetPath: guidanceFile });
    // Another rig in the same cwd goes down: the resumed seat's live repository guidance stays.
    const other = rigRepo.createRig("other");
    const peer = rigRepo.addNode(other.id, "peer", { role: "peer", runtime: "codex", cwd });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(peer.id, "r02-peer").id, "running");
    await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture, eventBus }).teardown(other.id);
    expect(fs.readFileSync(guidanceFile, "utf-8")).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(fs.readFileSync(guidanceFile, "utf-8")).toContain(MANAGED_BLOCK_START("SOP.md"));
  });

  // #2432 X-F2: after the launch recorded the agent file, the person links it to a shared Pi home's file. The exact resume
  // writes nothing through that link: the conversation resumes, the gap is reported, and nothing falls back to the
  // repository file.
  it("a recorded agent file that became a link after its launch gets nothing put back through it, and the gap is reported", async () => {
    const tracked = "# Project guidance (tracked in git)\n";
    const repoFile = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(repoFile, tracked);
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "pi", piAgentFile: true });
    const shared = path.join(tmp, "shared-pi-home", "AGENTS.md");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, "The person's own Pi home guidance\n");
    const { result } = await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime: "pi",
      betweenDownAndUp: () => { fs.rmSync(guidanceFile, { force: true }); fs.symlinkSync(shared, guidanceFile); } });
    expect(fs.readFileSync(shared, "utf-8"), "the shared file").toBe("The person's own Pi home guidance\n");
    expect(fs.readFileSync(repoFile, "utf-8"), "no fallback into the tracked file").toBe(tracked);
    expect(result.nodes[0]?.status).toBe("resumed");
    expect(result.nodes[0]?.guidanceGaps).toEqual(expect.arrayContaining(["lead-role", "SOP.md"]));
    expect(result.rigResult).not.toBe("fully_restored");
  });

  it("a Pi seat restored from a snapshot with no recorded choice stays on the repository AGENTS.md (no silent repoint)", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "pi" });
    expect(guidanceFile).toBe(path.join(cwd, "AGENTS.md"));
    const { adapter, fileAtHarnessStart } = await downThenUpExisting(rigId, guidanceFile, { podAware: true, runtime: "pi" });
    expect(fileAtHarnessStart).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect((adapter.project.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({ guidanceFile: null });
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

  // #3039: a pod-aware Codex seat through the real Codex adapter. On Codex 0.164.0 or later its fresh launch carried its guidance
  // as developer instructions, so the person's tracked AGENTS.md holds none, and rig down takes nothing out. The exact resume
  // carries the saved guidance in its own launch instead of putting it in that file; an older Codex keeps the put-back.
  const CODEX_TOKEN = "00000000-0000-7000-8000-00000000c0de";
  const TRACKED = "# Our repository\n\nRun the tests with make test.\n";
  const instructionsIn = (command: string | undefined): string | undefined => {
    const arg = command ? /-c 'developer_instructions=([^']*)'/.exec(command)?.[1] : undefined;
    return arg === undefined ? undefined : JSON.parse(arg) as string;
  };

  async function downThenUpExistingCodex(rigId: string, guidanceFile: string, codexVersion: string, betweenDownAndUp?: () => void) {
    db.prepare("UPDATE sessions SET resume_token = ? WHERE resume_token = ?").run(CODEX_TOKEN, TOKEN);
    const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture, eventBus })
      .teardown(rigId);
    expect(down.snapshotId).toBeTruthy();
    betweenDownAndUp?.();
    const beforeUp = fs.readFileSync(guidanceFile, "utf-8");
    let started = false;
    const screen = "OpenAI Codex (v0.164.0)\n\u203a Ask Codex to do anything";
    const tmux = {
      ...mockTmux(),
      createSession: vi.fn(async () => { started = true; return { ok: true as const }; }),
      hasSession: vi.fn(async () => started),
      sendShellCommand: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => 3001),
      getPaneCommand: vi.fn(async () => "bash"),
      capturePaneScreen: vi.fn(async () => screen),
      capturePaneContent: vi.fn(async () => screen),
    } as unknown as TmuxAdapter;
    const startedAt = "Sat Jan  1 12:00:00 2000";
    const listProcesses = async () => [
      { pid: 3001, ppid: 1, pgid: 3001, tpgid: 3002, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 3002, ppid: 3001, pgid: 3002, tpgid: 3002, executableName: "codex", command: `/opt/native/codex resume ${CODEX_TOKEN}`,
        argv: ["/opt/native/codex", "resume", CODEX_TOKEN], startedAt },
    ];
    const adapter = new CodexRuntimeAdapter({ tmux, listProcesses, sleep: async () => {}, codexHome: path.join(tmp, "codex-home"),
      codexSystemConfigDir: path.join(tmp, "etc-codex"), fsOps: { ...nodeFs, homedir: tmp },
      readResumeEvidence: () => ({ threadId: CODEX_TOKEN }), resolveManagedConfigSettings: async () => ({ enabled: false, codexVersion }) });
    const restore = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }), tmuxAdapter: tmux,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      listProcesses,
    });
    const up = await restore.restore(down.snapshotId!, { adapters: { codex: adapter } });
    expect(up.ok).toBe(true);
    if (!up.ok) throw new Error("restore did not run");
    const sent = [...(tmux.sendShellCommand as ReturnType<typeof vi.fn>).mock.calls, ...(tmux.sendText as ReturnType<typeof vi.fn>).mock.calls]
      .map((call) => String(call[1] ?? ""));
    const token = (db.prepare("SELECT resume_token FROM sessions WHERE status = 'running' ORDER BY id DESC LIMIT 1").get() as { resume_token: string | null } | undefined)?.resume_token;
    return { result: up.result, sent, launch: sent.find((command) => command.includes(CODEX_TOKEN)), beforeUp, token };
  }

  it("a Codex 0.164 seat's exact resume carries its guidance in the launch and leaves the tracked AGENTS.md byte-identical", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "codex", autoSkillFile: true });
    fs.writeFileSync(guidanceFile, TRACKED);
    const { result, sent, launch, token } = await downThenUpExistingCodex(rigId, guidanceFile, "0.164.0");
    expect(fs.readFileSync(guidanceFile, "utf-8")).toBe(TRACKED);
    // The same conversation, resumed, with the saved guidance from its current sources as developer instructions.
    expect(launch).toMatch(new RegExp(` resume '?${CODEX_TOKEN}'?`));
    expect(token).toBe(CODEX_TOKEN);
    const text = instructionsIn(launch);
    expect(text).toContain("You lead this team.");
    expect(text).toContain("How work flows here.");
    // Still contained: no startup action, no skill, no other file.
    expect(sent.join("\n")).not.toContain("STARTUP-PROMPT-MUST-NOT-REPLAY");
    expect(text).not.toContain("A skill, never merged into guidance.");
    expect(fs.existsSync(path.join(cwd, ".agents"))).toBe(false);
    for (const other of ["CLAUDE.md", "CLAUDE.local.md"]) expect(fs.existsSync(path.join(cwd, other)), other).toBe(false);
    expect(result.nodes[0]?.status).toBe("resumed");
    expect(result.nodes[0]?.guidanceGaps).toBeUndefined();
    expect(result.rigResult).toBe("fully_restored");
  });

  it("an older Codex keeps the put-back: the blocks return to AGENTS.md beside the person's text, and the launch carries none", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "codex" });
    fs.writeFileSync(guidanceFile, TRACKED);
    const { launch } = await downThenUpExistingCodex(rigId, guidanceFile, "0.163.9");
    const content = fs.readFileSync(guidanceFile, "utf-8");
    expect(content).toContain(TRACKED.trim());
    expect(content).toContain(MANAGED_BLOCK_START("lead-role"));
    expect(content).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(launch).toBeDefined();
    expect(launch).not.toContain("developer_instructions");
  });

  // A file that already holds a block keeps it as it is (the restore writer's own rule; #2456 refreshes only one OpenRig
  // wrote), and only the block the file lacks goes with the launch.
  it("a block already in the tracked AGENTS.md stays as it is, and only the absent one goes with the launch", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "codex" });
    fs.writeFileSync(guidanceFile, TRACKED);
    const { launch, beforeUp, result } = await downThenUpExistingCodex(rigId, guidanceFile, "0.164.0",
      () => mergeManagedBlock(nodeFs, guidanceFile, "lead-role", "The person's own version of the role."));
    expect(beforeUp).toContain("The person's own version of the role.");
    expect(fs.readFileSync(guidanceFile, "utf-8")).toBe(beforeUp);
    const text = instructionsIn(launch);
    expect(text).toContain("How work flows here.");
    expect(text).not.toContain("You lead this team.");
    expect(result.nodes[0]?.guidanceGaps).toBeUndefined();
  });

  it("a block whose source is gone isn't carried and stays a disclosed gap", async () => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "codex" });
    fs.writeFileSync(guidanceFile, TRACKED);
    const { launch, result } = await downThenUpExistingCodex(rigId, guidanceFile, "0.164.0", () => fs.rmSync(path.join(spec, "SOP.md")));
    expect(fs.readFileSync(guidanceFile, "utf-8")).toBe(TRACKED);
    expect(instructionsIn(launch)).toContain("You lead this team.");
    expect(result.nodes[0]?.guidanceGaps).toEqual(["SOP.md"]);
    expect(result.rigResult).toBe("partially_restored");
  });

  // A source that exists but can't be read (here a directory) stays with the restore writer, which reports it without
  // stopping the resume, whether it's a projected block or a startup file. The readable one still goes with the launch.
  it.each([
    { kind: "a projected block", file: "lead.md", id: "lead-role", readable: "How work flows here." },
    { kind: "a startup guidance file", file: "SOP.md", id: "SOP.md", readable: "You lead this team." },
  ])("$kind whose source exists but can't be read stays a disclosed gap, and the resume goes on", async ({ file, id, readable }) => {
    const { rigId, guidanceFile } = launchedSeat({ podAware: true, runtime: "codex" });
    fs.writeFileSync(guidanceFile, TRACKED);
    const { launch, result } = await downThenUpExistingCodex(rigId, guidanceFile, "0.164.0", () => {
      fs.rmSync(path.join(spec, file));
      fs.mkdirSync(path.join(spec, file));
    });
    expect(fs.readFileSync(guidanceFile, "utf-8")).toBe(TRACKED);
    expect(result.nodes[0]?.status).toBe("resumed");
    expect(instructionsIn(launch)).toContain(readable);
    expect(result.nodes[0]?.guidanceGaps).toEqual([id]);
    expect(result.rigResult).toBe("partially_restored");
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

// A selection saved by an older version can hold an openrig-start.md entry with no ownerRoot. Its identity is unknown, so
// it doesn't anchor the context-entry block, and the rest of the seat's guidance selection is still put back.
describe("an older saved selection whose openrig-start.md has no ownerRoot", () => {
  const assets = "/old/node_modules/@openrig/cli/daemon/assets";
  const snapshot = (ownerKnown: boolean) => ({
    runtime: "claude-code", projectionEntries: [], startupActions: [],
    resolvedStartupFiles: [
      { path: "SOP.md", absolutePath: "/team/SOP.md", ownerRoot: "/team", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] },
      { path: "openrig-start.md", absolutePath: `${assets}/guidance/openrig-start.md`, ...(ownerKnown ? { ownerRoot: assets } : {}),
        deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] },
    ],
  }) as unknown as NodeStartupSnapshot;

  it("keeps the whole selection, required SOP included, and adds no block for the unknown entry", () => {
    const guidance = seatGuidance(snapshot(false), "/team/work", undefined, () => true, () => "text");
    expect(guidance?.items.map((item) => item.blockId)).toEqual(["SOP.md", "openrig-start.md"]);
    expect(guidance?.items.find((item) => item.blockId === "SOP.md")?.required).toBe(true);
  });

  it("with its ownerRoot, the same entry anchors the block (control)", () => {
    const guidance = seatGuidance(snapshot(true), "/team/work", undefined, () => true, () => "text");
    expect(guidance?.items.map((item) => item.blockId)).toEqual(["SOP.md", "openrig-start.md", "openrig-context-entry.md"]);
  });
});
