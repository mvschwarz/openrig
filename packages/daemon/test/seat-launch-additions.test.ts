import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSeatSkills, hasSeatSkillRecords, rehydrateSeatSkills, seatSkillPaths, type SeatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { inspectSeatSkills } from "../src/domain/seat-skill-apply.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import {
  carrySeatLaunchAdditions, prepareSeatLaunchAdditions, recordConversationPrompt, recordForkConversationPrompt, seatLaunchAdditions, seatLaunchAdditionsReport, systemPromptPendingNote,
} from "../src/domain/seat-launch-additions.js";

// OPR.0.7.0.9: a Claude seat's own launch additions live in its own storage (slice 13's seat root), never in the
// project. These tests drive the internal model; they don't depend on how a spec spells the request.

const roots: string[] = [];
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), name)); roots.push(dir); return dir; };
let savedHome: string | undefined;
let home: string;
beforeEach(() => { savedHome = process.env["OPENRIG_HOME"]; home = scratch("seat-additions-home-"); process.env["OPENRIG_HOME"] = home; });
afterEach(() => {
  if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tree = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
};

/** A person's source files, in a folder with spaces in its name. */
function sources() {
  const dir = join(scratch("seat-additions-src-"), "my additions");
  mkdirSync(join(dir, "review plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "prompt.md"), "Answer in short sentences.\n");
  writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ndescription: Reviews changes\n---\nYou review.\n");
  writeFileSync(join(dir, "review plugin", ".claude-plugin", "plugin.json"), "{\"name\":\"review-plugin\"}\n");
  writeFileSync(join(dir, "review plugin", "notes.md"), "notes\n");
  return {
    dir,
    input: { appendSystemPromptFile: join(dir, "prompt.md"), agentFile: join(dir, "reviewer.md"), pluginDirs: [join(dir, "review plugin")] },
  };
}

describe("a seat's launch additions in its own storage", () => {
  it("copies the prompt file, the agent and each plugin folder into the seat's storage, and nothing else changes", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { dir, input } = sources();
    const before = tree(dir);
    const prepared = prepareSeatLaunchAdditions(paths, input);
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const { additions } = prepared;
    expect(additions.agent).toBe("openrig:reviewer");
    expect(additions.appendSystemPromptFile?.startsWith(paths.root + "/")).toBe(true);
    expect(readFileSync(additions.appendSystemPromptFile!, "utf8")).toBe("Answer in short sentences.\n");
    expect(readFileSync(join(paths.pluginDir, "agents", "reviewer.md"), "utf8")).toContain("name: reviewer");
    expect(additions.pluginDirs).toHaveLength(1);
    expect(additions.pluginDirs[0]!.startsWith(paths.root + "/")).toBe(true);
    expect(readFileSync(join(additions.pluginDirs[0]!, ".claude-plugin", "plugin.json"), "utf8")).toContain("review-plugin");
    // The sources are untouched, and a later read of the seat finds the same additions.
    expect(tree(dir)).toEqual(before);
    expect(seatLaunchAdditions(paths)).toEqual(additions);
  });

  it("a seat that asked for nothing has none, and its storage gets nothing", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.peer", runtime: "claude-code" });
    const prepared = prepareSeatLaunchAdditions(paths, {});
    expect(prepared).toEqual({ ok: true, additions: { pluginDirs: [] } });
    expect(seatLaunchAdditions(paths)).toBeUndefined();
    expect(tree(paths.root)).toEqual([]);
  });

  it("an earlier record that can't be removed is the seat's named result, not a thrown launch", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.stuck", runtime: "claude-code" });
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(join(paths.root, "launch-additions.json"), "{}\n");
    chmodSync(paths.root, 0o500); // the record is there but its folder isn't writable, so it can't be removed
    try {
      const prepared = prepareSeatLaunchAdditions(paths, {});
      expect(prepared).toMatchObject({ ok: false, code: "seat_storage_refused" });
      expect(prepared.ok ? "" : prepared.message).toContain("couldn't be removed");
    } finally { chmodSync(paths.root, 0o700); }
  });

  it("a missing source is a clear error naming it, before anything is written", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { dir, input } = sources();
    const missing = join(dir, "gone.md");
    const prepared = prepareSeatLaunchAdditions(paths, { ...input, appendSystemPromptFile: missing });
    expect(prepared).toMatchObject({ ok: false, code: "addition_missing" });
    expect(prepared.ok ? "" : prepared.message).toContain(missing);
    expect(tree(paths.root)).toEqual([]);
  });

  it("an agent whose name isn't a plain registered name is refused, before anything is written", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { dir, input } = sources();
    writeFileSync(join(dir, "odd.md"), "---\nname: two words\ndescription: d\n---\n");
    const prepared = prepareSeatLaunchAdditions(paths, { ...input, agentFile: join(dir, "odd.md") });
    expect(prepared).toMatchObject({ ok: false, code: "addition_invalid" });
    expect(prepared.ok ? "" : prepared.message).toContain("two words");
    expect(tree(paths.root)).toEqual([]);
  });

  it("a seat root whose prompt path `ps` can't bound (a `--` token) is refused before anything is written: a named limitation", () => {
    process.env["OPENRIG_HOME"] = join(scratch("seat-additions-backup-"), "Backup -- 2026", "openrig");
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    expect(prepared).toMatchObject({ ok: false, code: "addition_invalid" });
    expect(prepared.ok ? "" : prepared.message).toContain("can't be read back");
    expect(tree(paths.root)).toEqual([]);
  });

  it("a plugin folder whose manifest is named openrig would collide with the seat's own plugin: refused, nothing written", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { dir, input } = sources();
    writeFileSync(join(dir, "review plugin", ".claude-plugin", "plugin.json"), "{\"name\":\"openrig\"}\n");
    const prepared = prepareSeatLaunchAdditions(paths, input);
    expect(prepared).toMatchObject({ ok: false, code: "addition_invalid" });
    expect(prepared.ok ? "" : prepared.message).toContain("openrig");
    expect(tree(paths.root)).toEqual([]);
  });

  it("a link at the seat's additions folder is refused and named; nothing goes through it", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const moved = scratch("seat-additions-linked-");
    mkdirSync(paths.root, { recursive: true });
    symlinkSync(moved, join(paths.root, "additions"));
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    expect(prepared).toMatchObject({ ok: false, code: "seat_storage_refused" });
    expect(tree(moved)).toEqual([]);
  });

  it("storage a link refuses gets nothing through the link, and says why", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const moved = scratch("seat-additions-moved-");
    mkdirSync(join(home, "state", "seats"), { recursive: true });
    symlinkSync(moved, join(home, "state", "seats", "rig-1"));
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    expect(prepared).toMatchObject({ ok: false, code: "seat_storage_refused" });
    expect(prepared.ok ? "" : prepared.message).toContain("not inside this seat's storage");
    expect(tree(moved)).toEqual([]);
  });

  it("slice 13's restore route puts back each location's missing copy from its unchanged source, and names one whose source changed", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { input } = sources();
    const prepared = prepareSeatLaunchAdditions(paths, input);
    if (!prepared.ok) throw new Error(prepared.message);
    const copies = [prepared.additions.appendSystemPromptFile!, join(paths.pluginDir, "agents", "reviewer.md"), join(prepared.additions.pluginDirs[0]!, "notes.md")];
    expect(hasSeatSkillRecords(paths)).toBe(true);
    for (const copy of copies) unlinkSync(copy);
    expect(rehydrateSeatSkills(paths).restored.sort()).toEqual([...copies].sort());
    expect(readFileSync(copies[0]!, "utf8")).toBe("Answer in short sentences.\n");
    unlinkSync(copies[0]!);
    writeFileSync(input.appendSystemPromptFile, "Changed since.\n");
    const again = rehydrateSeatSkills(paths);
    expect(again.restored).toEqual([]);
    expect(again.missing).toEqual([copies[0]]);
  });

  it("a prompt changed since a conversation started is reported pending for that conversation, not used", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { input } = sources();
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    recordConversationPrompt(paths, "conv-a");
    expect(systemPromptPendingNote(paths, "conv-a")).toBeUndefined();
    writeFileSync(input.appendSystemPromptFile, "New instructions.\n");
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    const note = systemPromptPendingNote(paths, "conv-a");
    expect(note).toMatch(/^system_prompt_pending: /);
    expect(note).toContain("after compaction or in a new conversation");
    // A conversation that starts with the new text has nothing pending.
    recordConversationPrompt(paths, "conv-b");
    expect(systemPromptPendingNote(paths, "conv-b")).toBeUndefined();
  });
});

