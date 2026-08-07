import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error("command not found");
  }) as unknown as ExecFn;
}

describe("RuntimeVerifier", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
  });

  // T1: tmux present + version parsed -> verified
  it("tmux present with parseable version -> verified", async () => {
    const exec = createMockExec({ "tmux -V": "tmux 3.4" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("3.4");
    expect(result.runtime).toBe("tmux");
  });

  // T2: tmux missing -> not_found
  it("tmux missing -> not_found", async () => {
    const exec = createMockExec({});
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    expect(result.status).toBe("not_found");
    expect(result.error).toBeTruthy();
  });

  // T3: cmux capabilities --json succeeds -> verified with capabilities_json
  it("cmux capabilities succeeds -> verified with capabilities_json as valid JSON string", async () => {
    const capsOutput = JSON.stringify({ workspaces: true, surfaces: true, notifications: false });
    const exec = createMockExec({ "cmux capabilities --json": capsOutput });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCmux();

    expect(result.status).toBe("verified");
    expect(result.runtime).toBe("cmux");
    // capabilities_json is a valid JSON string
    expect(result.capabilitiesJson).toBeTruthy();
    const parsed = JSON.parse(result.capabilitiesJson!);
    expect(parsed.workspaces).toBe(true);
    expect(parsed.surfaces).toBe(true);
  });

  // T4: cmux absent -> degraded
  it("cmux absent -> degraded (not blocking)", async () => {
    const exec = createMockExec({});
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCmux();

    expect(result.status).toBe("degraded");
    expect(result.runtime).toBe("cmux");
  });

  // T5: claude --version succeeds -> verified
  it("claude --version succeeds -> verified", async () => {
    const exec = createMockExec({ "claude --version": "claude 1.0.23" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyClaude();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("1.0.23");
    expect(result.runtime).toBe("claude-code");
  });

  // T6: codex --version succeeds -> verified
  it("codex --version succeeds -> verified", async () => {
    const exec = createMockExec({ "codex --version": "codex 0.5.1" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCodex();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("0.5.1");
    expect(result.runtime).toBe("codex");
  });

  // T7: verifyTmux auto-persists to DB
  it("verification auto-persists to runtime_verifications table", async () => {
    const exec = createMockExec({ "tmux -V": "tmux 3.4" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .get("tmux") as { id: string; runtime: string; version: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.runtime).toBe("tmux");
    expect(row!.version).toBe("3.4");
    expect(row!.status).toBe("verified");
    expect(row!.id).toBe(result.id);
  });

  // T8: Re-verify tmux twice -> only 1 row
  it("re-verification updates existing record (1 row per runtime)", async () => {
    const exec = createMockExec({ "tmux -V": "tmux 3.4" });
    const verifier = new RuntimeVerifier({ exec, db });

    await verifier.verifyTmux();
    await verifier.verifyTmux();

    const rows = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .all("tmux") as Array<{ id: string }>;

    expect(rows).toHaveLength(1);
  });

  // T9: claude --version fails, --help succeeds -> verified, version=null
  it("claude --version fails but --help succeeds -> verified with null version", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "claude --version") throw new Error("not found");
      if (cmd === "claude --help") return "Claude Code CLI\nUsage: claude [options]";
      throw new Error("unknown command");
    }) as unknown as ExecFn;
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyClaude();

    expect(result.status).toBe("verified");
    expect(result.version).toBeNull();
    expect(result.runtime).toBe("claude-code");
  });

  // T10: Persisted runtime field is 'claude-code' (canonical name)
  it("persisted runtime field matches canonical name 'claude-code'", async () => {
    const exec = createMockExec({ "claude --version": "claude 1.0.0" });
    const verifier = new RuntimeVerifier({ exec, db });

    await verifier.verifyClaude();

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .get("claude-code") as { runtime: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.runtime).toBe("claude-code");
  });

  // T11: codex --version fails, --help succeeds -> verified, version=null
  it("codex --version fails but --help succeeds -> verified with null version", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "codex --version") throw new Error("not found");
      if (cmd === "codex --help") return "Codex CLI\nUsage: codex [options]";
      throw new Error("unknown command");
    }) as unknown as ExecFn;
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCodex();

    expect(result.status).toBe("verified");
    expect(result.version).toBeNull();
    expect(result.runtime).toBe("codex");
  });

  // T12: tmux -V garbage output -> status='error'
  it("tmux -V with unparseable output -> error status", async () => {
    const exec = createMockExec({ "tmux -V": "some garbage with no version" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    expect(result.status).toBe("error");
    expect(result.error).toContain("unparseable");
    expect(result.version).toBeNull();
  });

  // T13: cmux invalid JSON output -> status='error'
  it("cmux capabilities returns invalid JSON -> error status", async () => {
    const exec = createMockExec({ "cmux capabilities --json": "not valid json {{{" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCmux();

    expect(result.status).toBe("error");
    expect(result.error).toContain("invalid");
    expect(result.capabilitiesJson).toBeNull();
  });

  // T14: verifyAll preserves input order + persists canonical names
  it("verifyAll preserves input order and persists canonical runtime names", async () => {
    const exec = createMockExec({
      "codex --version": "codex 0.5.0",
      "claude --version": "claude 1.2.3",
      "tmux -V": "tmux 3.4",
    });
    const verifier = new RuntimeVerifier({ exec, db });

    const results = await verifier.verifyAll(["codex", "claude-code", "tmux"]);

    // Input order preserved
    expect(results).toHaveLength(3);
    expect(results[0]!.runtime).toBe("codex");
    expect(results[1]!.runtime).toBe("claude-code");
    expect(results[2]!.runtime).toBe("tmux");

    // All persisted with canonical names
    const rows = db.prepare("SELECT runtime FROM runtime_verifications ORDER BY runtime")
      .all() as Array<{ runtime: string }>;
    const names = rows.map((r) => r.runtime).sort();
    expect(names).toEqual(["claude-code", "codex", "tmux"]);
  });
});
