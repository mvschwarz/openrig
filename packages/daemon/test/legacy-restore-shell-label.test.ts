// A legacy (pod-less) restore resumes Claude or Codex by typing a launch into the pane. While the staged launch
// script still holds the foreground, tmux labels the pane with that shell. Only a proven, stable idle shell may end
// the resume as a return to the shell (which rolls the seat back to zero sessions); a launch script still starting
// the runtime, or process evidence that's missing or changing, keeps the launch for attention with its pane, binding
// and token. Process observations are controlled; the restore, the resume adapters and the database are real.
import { describe, it, expect, vi } from "vitest";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { createFullTestDb } from "./helpers/test-app.js";

const startedAt = "Fri Oct 17 06:00:00 2026";
const paneShell: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "zsh", command: "-zsh", startedAt };
// The pane shell runs the staged launch script as its foreground job before the runtime appears.
const launchWrapper: NativeProcessRow[] = [
  { ...paneShell, tpgid: 101 },
  { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "sh /tmp/openrig-launch.sh", startedAt },
];
const idleShell: NativeProcessRow[] = [paneShell];
const TOKEN = "tok-abc";

function tmuxFor(label: string): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => label),
    capturePaneContent: vi.fn(async () => ""),
    getPanePid: vi.fn(async () => 100),
    hasSession: vi.fn(async () => false),
    probeSession: vi.fn(async () => ({ state: "absent" as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
  } as unknown as TmuxAdapter;
}

const runtimes = [
  { runtime: "claude-code", resumeType: "claude_id" },
  { runtime: "codex", resumeType: "codex_id" },
] as const;

async function legacyRestore(runtime: (typeof runtimes)[number], label: string, listProcesses: () => NativeProcessRow[]) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const tmux = tmuxFor(label);
  const fast = { pollMs: 1, maxWaitMs: 2, sleep: async () => {}, listProcesses };
  const orchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }), tmuxAdapter: tmux,
    claudeResume: new ClaudeResumeAdapter(tmux, fast), codexResume: new CodexResumeAdapter(tmux, fast),
  });
  // A pod-less node with a resumable session in the snapshot takes the legacy resume path.
  const rig = rigRepo.createRig("r88");
  const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: runtime.runtime, cwd: "/tmp" });
  const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
  const data = JSON.parse(JSON.stringify(snapshotRepo.getSnapshot(snap.id)!.data));
  data.sessions = [{ id: "sess-1", nodeId: node.id, sessionName: "r88-worker", status: "running",
    resumeType: runtime.resumeType, resumeToken: TOKEN, restorePolicy: "resume_if_possible" }];
  data.activeSessionIdByNode = { [node.id]: "sess-1" };
  data.activeOccupantsByNode = { [node.id]: { kind: "resolved", sessionId: "sess-1" } };
  db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

  const outcome = await orchestrator.restore(snap.id);
  if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);
  const result = outcome.result.nodes.find((n) => n.nodeId === node.id)!;
  const launched = db.prepare("SELECT session_name, status, resume_launch_token FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(node.id) as { session_name: string; status: string; resume_launch_token: string | null } | undefined;
  const binding = sessionRegistry.getBindingForNode(node.id);
  const snapshotToken = (snapshotRepo.getSnapshot(snap.id)!.data as { sessions: Array<{ resumeToken: string }> }).sessions[0]!.resumeToken;
  db.close();
  return { result, launched, binding, snapshotToken, killed: vi.mocked(tmux.killSession).mock.calls.length > 0 };
}

describe.each(runtimes)("legacy $runtime restore with a shell label", (runtime) => {
  it.each<[string, string, () => () => NativeProcessRow[]]>([
    ["the launch wrapper holds the foreground before the runtime appears", "sh", () => () => launchWrapper],
    ["the process listing is unavailable", "zsh", () => () => []],
    ["the pane's shell changes between the two samples", "zsh",
      () => { let n = 0; return () => (n++ === 0 ? idleShell : [{ ...paneShell, startedAt: "Fri Oct 17 06:00:05 2026" }]); }],
  ])("keeps the launch for attention when %s", async (_name, label, makeList) => {
    const { result, launched, binding, snapshotToken, killed } = await legacyRestore(runtime, label, makeList());
    expect(result.status).toBe("attention_required");
    expect(result.error).toContain("isn't a proven idle shell");
    // Nothing was rolled back: the pane, its binding and the launched session stay, and the token is kept.
    expect(killed).toBe(false);
    expect(launched?.status).toBe("running");
    expect(binding?.tmuxSession).toBe(launched?.session_name);
    expect(snapshotToken).toBe(TOKEN);
    if (runtime.runtime === "claude-code") expect(launched?.resume_launch_token).toBe(TOKEN);
  });

  it.skipIf(runtime.runtime !== "codex")("keeps the launch when an idle shell is observed before the launch wrapper appears", async () => {
    let n = 0;
    const { result, launched, binding, snapshotToken, killed } = await legacyRestore(runtime, "zsh", () => {
      n++;
      return n <= 2 ? idleShell : launchWrapper;
    });
    expect(result.status).toBe("attention_required");
    expect(result.error).toContain("isn't a proven idle shell");
    expect(killed).toBe(false);
    expect(launched?.status).toBe("running");
    expect(binding?.tmuxSession).toBe(launched?.session_name);
    expect(snapshotToken).toBe(TOKEN);
  });

  it("still rolls back a proven, stable idle shell as a return to the shell", async () => {
    const { result, launched, killed } = await legacyRestore(runtime, "zsh", () => idleShell);
    expect(result.status).toBe("awaiting-decision");
    expect(result.error).toContain("resume attempted but failed");
    expect(killed).toBe(true);
    expect(launched?.status).toBe("superseded");
  });
});