describe("resume honesty, per conversation", () => {
  it("a resume with no recorded start for its conversation is unknown, never current or pending", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    expect(prepareSeatLaunchAdditions(paths, sources().input).ok).toBe(true);
    expect(systemPromptPendingNote(paths, "conv-never-recorded")).toMatch(/^system_prompt_unknown: /);
  });

  it("the pending note names Claude's version floor and that compaction isn't observed", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { input } = sources();
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    recordConversationPrompt(paths, "conv-a");
    writeFileSync(input.appendSystemPromptFile, "New.\n");
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    const note = systemPromptPendingNote(paths, "conv-a")!;
    expect(note).toContain("v2.1.265");
    expect(note).toContain("compaction");
  });

  it("a fork starts from its parent's recorded prompt, or from nothing (unknown), never from today's file", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { input } = sources();
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    recordConversationPrompt(paths, "parent");
    writeFileSync(input.appendSystemPromptFile, "Changed before the fork.\n");
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    recordForkConversationPrompt(paths, "fork-1", "parent");
    expect(systemPromptPendingNote(paths, "fork-1")).toMatch(/^system_prompt_pending: /);
    recordForkConversationPrompt(paths, "fork-2", "unrecorded-parent");
    expect(systemPromptPendingNote(paths, "fork-2")).toMatch(/^system_prompt_unknown: /);
  });
});

