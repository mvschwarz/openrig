import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { packageCommand } from "../src/commands/package.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-24T00:00:00Z" };
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(runningState(port));
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

function stoppedDeps(): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false) }),
    clientFactory: vi.fn() as unknown as StatusDeps["clientFactory"],
  };
}

// Captured request bodies for assertion
let capturedBodies: Record<string, unknown>[] = [];

function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    // healthz
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Collect body for POST requests
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body); } catch { /* empty */ }
        capturedBodies.push(parsed);
        handleRoute(url.pathname, parsed, res);
      });
      return;
    }

    // GET routes
    if (req.method === "GET") {
      handleRoute(url.pathname, {}, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  function handleRoute(pathname: string, body: Record<string, unknown>, res: http.ServerResponse) {
    // POST /api/packages/validate
    if (pathname === "/api/packages/validate") {
      const sourceRef = body["sourceRef"] as string ?? "";
      if (sourceRef.includes("invalid")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: false, errors: ["name is required", "version is required"] }));
        return;
      }
      if (sourceRef.includes("missing")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid: false, error: "No package.yaml found at /missing/package.yaml" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        valid: true,
        manifest: {
          name: "test-pkg",
          version: "1.0.0",
          summary: "A test package",
          runtimes: ["claude-code"],
          exportCounts: { skills: 2, guidance: 1, agents: 0, hooks: 1, mcp: 0 },
        },
      }));
      return;
    }

    // POST /api/packages/plan
    if (pathname === "/api/packages/plan") {
      const sourceRef = body["sourceRef"] as string ?? "";
      if (sourceRef.includes("conflict")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          packageName: "conflict-pkg",
          packageVersion: "1.0.0",
          entries: [
            { exportType: "skill", exportName: "helper", classification: "safe_projection", targetPath: "/repo/.claude/skills/helper/SKILL.md", deferred: false, conflict: { existingPath: "/repo/.claude/skills/helper/SKILL.md", reason: "Skill 'helper' already exists at target" } },
          ],
          actionable: 0,
          deferred: 0,
          conflicts: 1,
          noOps: 0,
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        packageName: "test-pkg",
        packageVersion: "1.0.0",
        entries: [
          { exportType: "skill", exportName: "helper", classification: "safe_projection", targetPath: "/repo/.claude/skills/helper/SKILL.md", deferred: false },
          { exportType: "hook", exportName: "pre-commit", classification: "config_mutation", targetPath: "", deferred: true, deferReason: "Deferred to Phase 5" },
        ],
        actionable: 1,
        deferred: 1,
        conflicts: 0,
        noOps: 0,
      }));
      return;
    }

    // POST /api/packages/install
    if (pathname === "/api/packages/install") {
      const sourceRef = body["sourceRef"] as string ?? "";
      if (sourceRef.includes("conflict")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Unresolved conflicts",
          code: "conflict_blocked",
          conflicts: [{ existingPath: "/repo/.claude/skills/helper/SKILL.md", reason: "Skill 'helper' already exists" }],
        }));
        return;
      }
      if (sourceRef.includes("apply-error")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Disk full", code: "apply_error" }));
        return;
      }
      if (sourceRef.includes("verify-fail")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Post-apply verification failed",
          code: "verification_failed",
          installId: "inst-123",
          verification: { passed: false, entries: [] },
        }));
        return;
      }
      if (sourceRef.includes("policy-reject")) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "No entries approved by policy",
          code: "policy_rejected",
          rejected: [{ entry: { exportType: "guidance", exportName: "rules" }, reason: "managed_merge requires allowMerge flag" }],
        }));
        return;
      }
      if (sourceRef.includes("merge")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          installId: "inst-merge-1",
          packageId: "pkg-1",
          packageName: "merge-pkg",
          applied: [
            { id: "j1", installId: "inst-merge-1", seq: 1, exportType: "guidance", action: "merge_block", classification: "managed_merge", targetPath: "/repo/CLAUDE.md", backupPath: null, beforeHash: null, afterHash: "abc", status: "applied", createdAt: "2026-03-25" },
          ],
          deferred: [],
          conflicts: [],
          verification: { passed: true },
        }));
        return;
      }
      // Default: clean install with applied + deferred
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        installId: "inst-1",
        packageId: "pkg-1",
        packageName: "test-pkg",
        applied: [
          { id: "j1", installId: "inst-1", seq: 1, exportType: "skill", action: "copy", classification: "safe_projection", targetPath: "/repo/.claude/skills/helper/SKILL.md", backupPath: null, beforeHash: null, afterHash: "abc", status: "applied", createdAt: "2026-03-25" },
        ],
        deferred: [
          { exportType: "hook", exportName: "pre-commit", deferReason: "Deferred to Phase 5" },
          { exportType: "requirement", exportName: "jq", deferReason: "CLI tool requires external install" },
        ],
        conflicts: [],
        verification: { passed: true },
      }));
      return;
    }

    // POST /api/packages/:installId/rollback
    const rollbackMatch = pathname.match(/^\/api\/packages\/([^/]+)\/rollback$/);
    if (rollbackMatch) {
      const installId = rollbackMatch[1];
      if (installId === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Install not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ installId, restored: ["/repo/CLAUDE.md"], deleted: ["/repo/.claude/skills/helper/SKILL.md"] }));
      return;
    }

    // GET /api/packages
    if (pathname === "/api/packages") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "pkg-1", name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: "/packages/test", manifestHash: "abc123", summary: "A test package", createdAt: "2026-03-25 10:00:00" },
        { id: "pkg-2", name: "utils", version: "2.1.0", sourceKind: "local_path", sourceRef: "/packages/utils", manifestHash: "def456", summary: "Utilities", createdAt: "2026-03-25 11:00:00" },
      ]));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  return {
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    listen: () => new Promise<number>((r) => {
      server.listen(0, () => {
        const addr = server.address();
        r(typeof addr === "object" && addr ? addr.port : 0);
      });
    }),
  };
}

