// OPR.0.5.7.1 — RESTORE HONESTY, phase D1+D6 (locked SPEC, post-stamp sha256
// 0d41bf374efea4fdb24e36b5c891135a3ff5ffa9ac7f6b8fefb08c1c7e55ace9).
//
// D1 SELECTION: restore must consume the ACTIVE-OCCUPANT relation, never
// max-row-ID. A historical/superseded row with a newer ULID must never defeat
// the actual occupant token (three live specimens in incident 1e4d9837).
// Order of authority: explicit activeSessionIdByNode relation > uniquely-
// running legacy fallback > ambiguity fails LOUDLY (unrecoverable-until-
// resolved, zero replacement occupant). The max-ULID reduce disappears from
// BOTH cite sites — pinned behaviorally (R1-R4) AND structurally (R5), so the
// false mechanism's absence holds in every encoding.
//
// D6 REPLAY CONTAINMENT: an exact resume delivers ZERO startup/onboarding
// content into the resumed history by default (the ghost-prompt source; the
// live specimen: managed CLAUDE.md blocks rewritten at 22:57Z during a
// "resume"). Any replay into an existing history requires an explicit,
// versioned, idempotent opt-in recorded on the restore result. Deliberate
// fresh-primed launches keep their replay — containment is resume-scoped.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { Snapshot } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

// Hand-authored ULIDs where lexical order is the trap: OLD sorts before NEW,
// so "latest = max id" (the defect) picks NEW.
const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_MID = "01ARZ3NDEKTSV4RRFFQ69G5MMM";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockClaudeResume(result?: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResume(): CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as CodexResumeAdapter;
}

/** Content-channel spy adapter: `project` carries projection entries (managed
 *  blocks), `deliverStartup` carries startup files/actions. D6's whole claim
 *  is about what reaches these two on a resumed history. */
function spyRuntimeAdapter() {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "t", resumeType: "claude_id" })),
  };
}