describe("a seat's additions on the launch environment", () => {
  function fakeTmux(created: Array<Record<string, string> | undefined>): TmuxAdapter {
    return {
      createSession: async (_n: string, _c?: string, env?: Record<string, string>) => { created.push(env); return { ok: true as const }; },
      setSessionEnv: async () => {}, unsetSessionEnv: async () => {},
      killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], listWindows: async () => [],
      hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
    } as unknown as TmuxAdapter;
  }

  it("the seat's plugin folders follow its generated plugin on CLAUDE_CODE_PLUGIN_DIRS; a peer without additions is unchanged", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const created: Array<Record<string, string> | undefined> = [];
    const pluginsDir = join(scratch("seat-additions-plugins-"), "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), sessionEnv: { OPENRIG_HOME: home }, pluginsDir });
    const rig = rigRepo.createRig("seat-additions");
    for (const id of ["dev.impl", "dev.peer"]) rigRepo.addNode(rig.id, id, { runtime: "claude-code" });
    const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "claude-code" });
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    if (!prepared.ok) throw new Error(prepared.message);
    for (const id of ["dev.impl", "dev.peer"]) expect((await launcher.launchNode(rig.id, id)).ok).toBe(true);
    // The agent needs the generated plugin, so preparing an agent makes sure its manifest exists.
    expect(existsSync(paths.pluginManifestPath)).toBe(true);
    expect(created[0]!["CLAUDE_CODE_PLUGIN_DIRS"]).toBe([paths.pluginDir, ...prepared.additions.pluginDirs].join(":"));
    expect(created[1]).not.toHaveProperty("CLAUDE_CODE_PLUGIN_DIRS");
    db.close();
  });
});

