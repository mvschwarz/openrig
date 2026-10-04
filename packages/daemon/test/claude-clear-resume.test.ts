import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const startedAt = "2020-01-01T01:00:00Z";

describe("Claude current conversation at shutdown", () => {
  let db: ReturnType<typeof createDb>;
  let root: string;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let capture: SnapshotCapture;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-clear-resume-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    capture = new SnapshotCapture({ db, rigRepo, sessionRegistry: registry, eventBus, snapshotRepo, checkpointStore: new CheckpointStore(db) });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(provenance: "scrape" | "operator" | "hook" = "scrape", configDir = path.join(root, ".claude")) {
    const rig = rigRepo.createRig("clear-test");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd: root });
    const name = "worker@clear-test";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    registry.updateResumeToken(session.id, "claude_id", oldId, provenance);
    const rows = [
      { pid: 900, ppid: 1, pgid: 900, tpgid: 901, executableName: "bash", command: "bash", startedAt },
      { pid: 901, ppid: 900, pgid: 901, tpgid: 901, executableName: "claude", command: `claude --session-id ${oldId} --name ${name}`, startedAt },
    ];
    const listClaudeProcesses = vi.fn(async () => rows);
    const probe = vi.fn(async () => "resumable" as const); // Old history still exists after /clear.
    const tmux = {
      getPanePid: vi.fn(async () => 900),
      killSession: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry: registry, tmuxAdapter: tmux, homeDir: root,
      claudeConfigDir: configDir, listClaudeProcesses, probeClaudeResume: probe,
    });
    const file = path.join(configDir, "sessions", "901.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name, sessionId: newId }));
    // Deterministic current-process timestamp, independent of the test machine's date.
    fs.utimesSync(file, new Date("2020-01-01T02:00:00Z"), new Date("2020-01-01T02:00:00Z"));
    const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry: registry, eventBus, snapshotCapture: capture, tmuxAdapter: tmux, resumeMetadataRefresher: refresher });
    return { rig, session, name, rows, file, tmux, probe, listClaudeProcesses, refresher, teardown };
  }

  it("captures the post-clear conversation in the actual auto-pre-down snapshot", async () => {
    const f = fixture();
    // Another seat has the same name; a name scan must not select its old conversation.
    fs.writeFileSync(path.join(path.dirname(f.file), "899.json"), JSON.stringify({ name: f.name, sessionId: oldId }));
    const result = await f.teardown.teardown(f.rig.id);
    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(1);
    const snap = snapshotRepo.getSnapshot(result.snapshotId!)!;
    expect(snap.kind).toBe("auto-pre-down");
    expect(snap.data.sessions.find(s => s.id === f.session.id)?.resumeToken).toBe(newId);
    expect(registry.getSessionsForRig(f.rig.id)[0]?.resumeToken).toBe(newId);
    expect(f.probe).not.toHaveBeenCalled();
  });

  it("uses the selected provider config directory for the live PID", async () => {
    const f = fixture("scrape", path.join(root, "custom-config"));
    await f.teardown.teardown(f.rig.id);
    expect(registry.getSessionsForRig(f.rig.id)[0]?.resumeToken).toBe(newId);
  });

  it("preserves the same conversation when no clear occurred", async () => {
    const f = fixture();
    fs.writeFileSync(f.file, JSON.stringify({ name: f.name, sessionId: oldId }));
    await f.teardown.teardown(f.rig.id);
    expect(registry.getSessionsForRig(f.rig.id)[0]?.resumeToken).toBe(oldId);
  });

  it.each(["missing", "malformed", "wrong-name", "invalid-id", "old-file", "changed-process", "ambiguous-process", "background-process"])("keeps existing shutdown behavior on %s evidence", async (kind) => {
    const f = fixture();
    if (kind === "missing") fs.unlinkSync(f.file);
    if (kind === "malformed") fs.writeFileSync(f.file, "{");
    if (kind === "wrong-name") fs.writeFileSync(f.file, JSON.stringify({ name: "different-seat", sessionId: newId }));
    if (kind === "invalid-id") fs.writeFileSync(f.file, JSON.stringify({ name: f.name, sessionId: [newId] }));
    if (kind === "old-file") fs.utimesSync(f.file, new Date(0), new Date(0));
    if (kind === "changed-process") f.listClaudeProcesses.mockResolvedValueOnce(f.rows).mockResolvedValue([]);
    if (kind === "ambiguous-process") f.rows.push({ ...f.rows[1]!, pid: 902 });
    if (kind === "background-process") f.rows[1]!.pgid = 902;
    const result = await f.teardown.teardown(f.rig.id);
    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(1);
    expect(registry.getSessionsForRig(f.rig.id)[0]?.resumeToken).toBe(oldId);
    expect(f.probe).toHaveBeenCalledWith(f.name, oldId, root);
  });

  it.each(["operator", "hook"] as const)("does not replace a protected %s token", async (provenance) => {
    const f = fixture(provenance);
    await f.teardown.teardown(f.rig.id);
    const session = registry.getSessionsForRig(f.rig.id)[0]!;
    expect(session.resumeToken).toBe(oldId);
    expect(session.resumeProvenance).toBe(provenance);
  });

  it("does not add process reads or change tokens on periodic fill-null refresh", async () => {
    const f = fixture();
    await f.refresher.refresh([{ sessionId: f.session.id, sessionName: f.name, runtime: "claude-code", resumeType: "claude_id", resumeToken: oldId }], { fillNullOnly: true });
    expect(f.listClaudeProcesses).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(registry.getSessionsForRig(f.rig.id)[0]?.resumeToken).toBe(oldId);
  });
});
