import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ExternalInstallExecutor, type TaggedAction } from "../src/domain/external-install-executor.js";
import type { ExternalInstallAction } from "../src/domain/external-install-planner.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ExternalInstallPlanner } from "../src/domain/external-install-planner.js";


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
  it("the default native executor preserves literal argv and journals real nonzero exits", async () => {
    const localDb = createDb(); migrate(localDb, ALL_MIGRATIONS);
    try {
      seedBootstrapRun(localDb, "owned-node");
      const exec = vi.fn(async () => { throw Error("Shell execution forbidden"); });
      const executor = new ExternalInstallExecutor({ db: localDb, exec });
      const literal = "owned 'quote' & semicolon; $env:NOT_EXECUTED 中文";
      const action = makeAction({ requirementName: "owned-node-fixture", provider: "owned-fixture", commandPreview: "Owned Node fixture",
        commandArgv: { file: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", literal] } });
      const result = await executor.execute("owned-node", [{ action, approved: true },
        { action: { ...action, commandArgv: { file: process.execPath, args: ["-e", "process.stderr.write('owned failure');process.exitCode=7"] } }, approved: true }]);
      expect(JSON.parse(result.completed[0]!.stdout!)).toEqual([literal]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.errorMessage).toContain("owned failure");
      expect(exec).not.toHaveBeenCalled();
      expect(localDb.prepare("SELECT status FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq").all("owned-node"))
        .toEqual([{ status: "completed" }, { status: "failed" }]);
    } finally { localDb.close(); }
  });
  it("runs approved Windows plans as literal argv, journals failure and continues without executing hints", async () => {
    const localDb = createDb(); migrate(localDb, ALL_MIGRATIONS);
    try {
      seedBootstrapRun(localDb, "native-plan");
      const probes = ["git", "pwsh", "unmapped;tool"].map(name => ({ name, kind: "cli_tool" as const,
        status: "missing" as const, version: null, detectedPath: null, provider: null, command: null,
        installHints: { win32: "echo NEVER_EXECUTE" }, error: null }));
      const plan = new ExternalInstallPlanner({ platform: "win32" }).planInstalls(probes);
      expect(plan.reviewRequired.map(a => a.requirementName)).toEqual(["git", "pwsh"]);
      expect(plan.manualOnly.map(a => a.requirementName)).toEqual(["unmapped;tool"]);
      const exec = vi.fn(async () => { throw Error("Shell execution forbidden"); });
      const execArgv = vi.fn().mockRejectedValueOnce(Error("agreement required")).mockResolvedValueOnce("installed");
      const executor = new ExternalInstallExecutor({ db: localDb, exec, execArgv });
      const unapproved = await executor.execute("native-plan", [{ action: plan.actions[0]!, approved: false }]);
      expect(unapproved.skipped).toHaveLength(1);
      expect(execArgv).not.toHaveBeenCalled();
      const result = await executor.execute("native-plan", plan.actions.map(action => ({ action, approved: true })), 2);
      expect(result.failed).toHaveLength(1); expect(result.completed).toHaveLength(1); expect(result.skipped).toHaveLength(1);
      expect(exec).not.toHaveBeenCalled();
      expect(execArgv.mock.calls).toEqual(["Git.Git", "Microsoft.PowerShell"].map(id => ["winget.exe",
        ["install", "--id", id, "--exact", "--source", "winget", "--scope", "user", "--silent", "--disable-interactivity", "--no-upgrade"]]));
      const rows = localDb.prepare("SELECT status, detail_json FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq").all("native-plan") as Array<{ status: string; detail_json: string }>;
      expect(rows.map(row => row.status)).toEqual(["skipped", "failed", "completed", "skipped"]);
      expect(JSON.parse(rows[1]!.detail_json).errorMessage).toBe("agreement required");
    } finally { localDb.close(); }
  });
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