describe("a seat's additions through a restore", () => {
  /** Restore one Claude seat from a snapshot; `before` runs before the snapshot, `after` before the restore. */
  async function restoreSeat(before: (paths: SeatSkillPaths) => void, after: (paths: SeatSkillPaths) => void) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("additions-restore");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/workspace" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@additions-restore");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-1' WHERE id = ?").run(session.id);
    const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "claude-code" });
    before(paths);
    const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual");
    after(paths);

    const claudeResume = { canResume: () => true, resume: vi.fn(async () => ({ ok: true, code: "resumed" })) } as unknown as ClaudeResumeAdapter;
    const codexResume = { canResume: () => false, resume: vi.fn() } as unknown as CodexResumeAdapter;
    const tmuxAdapter = {
      createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => false), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []), getPaneCommand: vi.fn(async () => "claude"),
      setSessionEnv: vi.fn(async () => {}), unsetSessionEnv: vi.fn(async () => {}),
    } as unknown as TmuxAdapter;
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter });
    const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
      nodeLauncher, tmuxAdapter, claudeResume, codexResume });
    const result = await restore.restore(snapshot.id);
    db.close();
    // (sessionName, resumeType, resumeToken, cwd, posture, model, permissionMode, nodeId, effort, nonInterruptive, kernelAuthority, teamPermissionDefault, advisor, launchAdditions)
    return { result, calls: (claudeResume.resume as unknown as { mock: { calls: unknown[][] } }).mock.calls };
  }

  it("puts back a missing copy from its unchanged source, then passes the additions to the Claude resume", async () => {
    let prepared: ReturnType<typeof prepareSeatLaunchAdditions> | undefined;
    const { result, calls } = await restoreSeat((paths) => { prepared = prepareSeatLaunchAdditions(paths, sources().input); },
      () => { if (prepared?.ok) unlinkSync(prepared.additions.appendSystemPromptFile!); });
    if (!prepared?.ok) throw new Error("not prepared");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(readFileSync(prepared.additions.appendSystemPromptFile!, "utf8")).toBe("Answer in short sentences.\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]![13]).toEqual(prepared.additions);
  });

  it.each(["{}\n", "{\"additions\": {}}\n", "not json\n"])("a seat whose additions record isn't one OpenRig wrote (%j) still resumes, without additions, and is told why", async (record) => {
    const { result, calls } = await restoreSeat(() => {}, (paths) => {
      mkdirSync(paths.root, { recursive: true });
      writeFileSync(join(paths.root, "launch-additions.json"), record);
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]![13]).toBeUndefined();
    expect(JSON.stringify(result)).toContain("seat_launch_addition_refused");
  });
});

describe("a seat's additions at rig down", () => {
  it("slice 13's cleanup removes only the unchanged copies OpenRig wrote in each location, keeps an edited one, and keeps the record", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    if (!prepared.ok) throw new Error(prepared.message);
    const edited = join(prepared.additions.pluginDirs[0]!, "notes.md");
    writeFileSync(edited, "the person's edit\n");
    const cleaned = cleanSeatSkills(paths);
    expect(cleaned.kept).toContain(edited);
    expect(existsSync(prepared.additions.appendSystemPromptFile!)).toBe(false);
    expect(existsSync(join(paths.pluginDir, "agents", "reviewer.md"))).toBe(false);
    expect(existsSync(join(prepared.additions.pluginDirs[0]!, ".claude-plugin", "plugin.json"))).toBe(false);
    expect(readFileSync(edited, "utf8")).toBe("the person's edit\n");
    // The record stays for a restore.
    expect(rehydrateSeatSkills(paths).restored).toContain(prepared.additions.appendSystemPromptFile);
  });

  it("a linked addition folder is refused by cleanup, and nothing behind the link is touched", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    if (!prepared.ok) throw new Error(prepared.message);
    const pluginCopy = prepared.additions.pluginDirs[0]!;
    const elsewhere = scratch("seat-additions-elsewhere-");
    writeFileSync(join(elsewhere, "notes.md"), "notes\n");
    rmSync(pluginCopy, { recursive: true, force: true });
    symlinkSync(elsewhere, pluginCopy);
    const cleaned = cleanSeatSkills(paths);
    expect(cleaned.refused).toContain(join(pluginCopy, "notes.md"));
    expect(readFileSync(join(elsewhere, "notes.md"), "utf8")).toBe("notes\n");
  });

  it("a deleted rig drops the additions' record too, once nothing is kept", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    expect(prepareSeatLaunchAdditions(paths, sources().input).ok).toBe(true);
    cleanSeatSkills(paths, { dropRecords: true });
    expect(seatLaunchAdditions(paths)).toBeUndefined();
    expect(hasSeatSkillRecords(paths)).toBe(false);
  });
});

