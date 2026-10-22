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
import { withCommunityHarnessResolver } from "../src/adapters/community-harness-runtime-adapter.js";
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

  // The smaller shape: set-cwd validates, checks the new directory read-only, then saves the cwd and its audit event
  // together. It writes no startup files (the next launch does), and it never touches the running occupant.

  it("saves the new directory and one audit event, keeps the seat's custody, and writes nothing there but the folder", async () => {
    const seat = seed();
    const before = custody();
    const project = vi.spyOn(adapter, "project");
    const deliver = vi.spyOn(adapter, "deliverStartup");
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate planning", operator: "lead@project" });
    expect(result).toMatchObject({ ok: true, from: oldCwd, to: fs.realpathSync(newCwd), changed: true, effect: "next_launch" });
    expect(savedCwd(seat.node.id)).toBe(fs.realpathSync(newCwd));
    expect(cwdEvents()).toEqual([expect.objectContaining({ from: oldCwd, to: fs.realpathSync(newCwd), reason: "isolate planning", operator: "lead@project" })]);
    expect(custody()).toEqual(before);
    expect(fs.readdirSync(newCwd)).toEqual([]);
    expect(project).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(oldCwd, "CLAUDE.md"), "utf8")).toBe("Shared directory instructions\n");
    // Only the addressed seat moved.
    const other = seed("project", "planning.peer");
    expect(savedCwd(other.node.id)).toBe(oldCwd);
  });

  it("stores a symlink destination's real directory, and the same directory again records no second event", async () => {
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

  it.each(["", "relative/workspace", path.parse(process.cwd()).root])("refuses an invalid destination %j, with no seat, custody or startup-file change", async cwd => {
    const seat = seed();
    const before = custody();
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd, reason: "isolate workspace" });
    expect(result).toMatchObject({ ok: false });
    expect(["missing_cwd", "invalid_cwd"]).toContain((result as { code: string }).code);
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    expect(cwdEvents()).toEqual([]);
  });

  it("refuses a file destination without changing its contents", async () => {
    const seat = seed();
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "not a directory\n");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: file, reason: "isolate workspace" })).toMatchObject({ ok: false, code: "invalid_cwd" });
    expect(fs.readFileSync(file, "utf8")).toBe("not a directory\n");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it("refuses an ambiguous logical id before creating the destination", async () => {
    seed("first");
    seed("second");
    expect(await service.setCwd({ seatRef: "planning.lead", cwd: newCwd, reason: "isolate workspace" }))
      .toMatchObject({ ok: false, code: "seat_ambiguous" });
    expect(fs.existsSync(newCwd)).toBe(false);
  });

  it.each(["missing", "malformed", "runtime"])("refuses %s startup context and keeps the old directory", async kind => {
    const seat = seed();
    if (kind === "missing") db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(seat.node.id);
    if (kind === "malformed") db.prepare("UPDATE node_startup_context SET resolved_files_json = 'not-json' WHERE node_id = ?").run(seat.node.id);
    if (kind === "runtime") db.prepare("UPDATE node_startup_context SET runtime = 'codex' WHERE node_id = ?").run(seat.node.id);
    const code = kind === "runtime" ? "startup_context_runtime_mismatch" : `startup_context_${kind}`;
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: false, code });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it.each([
    ["claude-code", "subagent"], ["codex", "subagent"],
    ["claude-code", "startup-skill"], ["codex", "startup-skill"],
    ["claude-code", "plugin"], ["codex", "plugin"],
    ["claude-code", "runtime_resource"], ["codex", "runtime_resource"],
    ["pi", "startup-skill"], ["omp", "startup-skill"], ["stub", "startup-skill"],
  ] as const)("refuses an operator-edited %s %s in the new directory, naming it, with no seat, custody or startup-file change", async (runtime, kind) => {
    const { seat, targetPath } = copiedResource(runtime, kind);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const operatorContent = "Operator's local edit must survive directory selection\n";
    fs.writeFileSync(targetPath, operatorContent);
    new ProjectionManifestStore(db).record({ targetPath, lastHash: hashContent("Previous OpenRig projection\n"), writtenAt: new Date().toISOString() });
    const before = custody();
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe(operatorContent);
    expect(result).toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(JSON.stringify(result)).toContain(targetPath);
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(custody()).toEqual(before);
    expect(cwdEvents()).toEqual([]);
  });

  it.each(["claude-code", "codex"] as const)("refuses an unrecorded %s destination file with different content", async runtime => {
    const { seat, targetPath } = copiedResource(runtime, "subagent");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Pre-existing operator resource\n");
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" }))
      .toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("Pre-existing operator resource\n");
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
  });

  it.each(["claude-code", "codex", "pi", "omp", "stub"] as const)("accepts an identical unrecorded %s startup file without taking ownership of it", async runtime => {
    const { seat, sourcePath, targetPath } = copiedResource(runtime, "startup-skill");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, fs.readFileSync(sourcePath, "utf8"));
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
    expect(new ProjectionManifestStore(db).get(targetPath)).toBeNull();
  });

  it("refuses different startup sources for the same destination", async () => {
    const { seat, targetPath } = copiedResource("claude-code", "startup-skill");
    const other = path.join(root, "other-source", "review-resource", "SKILL.md");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "A different source for the same skill\n");
    const row = db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(seat.node.id) as { resolved_files_json: string };
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify([
      ...JSON.parse(row.resolved_files_json), { path: "SKILL.md", absolutePath: other, ownerRoot: path.dirname(other),
        deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] },
    ]), seat.node.id);
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" });
    expect(result).toMatchObject({ ok: false, code: "cwd_destination_conflict" });
    expect(JSON.stringify(result)).toContain(targetPath);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it.each(["cwd", "runtime", "startup"])("doesn't commit over a %s change made between the check and the commit", async field => {
    const seat = seed();
    const otherCwd = path.join(root, "other-workspace");
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(((fn: (...a: unknown[]) => unknown) => {
      // Another writer changes the seat after the read-only check, just before the commit opens.
      if (field === "cwd") db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(otherCwd, seat.node.id);
      if (field === "runtime") db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seat.node.id);
      if (field === "startup") db.prepare("UPDATE node_startup_context SET startup_actions_json = '[]' WHERE node_id = ?").run(seat.node.id);
      return transaction(fn);
    }) as typeof db.transaction);
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" }))
      .toMatchObject({ ok: false, code: "cwd_configuration_changed" });
    expect(savedCwd(seat.node.id)).toBe(field === "cwd" ? otherCwd : oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it("rolls back the cwd if persisting its audit event fails", async () => {
    const seat = seed();
    vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("audit unavailable"); });
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" }))
      .toMatchObject({ ok: false, code: "cwd_persistence_failed" });
    expect(savedCwd(seat.node.id)).toBe(oldCwd);
    expect(cwdEvents()).toEqual([]);
  });

  it("resolves a community harness's adapter the way launch does, and checks none of the startup files it never takes", async () => {
    const seat = seed();
    const presets = path.join(root, "community-harnesses");
    fs.mkdirSync(presets);
    fs.writeFileSync(path.join(presets, "synth.yaml"), "format: 1\nname: synth\ncommand: synth-harness --serve\nmaintainer: Example Maintainer\nlimits: [resume unsupported]\n");
    db.prepare("UPDATE nodes SET runtime = 'synth' WHERE id = ?").run(seat.node.id);
    db.prepare("UPDATE node_startup_context SET runtime = 'synth' WHERE node_id = ?").run(seat.node.id);
    // A required startup skill the app would never take (a community harness takes no startup files).
    const skill = path.join(root, "app-skill", "review", "SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "# Review\n");
    db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id = ?").run(JSON.stringify([
      ...seat.files, { path: "SKILL.md", absolutePath: skill, ownerRoot: path.dirname(skill), deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] },
    ]), seat.node.id);
    const sessionId = (db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(seat.node.id) as { id: string }).id;
    registry.recordCommunityHarnessSelection(sessionId, "synth");
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      runtimeAdapters: withCommunityHarnessResolver({ "claude-code": adapter } as Record<string, RuntimeAdapter>, { tmux, presetsDir: () => presets }) });
    const result = await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" });
    // No refusal code, named first so a failure shows which one.
    expect((result as { code?: string }).code).toBeUndefined();
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(savedCwd(seat.node.id)).toBe(fs.realpathSync(newCwd));
  });

  it("works with the seat's typing guard on, without an input lease and without changing its protection", async () => {
    const seat = seed();
    const seatGuard = guard();
    const preference = JSON.stringify(seatGuard.target(seat.sessionName));
    expect(await service.setCwd({ seatRef: seat.sessionName, cwd: newCwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
    expect(JSON.stringify(seatGuard.target(seat.sessionName))).toBe(preference);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });
});