describe("rigged package", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function makeProgram(deps?: StatusDeps) {
    const program = new Command();
    program.addCommand(packageCommand(deps ?? runningDeps(port)));
    return program;
  }

  // Test 1: validate valid → prints name + version + export counts
  it("validate valid: prints manifest summary", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "validate", "/valid/path"]));
    const output = logs.join("\n");
    expect(output).toContain("test-pkg");
    expect(output).toContain("1.0.0");
    expect(output).toContain("skills: 2");
    expect(output).toContain("guidance: 1");
  });

  // Test 2: validate invalid manifest → errors[] + exitCode 1
  it("validate invalid manifest: prints errors, exitCode 1", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "validate", "/invalid/path"]));
    const output = logs.join("\n");
    expect(output).toContain("name is required");
    expect(output).toContain("version is required");
    expect(exitCode).toBe(1);
  });

  // Test 3: validate missing package.yaml → error + exitCode 1
  it("validate missing: prints error, exitCode 1", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "validate", "/missing/path"]));
    const output = logs.join("\n");
    expect(output).toContain("No package.yaml found");
    expect(exitCode).toBe(1);
  });

  // Test 4: plan clean → classified entries table
  it("plan clean: prints classified entries", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "plan", "/valid/path", "--target", "/repo"]));
    const output = logs.join("\n");
    expect(output).toContain("test-pkg");
    expect(output).toContain("helper");
    expect(output).toContain("safe_projection");
    expect(output).toContain("Actionable: 1");
    expect(output).toContain("Deferred: 1");
  });

  // Test 5: plan with conflicts → conflict info
  it("plan with conflicts: prints conflict info", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "plan", "/conflict/path", "--target", "/repo"]));
    const output = logs.join("\n");
    expect(output).toContain("helper");
    expect(output).toContain("already exists");
    expect(output).toContain("Conflicts: 1");
  });

  // Test 6: install clean → applied + deferred items
  it("install clean: prints applied entries + deferred items", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "install", "/valid/path", "--target", "/repo"]));
    const output = logs.join("\n");
    // Applied — journal entries have targetPath, not exportName
    expect(output).toContain("skill");
    expect(output).toContain("/repo/.claude/skills/helper/SKILL.md");
    expect(output).toContain("inst-1");
    // Deferred
    expect(output).toContain("pre-commit");
    expect(output).toContain("Deferred to Phase 5");
    expect(output).toContain("jq");
    expect(output).toContain("external install");
  });

  // Test 7: install --allow-merge → merged guidance
  it("install --allow-merge: prints merged guidance entries", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "install", "/merge/path", "--target", "/repo", "--allow-merge"]));
    const output = logs.join("\n");
    // Journal entries: exportType + action + targetPath (no exportName)
    expect(output).toContain("guidance");
    expect(output).toContain("merge_block");
    expect(output).toContain("/repo/CLAUDE.md");
    expect(output).toContain("inst-merge-1");
  });

  // Test 8: install conflicts (409) → exitCode 1
  it("install conflicts: prints conflicts, exitCode 1", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "install", "/conflict/path", "--target", "/repo"]));
    const output = logs.join("\n");
    expect(output).toContain("conflict");
    expect(output).toContain("already exists");
    expect(exitCode).toBe(1);
  });

  // Test 9: install apply_error (500) → exitCode 2
  it("install apply_error: exitCode 2", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "install", "/apply-error/path", "--target", "/repo"]));
    const output = logs.join("\n");
    expect(output).toContain("Disk full");
    expect(exitCode).toBe(2);
  });

  // Test 10: install verification_failed (500) → exitCode 2
  it("install verification_failed: exitCode 2", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "install", "/verify-fail/path", "--target", "/repo"]));
    const output = logs.join("\n");
    expect(output).toMatch(/verification failed/i);
    expect(exitCode).toBe(2);
  });

  // Test 11: install policy_rejected (422) → exitCode 1
  it("install policy_rejected: prints rejected, exitCode 1", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "install", "/policy-reject/path", "--target", "/repo"]));
    const output = logs.join("\n");
    expect(output).toContain("Policy rejected");
    expect(output).toContain("allowMerge");
    expect(exitCode).toBe(1);
  });

  // Test 12: rollback → prints restored/deleted
  it("rollback: prints restored and deleted", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "rollback", "inst-1"]));
    const output = logs.join("\n");
    expect(output).toContain("inst-1");
    expect(output).toContain("1 restored");
    expect(output).toContain("1 deleted");
  });

  // Test 13: rollback not found (404) → exitCode 1
  it("rollback not found: exitCode 1", async () => {
    const { logs, exitCode } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "rollback", "missing"]));
    const output = logs.join("\n");
    expect(output).toMatch(/not found/i);
    expect(exitCode).toBe(1);
  });

  // Test 14: list → formatted table
  it("list: formatted table", async () => {
    const { logs } = await captureLogs(() => makeProgram().parseAsync(["node", "rigged", "package", "list"]));
    const output = logs.join("\n");
    expect(output).toContain("test-pkg");
    expect(output).toContain("1.0.0");
    expect(output).toContain("utils");
    expect(output).toContain("2.1.0");
  });

  // Test 15: daemon stopped → 'not running' + no HTTP
  it("daemon stopped: prints 'not running', no HTTP", async () => {
    const deps = stoppedDeps();
    const { logs } = await captureLogs(() => {
      const program = new Command();
      program.addCommand(packageCommand(deps));
      return program.parseAsync(["node", "rigged", "package", "validate", "/any"]);
    });
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  // Test 16: request-body assertion — install flags → correct JSON body
  it("install sends correct request body fields", async () => {
    capturedBodies = [];
    await captureLogs(() => makeProgram().parseAsync([
      "node", "rigged", "package", "install", "/valid/path",
      "--target", "/my-repo",
      "--runtime", "codex",
      "--role", "worker",
      "--allow-merge",
    ]));

    // Find the install request body (last POST to /api/packages/install)
    const installBody = capturedBodies[capturedBodies.length - 1];
    expect(installBody).toBeTruthy();
    expect(installBody!["sourceRef"]).toBe("/valid/path");
    expect(installBody!["targetRoot"]).toBe("/my-repo");
    expect(installBody!["runtime"]).toBe("codex");
    expect(installBody!["roleName"]).toBe("worker");
    expect(installBody!["allowMerge"]).toBe(true);
  });
});