describe("a seat's additions in its seat view", () => {
  it("the seat report lists what the launch will pass, and what is missing", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const prepared = prepareSeatLaunchAdditions(paths, sources().input);
    if (!prepared.ok) throw new Error(prepared.message);
    unlinkSync(prepared.additions.appendSystemPromptFile!);
    const seat = { nodeId: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" as const, sessionName: "dev-impl@rig", cwd: "/project" };
    expect(inspectSeatSkills(seat, null).launchAdditions).toEqual({
      agent: "openrig:reviewer", agentPromptReplacesDefault: true, pluginDirs: prepared.additions.pluginDirs,
      missing: [prepared.additions.appendSystemPromptFile], refused: [],
    });
    const peer = { ...seat, nodeId: "n2", logicalId: "dev.peer", sessionName: "dev-peer@rig" };
    expect(inspectSeatSkills(peer, null).launchAdditions).toBeNull();
  });
});
describe("checkpoint 2 review: collisions, the agent's namespace and named refusals", () => {
  it.each([
    ["two folders with one basename", (a: string) => [join(a, "one", "plugin"), join(a, "two", "plugin")]],
    ["two names that sanitize to one", (a: string) => [join(a, "my plugin"), join(a, "my_plugin")]],
  ])("K3: %s would merge into one destination: refused before anything is written", (_name, dirs) => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const base = scratch("seat-additions-collide-");
    const pluginDirs = dirs(base);
    for (const [i, dir] of pluginDirs.entries()) {
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `{"name":"plugin-${i}"}\n`);
    }
    const prepared = prepareSeatLaunchAdditions(paths, { pluginDirs });
    expect(prepared).toMatchObject({ ok: false, code: "addition_invalid" });
    expect(prepared.ok ? "" : prepared.message).toContain("same destination");
    expect(tree(paths.root)).toEqual([]);
  });

  it("K3: a manifest-less plugin folder named openrig would collide with the seat's plugin: refused", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const dir = join(scratch("seat-additions-openrig-dir-"), "openrig");
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.md"), "notes\n");
    const prepared = prepareSeatLaunchAdditions(paths, { pluginDirs: [dir] });
    expect(prepared).toMatchObject({ ok: false, code: "addition_invalid" });
    expect(tree(paths.root)).toEqual([]);
  });

  it("K4: an edited seat plugin (not named openrig) withholds the agent, says why, and keeps the operator's file", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    mkdirSync(join(paths.pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(paths.pluginManifestPath, "{\"name\":\"custom\"}\n");
    const { input } = sources();
    const prepared = prepareSeatLaunchAdditions(paths, { agentFile: input.agentFile });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.additions.agent).toBeUndefined();
    expect(prepared.notes?.some((note) => note.includes("seat_launch_addition_refused") && note.includes("openrig"))).toBe(true);
    expect(readFileSync(paths.pluginManifestPath, "utf8")).toBe("{\"name\":\"custom\"}\n");
  });

  it("K4: a linked seat plugin manifest withholds the agent too, and nothing is written through it", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const elsewhere = scratch("seat-additions-manifest-elsewhere-");
    writeFileSync(join(elsewhere, "plugin.json"), "{\"name\":\"openrig\"}\n");
    mkdirSync(join(paths.pluginDir, ".claude-plugin"), { recursive: true });
    symlinkSync(join(elsewhere, "plugin.json"), paths.pluginManifestPath);
    const prepared = prepareSeatLaunchAdditions(paths, { agentFile: sources().input.agentFile });
    expect(prepared.ok && prepared.additions.agent).toBeFalsy();
    expect(readFileSync(join(elsewhere, "plugin.json"), "utf8")).toBe("{\"name\":\"openrig\"}\n");
  });

  it("K7: a launch-additions record that became a link is named refused, not silently absent", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    expect(prepareSeatLaunchAdditions(paths, sources().input).ok).toBe(true);
    const record = join(paths.root, "launch-additions.json");
    const moved = join(scratch("seat-additions-record-"), "launch-additions.json");
    writeFileSync(moved, readFileSync(record));
    rmSync(record);
    symlinkSync(moved, record);
    const report = seatLaunchAdditionsReport(paths);
    expect(report?.refused.some((reason) => reason.includes("launch-additions.json"))).toBe(true);
  });

  it("K6: the pending note names the provider floor as well as the version floor", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { input } = sources();
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    recordConversationPrompt(paths, "conv-a");
    writeFileSync(input.appendSystemPromptFile, "New.\n");
    expect(prepareSeatLaunchAdditions(paths, input).ok).toBe(true);
    expect(systemPromptPendingNote(paths, "conv-a")).toContain("v2.1.268");
  });

  it("K8: the report says when the agent's prompt replaces Claude's default system prompt", () => {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" });
    const { dir, input } = sources();
    expect(prepareSeatLaunchAdditions(paths, { agentFile: input.agentFile }).ok).toBe(true);
    expect(seatLaunchAdditionsReport(paths)?.agentPromptReplacesDefault).toBe(true);
    writeFileSync(join(dir, "empty.md"), "---\nname: quiet\ndescription: d\n---\n\n");
    expect(prepareSeatLaunchAdditions(paths, { agentFile: join(dir, "empty.md") }).ok).toBe(true);
    expect(seatLaunchAdditionsReport(paths)?.agentPromptReplacesDefault).toBe(false);
  });
});

