import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ResolvedStartupFile, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { ProjectionManifestStore } from "../src/domain/projection-manifest-store.js";
import { hashContent } from "../src/domain/conflict-detector.js";

describe("changing an existing seat's launch directory", () => {
  let db: Database.Database;
  let root: string;
  let oldCwd: string;
  let newCwd: string;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let eventBus: EventBus;
  let tmux: TmuxAdapter;
  let adapter: ClaudeCodeAdapter;
  let service: SeatLifecycleService;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openrig-seat-cwd-")));
    oldCwd = path.join(root, "shared");
    newCwd = path.join(root, "seat workspace");
    fs.mkdirSync(oldCwd);
    fs.writeFileSync(path.join(oldCwd, "CLAUDE.md"), "Shared directory instructions\n");
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmux = {
      sendText: vi.fn(async () => { throw new Error("set-cwd must not type"); }),
      sendKeys: vi.fn(async () => { throw new Error("set-cwd must not submit"); }),
      killSession: vi.fn(async () => { throw new Error("set-cwd must not stop a process"); }),
      createSession: vi.fn(async () => { throw new Error("set-cwd must not launch a process"); }),
    } as unknown as TmuxAdapter;
    adapter = new ClaudeCodeAdapter({
      tmux,
      recordProjection: (targetPath, content) => new ProjectionManifestStore(db).record({
        targetPath, lastHash: hashContent(content), writtenAt: new Date().toISOString(),
      }),
      fsOps: {
        readFile: file => fs.readFileSync(file, "utf8"),
        writeFile: (file, content) => fs.writeFileSync(file, content),
        exists: fs.existsSync,
        mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
        copyFile: fs.copyFileSync,
        listFiles: dir => fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter(file => !fs.lstatSync(path.join(dir, file)).isDirectory()),
        homedir: path.join(root, "native-home"),
      },
    });
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { "claude-code": adapter } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(rigName = "project", logicalId = "planning.lead") {
    const rig = rigRepo.findRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", cwd: oldCwd, model: "fixture-model" });
    const sessionName = `${logicalId.replaceAll(".", "-")}@${rigName}`;
    const session = registry.registerSession(node.id, sessionName);
    registry.updateStatus(session.id, "running");
    registry.updateResumeToken(session.id, "claude_session_id", `saved-${node.id}`, "hook");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    const sources = path.join(root, node.id);
    fs.mkdirSync(sources);
    fs.writeFileSync(path.join(sources, "workspace.md"), "# Workspace guidance\nKeep work within the selected project.\n");
    fs.writeFileSync(path.join(sources, "startup.md"), "# Startup checks\nRead the durable queue before taking work.\n");
    fs.writeFileSync(path.join(sources, "greeting.txt"), "An interactive startup message");
    const files: ResolvedStartupFile[] = ["startup.md", "greeting.txt"].map(name => ({
      path: name, absolutePath: path.join(sources, name), ownerRoot: sources,
      deliveryHint: name.endsWith(".md") ? "guidance_merge" : "send_text",
      required: true, appliesOn: ["fresh_start", "restore"],
    }));
    db.prepare(`INSERT INTO node_startup_context
      (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime)
      VALUES (?, ?, ?, ?, ?)`).run(node.id, JSON.stringify([{
        category: "guidance", effectiveId: "workspace-guidance", sourceSpec: "agent.yaml", mergeStrategy: "managed_block",
        sourcePath: "workspace.md", resourcePath: "workspace.md", absolutePath: path.join(sources, "workspace.md"),
      }]), JSON.stringify(files), JSON.stringify([{
        type: "send_text", value: "Interactive action", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: false,
      }]), "claude-code");
    return { rig, node, sessionName, files };
  }

  function savedCwd(nodeId: string) {
    return (db.prepare("SELECT cwd FROM nodes WHERE id = ?").get(nodeId) as { cwd: string }).cwd;
  }

  function custody() {
    return Object.fromEntries(["sessions", "bindings", "occupant_tenures", "queue_items", "queue_transitions", "node_startup_context"]
      .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  }

  function cwdEvents() {
    return (db.prepare("SELECT payload FROM events WHERE type = 'node.cwd_changed' ORDER BY seq").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload));
  }

  function signal() {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    return { ready, release };
  }

  function guard() {
    migrate(db, [outboxEntriesSchema, seatDeliveryGuardSchema]);
    return tmux.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  }

  function copiedResource(runtime: "claude-code" | "codex" | "pi" | "omp" | "stub", kind: "subagent" | "startup-skill" | "plugin" | "skill" | "runtime_resource") {
    const seat = seed();
    db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, seat.node.id);
    db.prepare("UPDATE node_startup_context SET runtime = ? WHERE node_id = ?").run(runtime, seat.node.id);
    const fsOps = {
      readFile: (file: string) => fs.readFileSync(file, "utf8"), writeFile: (file: string, content: string) => fs.writeFileSync(file, content),
      exists: fs.existsSync, mkdirp: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); },
      listFiles: (dir: string) => fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter(file => !fs.lstatSync(path.join(dir, file)).isDirectory()),
      homedir: path.join(root, "native-home"),
    };
    const stateRoot = path.join(root, `${runtime}-state`);
    const runnerDeps = { tmux, fsOps, stateRoot, runnerEntryPath: path.join(root, "unused-runner.js") };
    const adapters: Record<typeof runtime, RuntimeAdapter> = {
      "claude-code": adapter,
      codex: new CodexRuntimeAdapter({ tmux, fsOps }),
      pi: new PiRuntimeAdapter(runnerDeps),
      omp: new OmpRuntimeAdapter(runnerDeps),
      stub: new StubRuntimeAdapter({ tmux, fsOps }),
    };
    const selectedAdapter = adapters[runtime];
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { [runtime]: selectedAdapter } });
    const sourceDir = path.join(root, "review-resource");
    const directoryResource = kind === "plugin" || kind === "skill";
    const sourcePath = path.join(sourceDir, kind === "startup-skill" ? "SKILL.md" : directoryResource ? "nested/helper.js" : "reviewer.md");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "Updated resource from the saved startup context\n");
    if (kind === "skill") fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Review skill\n");
    if (kind === "startup-skill") {
      db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify([
        ...seat.files, { path: "SKILL.md", absolutePath: sourcePath, ownerRoot: sourceDir,
          deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] },
      ]), seat.node.id);
    } else {
      const row = db.prepare("SELECT projection_entries_json FROM node_startup_context WHERE node_id = ?").get(seat.node.id) as { projection_entries_json: string };
      db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?").run(JSON.stringify([
        ...JSON.parse(row.projection_entries_json), { category: kind, effectiveId: "review-resource", sourceSpec: "agent.yaml",
          sourcePath: sourceDir, resourcePath: directoryResource ? "." : "reviewer.md", absolutePath: directoryResource ? sourceDir : sourcePath,
          ...(kind === "plugin" ? { pluginType: runtime === "claude-code" ? "claude" : "codex" } : {}), },
      ]), seat.node.id);
    }
    const skillsRoot = runtime === "pi" || runtime === "omp"
      ? path.join(piSeatPaths(stateRoot, seat.sessionName).agentDir, "skills")
      : path.join(newCwd, runtime === "stub" ? ".openrig/stub" : runtime === "claude-code" ? ".claude" : ".agents", "skills");
    const targetPath = kind === "startup-skill" || kind === "skill"
      ? path.join(skillsRoot, "review-resource", kind === "startup-skill" ? "SKILL.md" : "nested/helper.js")
      : kind === "plugin"
        ? path.join(newCwd, runtime === "claude-code" ? ".claude" : ".codex", "plugins", "review-resource", "nested/helper.js")
        : kind === "runtime_resource"
          ? path.join(newCwd, runtime === "claude-code" ? ".claude" : ".agents", "extensions", "review-resource", "reviewer.md")
          : path.join(newCwd, runtime === "claude-code" ? ".claude/agents" : ".agents", "reviewer.md");
    return { seat, sourcePath, targetPath, selectedAdapter };
  }

  it.each([
    ["claude-code", "subagent"], ["codex", "subagent"],
    ["claude-code", "startup-skill"], ["codex", "startup-skill"],
    ["claude-code", "plugin"], ["codex", "plugin"],
    ["claude-code", "runtime_resource"], ["codex", "runtime_resource"],
    ["pi", "startup-skill"], ["omp", "startup-skill"], ["stub", "startup-skill"],
  ] as const)("protects an operator-edited %s %s before any preparation write", async (runtime, kind) => {
    const { seat, targetPath, selectedAdapter } = copiedResource(runtime, kind);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const operatorContent = "Operator's local edit must survive directory selection\n";
    fs.writeFileSync(targetPath, operatorContent);
    new ProjectionManifestStore(db).record({ targetPath, lastHash: hashContent("Previous OpenRig projection\n"), writtenAt: new Date().toISOString() });
    const before = custody();
    const project = vi.spyOn(selectedAdapter, "project");
    const deliver = vi.spyOn(selectedAdapter, "deliverStartup");
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe(operatorContent);
    expect(result).toMatchObject({ ok: false, code: "cwd_destination_conflict", preparedCwd: newCwd });
    expect(JSON.stringify(result)).toContain(targetPath);
    expect(project).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    expect(cwdEvents()).toEqual([]);
  });

  it.each(["claude-code", "codex", "pi", "omp", "stub"] as const)("leaves %s ambient skills to the current loadout instead of replaying an old catalog selection", async runtime => {
    const { seat, targetPath } = copiedResource(runtime, "skill");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Operator's current skill helper\n");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: true });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("Operator's current skill helper\n");
    expect(fs.existsSync(path.join(path.dirname(path.dirname(targetPath)), "SKILL.md"))).toBe(false);
    expect(new ProjectionManifestStore(db).get(targetPath)).toBeNull();
  });

  it.each(["claude-code", "codex"] as const)("rejects a symlinked %s plugin subdirectory before any preparation write", async runtime => {
    const { seat, sourcePath, selectedAdapter } = copiedResource(runtime, "plugin");
    const linkedSource = path.join(root, "linked-support");
    fs.mkdirSync(linkedSource);
    fs.writeFileSync(path.join(linkedSource, "helper.md"), "Linked helper\n");
    fs.symlinkSync(linkedSource, path.join(path.dirname(path.dirname(sourcePath)), "linked-support"),
      process.platform === "win32" ? "junction" : "dir");
    const project = vi.spyOn(selectedAdapter, "project");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "cwd_preparation_failed", preparedCwd: newCwd });
    expect(fs.readdirSync(newCwd)).toEqual([]);
    expect(project).not.toHaveBeenCalled();
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it.each(["claude-code", "codex", "pi", "omp", "stub"] as const)("tracks %s copies so unchanged output refreshes but subsequent operator edits are protected", async runtime => {
    const { seat, sourcePath, targetPath } = copiedResource(runtime, "startup-skill");
    const input = { seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" };
    expect(await service.setCwd(input)).toMatchObject({ ok: true });
    fs.writeFileSync(sourcePath, "New upstream startup content\n");
    expect(await service.setCwd(input)).toMatchObject({ ok: true, changed: false });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("New upstream startup content\n");
    fs.writeFileSync(targetPath, "Operator refinement\n");
    expect(await service.setCwd(input)).toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("Operator refinement\n");
    expect(savedCwd(seat.node.id)).toBe(newCwd);
    expect(cwdEvents()).toHaveLength(1);
  });

  it.each(["claude-code", "codex"] as const)("protects an unrecorded %s destination file with different content", async runtime => {
    const { seat, targetPath } = copiedResource(runtime, "subagent");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Pre-existing operator resource\n");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" }))
      .toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("Pre-existing operator resource\n");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it.each(["claude-code", "codex", "pi", "omp", "stub"] as const)("does not acquire ownership of an identical unrecorded %s startup file", async runtime => {
    const { seat, sourcePath, targetPath } = copiedResource(runtime, "startup-skill");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const original = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(targetPath, original);
    const input = { seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" };
    expect(await service.setCwd(input)).toMatchObject({ ok: true });
    expect(new ProjectionManifestStore(db).get(targetPath)).toBeNull();
    fs.writeFileSync(sourcePath, "Updated source must not overwrite the unowned file\n");
    expect(await service.setCwd(input)).toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe(original);
  });

  it("protects destination files when the projection manifest cannot be read", async () => {
    const { seat, targetPath } = copiedResource("claude-code", "subagent");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Operator resource\n");
    vi.spyOn(ProjectionManifestStore.prototype, "lastHash").mockImplementation(() => { throw new Error("manifest unreadable"); });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("Operator resource\n");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it("refuses different startup sources for the same destination before writing either", async () => {
    const { seat, sourcePath, targetPath, selectedAdapter } = copiedResource("claude-code", "startup-skill");
    const otherSource = path.join(root, "other-source", "review-resource", "SKILL.md");
    fs.mkdirSync(path.dirname(otherSource), { recursive: true });
    fs.writeFileSync(otherSource, "Conflicting startup source\n");
    const row = db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(seat.node.id) as { resolved_files_json: string };
    const files = JSON.parse(row.resolved_files_json) as ResolvedStartupFile[];
    files.push({ ...files.find(file => file.absolutePath === sourcePath)!, absolutePath: otherSource, ownerRoot: path.dirname(otherSource) });
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify(files), seat.node.id);
    const project = vi.spyOn(selectedAdapter, "project");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(project).not.toHaveBeenCalled();
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it("keeps terminal startup delivery a no-op while saving its launch directory", async () => {
    const { seat } = copiedResource("claude-code", "startup-skill");
    db.prepare("UPDATE nodes SET runtime = 'terminal' WHERE id = ?").run(seat.node.id);
    db.prepare("UPDATE node_startup_context SET runtime = 'terminal' WHERE node_id = ?").run(seat.node.id);
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { terminal: new TerminalAdapter() } });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "move shell workspace" }))
      .toMatchObject({ ok: true, to: newCwd });
    expect(fs.readdirSync(newCwd)).toEqual([]);
  });

  it("warns and skips a missing optional startup copy", async () => {
    const { seat, sourcePath, targetPath } = copiedResource("claude-code", "startup-skill");
    const row = db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(seat.node.id) as { resolved_files_json: string };
    const files = JSON.parse(row.resolved_files_json) as ResolvedStartupFile[];
    files.find(file => file.absolutePath === sourcePath)!.required = false;
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify(files), seat.node.id);
    fs.unlinkSync(sourcePath);
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringContaining("SKILL.md was skipped")]) });
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("does not commit when a prepared resource changes before verification", async () => {
    const { seat, targetPath, selectedAdapter } = copiedResource("claude-code", "subagent");
    const deliver = selectedAdapter.deliverStartup.bind(selectedAdapter);
    vi.spyOn(selectedAdapter, "deliverStartup").mockImplementation(async (...args) => {
      const result = await deliver(...args);
      fs.writeFileSync(targetPath, "Concurrent operator edit\n");
      return result;
    });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "cwd_preparation_failed", preparedCwd: newCwd });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("Concurrent operator edit\n");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it("prepares real startup files and changes only the addressed seat's launch cwd, preserving live custody", async () => {
    const seat = seed();
    const sibling = seed("project", "reviewer");
    const queue = new QueueRepository(db, eventBus, { validateRig: () => true });
    await queue.create({ sourceSession: sibling.sessionName, destinationSession: seat.sessionName, body: "Retained task" } as never);
    const before = custody();
    fs.mkdirSync(newCwd);
    fs.writeFileSync(path.join(newCwd, "CLAUDE.md"), "# Local notes\nKeep these notes.\n");

    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate project planning", operator: "operator@project" });

    expect(result).toMatchObject({ ok: true, from: oldCwd, to: newCwd, changed: true, effect: "next_launch" });
    expect(savedCwd(seat.node.id)).toBe(newCwd);
    expect(savedCwd(sibling.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    const prepared = fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8");
    expect(prepared).toContain("Keep these notes.");
    expect(prepared).toContain("Keep work within the selected project.");
    expect(prepared).toContain("Read the durable queue before taking work.");
    expect(prepared).not.toContain("An interactive startup message");
    expect(fs.readFileSync(path.join(oldCwd, "CLAUDE.md"), "utf8")).toBe("Shared directory instructions\n");
    for (const operation of [tmux.sendText, tmux.sendKeys, tmux.killSession, tmux.createSession]) expect(operation).not.toHaveBeenCalled();
    expect(cwdEvents()).toEqual([expect.objectContaining({ nodeId: seat.node.id, rigId: seat.rig.id,
      from: oldCwd, to: newCwd, reason: "isolate project planning", operator: "operator@project" })]);
  });

  it("creates a missing destination and makes repeat preparation idempotent without another cwd event", async () => {
    const seat = seed();
    const input = { seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" };
    expect((await service.setCwd(input)).ok).toBe(true);
    const content = fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8");
    expect(await service.setCwd(input)).toMatchObject({ ok: true, changed: false, to: newCwd });
    expect(fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8").trimEnd()).toBe(content.trimEnd());
    expect(cwdEvents()).toHaveLength(1);
  });

  it("retains the old cwd and history when a required startup file cannot be prepared", async () => {
    const seat = seed();
    fs.unlinkSync(seat.files[0]!.absolutePath);
    const before = custody();
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" });
    expect(result).toMatchObject({ ok: false, code: "cwd_preparation_failed" });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    expect(cwdEvents()).toEqual([]);
    expect(fs.readFileSync(path.join(oldCwd, "CLAUDE.md"), "utf8")).toBe("Shared directory instructions\n");
  });

  it("stores a symlink destination's real directory and treats that directory as the same selection", async () => {
    const seat = seed();
    fs.mkdirSync(newCwd);
    const alias = path.join(root, "workspace-link");
    fs.symlinkSync(newCwd, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: alias, reason: "isolate workspace" }))
      .toMatchObject({ ok: true, to: fs.realpathSync(newCwd), changed: true });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "same workspace" }))
      .toMatchObject({ ok: true, changed: false });
    expect(cwdEvents()).toHaveLength(1);
  });

  it("rolls back the cwd if persisting its audit event fails", async () => {
    const seat = seed();
    vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("audit unavailable"); });
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" });
    expect(result).toMatchObject({ ok: false, code: "cwd_persistence_failed", preparedCwd: newCwd });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
    expect(fs.readFileSync(path.join(newCwd, "CLAUDE.md"), "utf8")).toContain("Startup checks");
  });

  it.each(["", "relative/workspace", path.parse(process.cwd()).root])("rejects an invalid destination %j before preparing files", async cwd => {
    const seat = seed();
    const project = vi.spyOn(adapter, "project");
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd, reason: "prepare workspace" });
    expect(result.ok).toBe(false);
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(project).not.toHaveBeenCalled();
    expect(cwdEvents()).toEqual([]);
  });

  it("refuses an ambiguous logical id before creating the destination", async () => {
    seed("first");
    seed("second");
    expect(await service.setCwd({ seatRef: "planning.lead", cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "seat_ambiguous" });
    expect(fs.existsSync(newCwd)).toBe(false);
  });

  it("honors the selected Claude managed-block file and resolves auto files without typing", async () => {
    const seat = seed();
    rigRepo.setRigClaudeManagedBlockFile(seat.rig.id, "CLAUDE.local.md");
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?")
      .run(JSON.stringify([
        ...seat.files.map(file => ({ ...file, deliveryHint: "auto" })),
        { ...seat.files[0], path: "restore-only.md", absolutePath: path.join(root, "missing.md"), appliesOn: ["restore"] },
      ]), seat.node.id);

    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
    const content = fs.readFileSync(path.join(newCwd, "CLAUDE.local.md"), "utf8");
    expect(content).toContain("Read the durable queue");
    expect(content).not.toContain("interactive startup message");
    expect(fs.existsSync(path.join(newCwd, "CLAUDE.md"))).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("prepares Codex startup guidance through its real adapter", async () => {
    const seat = seed();
    db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seat.node.id);
    db.prepare("UPDATE node_startup_context SET runtime = 'codex' WHERE node_id = ?").run(seat.node.id);
    const codex = new CodexRuntimeAdapter({ tmux, fsOps: {
      readFile: file => fs.readFileSync(file, "utf8"), writeFile: (file, content) => fs.writeFileSync(file, content),
      exists: fs.existsSync, mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
      homedir: path.join(root, "native-home"),
    } });
    const codexService = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: { codex } });
    expect(await codexService.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
    const content = fs.readFileSync(path.join(newCwd, "AGENTS.md"), "utf8");
    expect(content).toContain("Keep work within the selected project.");
    expect(content).toContain("Read the durable queue");
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("prepares a guarded seat without an input lease or changing its protection", async () => {
    const seat = seed();
    const protection = guard();
    await protection.set(seat.node.id, true, "operator", "typing a draft");
    const preference = protection.preference(seat.node.id);
    const project = adapter.project.bind(adapter);
    vi.spyOn(adapter, "project").mockImplementation(async (...args) => {
      expect(() => protection.checkInput(seat.node.id)).toThrow(/lease/);
      return project(...args);
    });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare later launch" })).toMatchObject({ ok: true });
    expect(protection.preference(seat.node.id)).toEqual(preference);
    expect(new SeatStatusService({ rigRepo }).getStatus(seat.sessionName)).toMatchObject({
      ok: true, status: { launch_cwd: newCwd, current_occupant: seat.sessionName },
    });
  });

  it("waits for a lifecycle operation and keeps a later launch behind preparation and commit", async () => {
    const seat = seed();
    const protection = guard();
    const lifecycleEntered = signal();
    const finishLifecycle = signal();
    const preparationEntered = signal();
    const finishPreparation = signal();
    const project = adapter.project.bind(adapter);
    const projection = vi.spyOn(adapter, "project").mockImplementation(async (...args) => {
      preparationEntered.release();
      await finishPreparation.ready;
      return project(...args);
    });
    const earlier = protection.lifecycle([seat.node.id], async () => {
      lifecycleEntered.release();
      await finishLifecycle.ready;
    });
    await Promise.race([lifecycleEntered.ready, earlier]);
    const changing = service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "next launch" });
    let launchCwd: string | undefined;
    const later = protection.lifecycle([seat.node.id], async () => { launchCwd = savedCwd(seat.node.id); });
    try {
      await Promise.resolve();
      expect(projection).not.toHaveBeenCalled();
      finishLifecycle.release();
      await preparationEntered.ready;
      expect(launchCwd).toBeUndefined();
      expect(savedCwd(seat.node.id)).toBe(oldCwd);
    } finally {
      finishLifecycle.release();
      finishPreparation.release();
      await earlier;
      await later;
    }
    expect(await changing).toMatchObject({ ok: true });
    expect(launchCwd).toBe(newCwd);
  });

  it.each(["cwd", "runtime", "startup"])("does not commit over a concurrent %s change", async field => {
    const seat = seed();
    const project = adapter.project.bind(adapter);
    const otherCwd = path.join(root, "other-workspace");
    vi.spyOn(adapter, "project").mockImplementation(async (...args) => {
      const result = await project(...args);
      if (field === "cwd") db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(otherCwd, seat.node.id);
      if (field === "runtime") db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seat.node.id);
      if (field === "startup") db.prepare("UPDATE node_startup_context SET startup_actions_json = '[]' WHERE node_id = ?").run(seat.node.id);
      return result;
    });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "cwd_configuration_changed", preparedCwd: newCwd });
    expect(savedCwd(seat.node.id)).toBe(field === "cwd" ? otherCwd : oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it.each(["missing", "malformed", "runtime"])("refuses %s startup context before preparation", async kind => {
    const seat = seed();
    if (kind === "missing") db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(seat.node.id);
    if (kind === "malformed") db.prepare("UPDATE node_startup_context SET resolved_files_json = 'not-json' WHERE node_id = ?").run(seat.node.id);
    if (kind === "runtime") db.prepare("UPDATE node_startup_context SET runtime = 'codex' WHERE node_id = ?").run(seat.node.id);
    const code = kind === "runtime" ? "startup_context_runtime_mismatch" : `startup_context_${kind}`;
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" })).toMatchObject({ ok: false, code });
    expect(fs.existsSync(newCwd)).toBe(false);
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it("reports projection failure, retains the old selection and releases the configuration lock", async () => {
    const seat = seed();
    guard();
    const project = vi.spyOn(adapter, "project").mockResolvedValueOnce({
      projected: [], skipped: [], failed: [{ effectiveId: "workspace-guidance", error: "source unavailable" }],
    });
    const input = { seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" };
    expect(await service.setCwd(input)).toMatchObject({ ok: false, code: "cwd_preparation_failed", preparedCwd: newCwd });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
    project.mockRestore();
    expect(await service.setCwd(input)).toMatchObject({ ok: true });
  });

  it("rejects a file destination without changing its contents", async () => {
    const seat = seed();
    fs.writeFileSync(newCwd, "existing file");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "prepare workspace" }))
      .toMatchObject({ ok: false, code: "invalid_cwd" });
    expect(fs.readFileSync(newCwd, "utf8")).toBe("existing file");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });
});
