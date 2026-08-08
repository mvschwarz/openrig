import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";

const STORE_MODULE = ["../src/domain", "enforcer-decision-store.js"].join("/");
const SESSION = "claude-seat@rig";

type DecisionStore = {
  create(input: Record<string, unknown>): Record<string, unknown>;
  list(input?: Record<string, unknown>): Array<Record<string, unknown>>;
};

type DecisionStoreConstructor = new (
  db: Database.Database,
  opts: { now: () => Date; authorizeTtlMinutes: () => number },
) => DecisionStore;

async function loadDecisionStore(): Promise<DecisionStoreConstructor> {
  let mod: { EnforcerDecisionStore?: DecisionStoreConstructor } | null = null;
  try {
    mod = await import(/* @vite-ignore */ STORE_MODULE);
  } catch {
    // Assertion below keeps the RED feature-shaped instead of surfacing a loader error.
  }
  expect(mod, "durable enforcer decision store module must exist").not.toBeNull();
  expect(mod?.EnforcerDecisionStore).toBeTypeOf("function");
  return mod!.EnforcerDecisionStore!;
}

describe("W4 ContextMonitor enforcement observation", () => {
  let db: Database.Database;
  let stateDir: string;
  let contextStore: ContextUsageStore;
  let monitor: ContextMonitor | undefined;
  let generationUuid: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    stateDir = join(tmpdir(), `w4-context-monitor-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(stateDir, "context"), { recursive: true });
    contextStore = new ContextUsageStore(db, { stateDir, codexHomeDir: stateDir });

    const rigs = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const rig = rigs.createRig("rig");
    const node = rigs.addNode(rig.id, "claude.seat", { runtime: "claude-code" });
    const session = sessions.registerSession(node.id, SESSION);
    generationUuid = sessions.currentOccupantGenerationForSession(SESSION)!;
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    writeFileSync(
      join(stateDir, "context", `${SESSION}.json`),
      JSON.stringify({
        session_name: SESSION,
        sampled_at: "2026-08-08T18:00:30.000Z",
        context_window: {
          context_window_size: 200_000,
          used_percentage: 90,
          remaining_percentage: 10,
          total_input_tokens: 170_000,
          total_output_tokens: 10_000,
        },
      }),
    );
  });

  afterEach(() => {
    monitor?.stop();
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a real poll honors a hold with unknown live generation and exposes its observation", async () => {
    const EnforcerDecisionStore = await loadDecisionStore();
    const decisions = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:30.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    const hold = decisions.create({
      enforcerKind: "claude_compaction",
      sessionName: SESSION,
      generationUuid,
      direction: "hold",
      reason: "finish the current atomic action",
      actorSession: "orch-lead@rig",
      identityProvenance: "transport:v1",
    });
    const send = vi.fn(async () => ({ ok: true as const }));
    const enforcer = new ClaudeCompactionEnforcer(
      {
        resolveClaudeCompactionPolicy: () => ({
          enabled: true,
          thresholdPercent: 80,
          preCompactInstruction: "prepare",
          compactInstruction: "",
          messageInline: "",
          messageFilePath: "",
          postRestoreAuditInstruction: "audit",
          authorizeTtlMinutes: 15,
        }),
      } as never,
      { send } as unknown as SessionTransport,
      {
        resolveOccupantGeneration: () => null,
        decisionStore: decisions,
      } as never,
    );
    monitor = new ContextMonitor(
      db,
      contextStore,
      { ensureContextCollector: vi.fn() },
      enforcer,
    );

    await monitor.pollOnce();

    expect(send).not.toHaveBeenCalled();
    expect(decisions.list({ sessionName: SESSION })).toContainEqual(expect.objectContaining({
      decisionId: hold["decisionId"],
      lastObservedAt: "2026-08-08T18:00:30.000Z",
      lastObservedOutcome: "human_hold",
    }));
  });
});