describe("a fork's copy of its source seat's additions (OPR.0.7.0.9)", () => {
  const seat = (logicalId: string) => seatSkillPaths({ rigId: "rig-1", logicalId, runtime: "claude-code" });
  const contents = (root: string) => tree(root).flatMap((f) => { try { return [readFileSync(join(root, f), "utf8")]; } catch { return []; } }).join("\n");

  it("carries the source's copies, and the fork's conversation starts from its parent's prompt, not unknown", () => {
    const source = seat("dev.impl"), fork = seat("dev.fork");
    expect(prepareSeatLaunchAdditions(source, sources().input).ok).toBe(true);
    recordConversationPrompt(source, "parent");
    expect(carrySeatLaunchAdditions(source, fork)).toEqual({ status: "carried", kept: true, omitted: [] });
    expect(seatLaunchAdditions(fork)).toMatchObject({ agent: "openrig:reviewer", pluginDirs: [expect.stringContaining(fork.root)] });
    recordForkConversationPrompt(fork, "child", "parent");
    expect(systemPromptPendingNote(fork, "child")).toBeUndefined();
  });

  it("a source copy that became a link out of its seat is left out and named; nothing behind it is copied", () => {
    const source = seat("dev.impl"), fork = seat("dev.fork");
    const prepared = prepareSeatLaunchAdditions(source, sources().input);
    if (!prepared.ok) throw new Error(prepared.message);
    const outside = join(scratch("seat-additions-outside-"), "elsewhere.md");
    writeFileSync(outside, "OUTSIDE THE SEAT\n");
    rmSync(prepared.additions.appendSystemPromptFile!);
    symlinkSync(outside, prepared.additions.appendSystemPromptFile!);
    const carry = carrySeatLaunchAdditions(source, fork);
    expect(carry).toMatchObject({ status: "partial", kept: true, omitted: [expect.stringContaining("system-prompt.md")] });
    expect(seatLaunchAdditions(fork)?.appendSystemPromptFile).toBeUndefined();
    expect(contents(fork.root)).not.toContain("OUTSIDE THE SEAT");
  });

  it("a new seat whose kept plugin isn't named openrig gets the rest; the agent's omission is named, not called carried", () => {
    const source = seat("dev.impl"), fork = seat("dev.fork");
    expect(prepareSeatLaunchAdditions(source, sources().input).ok).toBe(true);
    mkdirSync(join(fork.pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(fork.pluginManifestPath, "{\"name\":\"custom\"}\n");
    const carry = carrySeatLaunchAdditions(source, fork);
    expect(carry).toMatchObject({ status: "partial", kept: true, omitted: [expect.stringContaining("seat_launch_addition_refused")] });
    expect(seatLaunchAdditions(fork)?.agent).toBeUndefined();
  });

  it("a source whose only copy is gone carries nothing, says so, and the fork gets no record to keep", () => {
    const source = seat("dev.impl"), fork = seat("dev.fork");
    const prepared = prepareSeatLaunchAdditions(source, { appendSystemPromptFile: sources().input.appendSystemPromptFile });
    if (!prepared.ok) throw new Error(prepared.message);
    rmSync(prepared.additions.appendSystemPromptFile!);
    expect(carrySeatLaunchAdditions(source, fork)).toMatchObject({ status: "not_carried", kept: false, omitted: [expect.stringContaining("is missing")] });
    expect(seatLaunchAdditions(fork)).toBeUndefined();
  });
});