describe("OPR.0.5.7.1 — restore honesty D1 + D6", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function createOrchestrator(opts?: { claude?: ClaudeResumeAdapter; tmux?: TmuxAdapter }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: opts?.claude ?? mockClaudeResume(),
      codexResume: mockCodexResume(),
    });
  }

  /** One-node rig + captured snapshot; caller then rewrites data.sessions to
   *  the exact multi-row shape under test. */
  function seedSnapshot(opts?: { startupContext?: { entries: unknown[]; files: unknown[]; actions: unknown[] } }): { snap: Snapshot; nodeId: string } {
    const rig = rigRepo.createRig("r77");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "r77-seat");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-seed", "resume_if_possible", sess.id);
    if (opts?.startupContext) {
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
        .run(node.id, JSON.stringify(opts.startupContext.entries), JSON.stringify(opts.startupContext.files), JSON.stringify(opts.startupContext.actions), "claude-code");
    }
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    // Stop the rig so restore admits (post-crash shape: rows exist, tmux dead).
    sessionRegistry.updateStatus(sess.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);
    return { snap, nodeId: node.id };
  }

  function rewriteSessions(snap: Snapshot, nodeId: string, rows: Array<{ id: string; status: string; token: string }>, activeSessionId?: string): Snapshot {
    const data = JSON.parse(JSON.stringify(snap.data));
    const template = data.sessions.find((s: { nodeId: string }) => s.nodeId === nodeId);
    data.sessions = rows.map((r) => ({
      ...template,
      id: r.id,
      status: r.status,
      resumeType: "claude_name",
      resumeToken: r.token,
      restorePolicy: "resume_if_possible",
    }));
    if (activeSessionId !== undefined) {
      data.activeSessionIdByNode = { [nodeId]: activeSessionId };
    }
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
    const updated = snapshotRepo.getSnapshot(snap.id);
    if (!updated) throw new Error("expected updated snapshot");
    return updated;
  }

  const resumeTokenArg = (claude: ClaudeResumeAdapter, call = 0): unknown =>
    (claude.resume as ReturnType<typeof vi.fn>).mock.calls[call]?.[2];

  // ------------------------------------------------------------------ D1 ---

  it("R1: a superseded row with a newer ULID never defeats the active occupant (incident shape)", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSessions(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
      { id: ULID_NEW, status: "superseded", token: "tok-stale" },
    ]);
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(claude.resume).toHaveBeenCalledTimes(1);
    expect(resumeTokenArg(claude)).toBe("tok-active"); // base: "tok-stale" (max-ULID wins)
  });

  it("R2: an explicit activeSessionIdByNode relation is consumed directly, no status inference", async () => {
    const { snap, nodeId } = seedSnapshot();
    // No uniquely-running fallback available — both rows detached; only the
    // explicit relation can name the occupant.
    const fixed = rewriteSessions(snap, nodeId, [
      { id: ULID_OLD, status: "detached", token: "tok-active" },
      { id: ULID_NEW, status: "detached", token: "tok-stale" },
    ], ULID_OLD);
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active"); // base: relation ignored, "tok-stale"
  });

  it("R3: ambiguity fails LOUDLY — two running rows, no relation => unrecoverable, zero replacement occupant", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSessions(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
      { id: ULID_NEW, status: "running", token: "tok-b" },
    ]);
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const seat = result.result.nodes.find((n) => n.logicalId === "seat");
      expect(seat?.status).toBe("failed"); // base: silently resumes newest
      const err = seat && "error" in seat ? String(seat.error) : "";
      expect(err).toMatch(/ambigu/i); // names the condition…
      expect(err).toContain(ULID_OLD); // …and BOTH candidate rows
      expect(err).toContain(ULID_NEW);
    }
    expect(claude.resume).not.toHaveBeenCalled(); // never newest-row-wins
  });

  it("R4: legacy snapshot with no relation — the UNIQUELY-running row is the interim invariant", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSessions(snap, nodeId, [
      { id: ULID_OLD, status: "exited", token: "tok-oldest" },
      { id: ULID_MID, status: "running", token: "tok-active" },
      { id: ULID_NEW, status: "superseded", token: "tok-stale" },
    ]);
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active"); // base: "tok-stale" (newest ULID)
  });

  it("R5: ABSENCE PIN — the max-ULID reduce is gone from BOTH cite sites (second encoding)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "../src/domain/restore-orchestrator.ts"), "utf8");
    const hits = source.match(/s\.id > latest\.id \? s : latest/g) ?? [];
    expect(hits).toHaveLength(0); // base: exactly 2 occurrences
  });

  // ------------------------------------------------------------------ D6 ---

  const GHOST_CONTEXT = {
    entries: [{
      absolutePath: "/tmp/never-read-existsFn-defaults-true/CLAUDE.md",
      relativePath: "CLAUDE.md",
      category: "memory",
      mergeStrategy: "managed_block",
      content: "STARTUP-GHOST-BLOCK",
    }],
    files: [{ path: "onboarding.md", absolutePath: "/tmp/never-read/onboarding.md", required: false }],
    actions: [{ type: "send_text", text: "STARTUP-GHOST-PROMPT", idempotent: true }],
  };

  it("R6: exact resume with saved startup context delivers ZERO replay by default (launch leg intact)", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSessions(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ]);
    const claude = mockClaudeResume();
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator({ claude }).restore(fixed.id, { adapters: { "claude-code": adapter } });
    expect(result.ok).toBe(true);
    // The resume itself still happens — containment removes CONTENT, not the launch.
    expect(claude.resume).toHaveBeenCalledTimes(1);
    expect(resumeTokenArg(claude)).toBe("tok-active");
    // Zero content into the resumed history: no projection entries, no
    // startup files/actions reach the adapter without the recorded opt-in.
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries).toHaveLength(0); // base: the ghost block is in the plan
    const delivered = adapter.deliverStartup.mock.calls
      .flatMap((c) => JSON.stringify(c[0] ?? ""));
    expect(delivered.join("")).not.toContain("STARTUP-GHOST"); // base: delivered
  });

  it("R7: replay needs the explicit VERSIONED opt-in, recorded on the result, delivered exactly once", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSessions(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ]);
    const adapter = spyRuntimeAdapter();
    const orch = createOrchestrator({ claude: mockClaudeResume() });
    const result = await orch.restore(fixed.id, {
      adapters: { "claude-code": adapter },
      // The opt-in contract: explicit, versioned, recorded. Base RED: the
      // option does not exist and replay happens unconditionally.
      startupReplayOptIn: { version: 1 },
    } as never);
    expect(result.ok).toBe(true);
    // Content delivered EXACTLY once under the opt-in…
    const contentCalls = adapter.project.mock.calls
      .filter((c) => ((c[0]?.entries ?? []) as unknown[]).length > 0);
    expect(contentCalls).toHaveLength(1);
    // …and the versioned opt-in is RECORDED on the durable result (auditable).
    expect(JSON.stringify(result)).toContain('"startupReplayOptIn"');
    expect(JSON.stringify(result)).toContain('"version":1');
  });

  it("R8: fresh-primed (non-resume) launches keep their startup replay — containment is resume-scoped", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    // Single row with NO resume metadata: deliberate blank-slate launch.
    const data = JSON.parse(JSON.stringify(snap.data));
    data.sessions = data.sessions.map((s: Record<string, unknown>) =>
      s.nodeId === nodeId ? { ...s, resumeType: null, resumeToken: null } : s);
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
    const fixed = snapshotRepo.getSnapshot(snap.id)!;
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator().restore(fixed.id, { adapters: { "claude-code": adapter } });
    expect(result.ok).toBe(true);
    // Replay is PRESERVED on the deliberate fresh path (no over-containment):
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries.length).toBeGreaterThan(0);
  });
});
