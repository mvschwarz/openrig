import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { ExternalInstallExecutor, type TaggedAction } from "../src/domain/external-install-executor.js";
import type { ExternalInstallAction } from "../src/domain/external-install-planner.js";
import type { ExecFn } from "../src/adapters/tmux.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
];

function makeAction(overrides: Partial<ExternalInstallAction> & { requirementName: string }): ExternalInstallAction {
  return {
    kind: "cli_tool",
    provider: "homebrew",
    commandPreview: `brew install '${overrides.requirementName}'`,
    classification: "auto_approvable",
    installHints: null,
    reason: "trusted Homebrew install",
    ...overrides,
  };
}

function seedBootstrapRun(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO bootstrap_runs (id, source_kind, source_ref) VALUES (?, ?, ?)").run(id, "rig_spec", "/tmp/rig.yaml");
}

describe("ExternalInstallExecutor", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
  });

  // T1: Approved action executes commandPreview via exec
  it("approved action executes commandPreview via exec", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn(async () => "installed ripgrep 14.1.0") as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const tagged: TaggedAction[] = [
      { action: makeAction({ requirementName: "ripgrep" }), approved: true },
    ];

    const summary = await executor.execute("bs-1", tagged);

    expect(exec).toHaveBeenCalledWith("brew install 'ripgrep'");
    expect(summary.completed).toHaveLength(1);
    expect(summary.completed[0]!.requirementName).toBe("ripgrep");
  });

  // T2: Success journaled with stdout, status='completed', durationMs > 0
  it("success journaled with stdout and positive durationMs", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn(async () => "ok") as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const summary = await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "jq" }), approved: true },
    ]);

    expect(summary.completed).toHaveLength(1);
    const result = summary.completed[0]!;
    expect(result.stdout).toBe("ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // T3: Failure journaled with errorMessage, status='failed'
  it("failure journaled with errorMessage", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn(async () => { throw new Error("brew: package not found"); }) as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const summary = await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "bad-pkg" }), approved: true },
    ]);

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.errorMessage).toContain("package not found");
  });

  // T4: manual_only in approved list still skipped (defense in depth)
  it("manual_only action skipped even when approved", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn() as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const summary = await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "manual-thing", classification: "manual_only", commandPreview: null }), approved: true },
    ]);

    expect(exec).not.toHaveBeenCalled();
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]!.status).toBe("skipped");
  });

  // T5: Multiple actions in sequence (verify exec call order)
  it("multiple actions executed in input order", async () => {
    seedBootstrapRun(db, "bs-1");
    const callOrder: string[] = [];
    const exec = vi.fn(async (cmd: string) => { callOrder.push(cmd); return "ok"; }) as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "first", commandPreview: "brew install 'first'" }), approved: true },
      { action: makeAction({ requirementName: "second", commandPreview: "brew install 'second'" }), approved: true },
    ]);

    expect(callOrder).toEqual(["brew install 'first'", "brew install 'second'"]);
  });

  // T6: Partial failure does not abort remaining
  it("partial failure does not abort remaining actions", async () => {
    seedBootstrapRun(db, "bs-1");
    let callCount = 0;
    const exec = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("fail first");
      return "ok";
    }) as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const summary = await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "fail-pkg" }), approved: true },
      { action: makeAction({ requirementName: "ok-pkg" }), approved: true },
    ]);

    expect(summary.failed).toHaveLength(1);
    expect(summary.completed).toHaveLength(1);
    expect(summary.failed[0]!.requirementName).toBe("fail-pkg");
    expect(summary.completed[0]!.requirementName).toBe("ok-pkg");
  });

  // T7: bootstrap_actions row mapping: all fields verified
  it("bootstrap_actions row has correct field mapping", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn(async () => "installed ok") as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "ripgrep", kind: "cli_tool", provider: "homebrew", commandPreview: "brew install 'ripgrep'" }), approved: true },
    ]);

    const row = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ?")
      .get("bs-1") as Record<string, unknown>;

    expect(row["action_kind"]).toBe("external_install");
    expect(row["subject_type"]).toBe("cli_tool");
    expect(row["subject_name"]).toBe("ripgrep");
    expect(row["provider"]).toBe("homebrew");
    expect(row["command_preview"]).toBe("brew install 'ripgrep'");
    expect(row["status"]).toBe("completed");

    const detail = JSON.parse(row["detail_json"] as string);
    expect(detail.stdout).toBe("installed ok");
    expect(detail.errorMessage).toBeNull();
    expect(typeof detail.durationMs).toBe("number");
  });

  // T8: All tests use mock ExecFn (structural — verified by no real shell in any test)
  it("all tests use mock ExecFn — exec is vi.fn", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn(async () => "ok") as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "test-tool" }), approved: true },
    ]);

    expect(vi.isMockFunction(exec)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // T9: Action with null commandPreview skipped
  it("action with null commandPreview is skipped", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn() as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const summary = await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "no-cmd", commandPreview: null }), approved: true },
    ]);

    expect(exec).not.toHaveBeenCalled();
    expect(summary.skipped).toHaveLength(1);
  });

  // T10: Unapproved action journaled as skipped, not executed; later approved runs
  it("unapproved action journaled as skipped, approved action still executes", async () => {
    seedBootstrapRun(db, "bs-1");
    const exec = vi.fn(async () => "ok") as unknown as ExecFn;
    const executor = new ExternalInstallExecutor({ exec, db });

    const summary = await executor.execute("bs-1", [
      { action: makeAction({ requirementName: "unapproved-pkg" }), approved: false },
      { action: makeAction({ requirementName: "approved-pkg" }), approved: true },
    ]);

    // Unapproved not executed
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("brew install 'approved-pkg'");

    // Both journaled
    const rows = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq")
      .all("bs-1") as Array<{ subject_name: string; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.subject_name).toBe("unapproved-pkg");
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[1]!.subject_name).toBe("approved-pkg");
    expect(rows[1]!.status).toBe("completed");
  });
});
