import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import type { RigSpec } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, nodeSpecFieldsSchema]);
  return db;
}

function mockTmux(sessionExists: Record<string, boolean> = {}): TmuxAdapter {
  return {
    hasSession: vi.fn(async (name: string) => sessionExists[name] ?? false),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

function validSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    schemaVersion: 1,
    name: "r99",
    version: "1.0.0",
    nodes: [
      { id: "worker", runtime: "claude-code", cwd: "/" },
    ],
    edges: [],
    ...overrides,
  };
}

describe("RigSpecPreflight", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPreflight(opts?: { tmux?: TmuxAdapter; exec?: ExecFn; cmuxExec?: ExecFn }) {
    return new RigSpecPreflight({
      rigRepo,
      tmuxAdapter: opts?.tmux ?? mockTmux(),
      exec: opts?.exec ?? (async () => ""),
      cmuxExec: opts?.cmuxExec ?? (async () => ""),
    });
  }

  it("all checks pass -> { ready: true, warnings: [], errors: [] }", async () => {
    const pf = createPreflight();
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("rig name collision -> error", async () => {
    rigRepo.createRig("r99"); // collision
    const pf = createPreflight();
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("r99"))).toBe(true);
  });

  it("tmux session name collision -> error", async () => {
    const tmux = mockTmux({ "r99-worker": true });
    const pf = createPreflight({ tmux });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("r99-worker"))).toBe(true);
  });

  it("derived session name invalid -> error", async () => {
    // Spec name that produces invalid session name
    const spec = validSpec({ name: "badname" });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("session name"))).toBe(true);
  });

  it("node cwd doesn't exist -> error", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/nonexistent/path/xyz" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("/nonexistent/path/xyz"))).toBe(true);
  });

  it("claude-code probes 'claude --version' (exact command)", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    await pf.check(validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
    }));
    const claudeCall = exec.mock.calls.find((c: unknown[]) => (c[0] as string).includes("claude"));
    expect(claudeCall).toBeDefined();
    expect(claudeCall![0]).toBe("claude --version");
  });

  it("codex probes 'codex --version' (exact command)", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    await pf.check(validSpec({
      nodes: [{ id: "worker", runtime: "codex", cwd: "/" }],
    }));
    const codexCall = exec.mock.calls.find((c: unknown[]) => (c[0] as string).includes("codex"));
    expect(codexCall).toBeDefined();
    expect(codexCall![0]).toBe("codex --version");
  });

  it("runtime not available -> error", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const pf = createPreflight({ exec });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("claude-code"))).toBe(true);
  });

  it("multiple errors reported (2 bad cwds -> 2 errors)", async () => {
    const spec = validSpec({
      nodes: [
        { id: "worker-a", runtime: "claude-code", cwd: "/bad/path/a" },
        { id: "worker-b", runtime: "claude-code", cwd: "/bad/path/b" },
      ],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.filter((e) => e.includes("/bad/path")).length).toBe(2);
  });

  it("cmux unavailable + spec has surfaceHint -> warning", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", surfaceHint: "tab:main" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.some((w) => w.toLowerCase().includes("cmux"))).toBe(true);
  });

  it("cmux unavailable + spec has NO layout hints -> no warning", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.filter((w) => w.toLowerCase().includes("cmux"))).toHaveLength(0);
  });

  it("node with no cwd -> no cwd check (passes)", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code" }], // no cwd
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.filter((e) => e.includes("cwd"))).toHaveLength(0);
  });

  it("tmux session name collision detected (derived name exists)", async () => {
    const tmux = mockTmux({ "r99-worker": true });
    const pf = createPreflight({ tmux });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("tmux") || e.includes("session"))).toBe(true);
  });

  it("spec with workspace hint + cmux unavailable -> warning", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", workspace: "review" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.some((w) => w.toLowerCase().includes("cmux"))).toBe(true);
  });

  it("error + warning coexist: bad cwd + cmux unavailable with layout hint", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/nonexistent/bad", surfaceHint: "tab:x" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("cmux availability probed via 'cmux capabilities --json' (exact command)", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockResolvedValue("{}");
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", surfaceHint: "tab:x" }],
    });
    const pf = createPreflight({ cmuxExec });
    await pf.check(spec);
    expect(cmuxExec).toHaveBeenCalledWith("cmux capabilities --json");
  });
});
