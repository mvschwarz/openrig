// rig plugin CLI commands (slice 3.4) — list/show/used-by/validate.
//
// Per IMPL-PRD §4 + DESIGN.md §6 (CLI minimalism: read-only inspection only).
// Consumes plugin-discovery-service from slice 3.3 via HTTP routes
// (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by).
// `validate` is local file inspection — reuses agent-manifest's
// validatePluginResources logic + skill frontmatter checks.
//
// All commands ship --json output for agent consumption per
// banked building-agent-software + IMPL-PRD §4.4 HG-4.5.
//
// Test pattern follows context-pack.test.ts (slice 3.4 mirror) — in-memory
// http.createServer daemon mock + Commander.parseAsync via captureLogs.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { pluginCommand } from "../src/commands/plugin.js";
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

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errLogs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander.exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

// Fixtures mirror the slice 3.3 PluginDiscoveryService wire shape verbatim
// (packages/daemon/src/domain/plugin-discovery-service.ts L41-132). Any drift
// from that source means the daemon contract changed and these fixtures
// must update in lockstep with the CLI wire types in plugin.ts.

const FIXTURE_PLUGIN_ENTRY = {
  id: "openrig-core",
  name: "openrig-core",
  version: "0.1.0",
  description: "OpenRig canonical skills and hooks",
  source: "vendored" as const,
  sourceLabel: "vendored:openrig-core",
  runtimes: ["claude", "codex"] as const,
  path: "/home/op/.openrig/plugins/openrig-core",
  lastSeenAt: "2026-05-11T05:00:00Z",
};

const FIXTURE_PLUGIN_DETAIL = {
  entry: FIXTURE_PLUGIN_ENTRY,
  claudeManifest: {
    raw: { name: "openrig-core", version: "0.1.0", description: "OpenRig canonical skills and hooks", license: "Apache-2.0", repository: "github:mvschwarz/openrig-plugins" },
    name: "openrig-core",
    version: "0.1.0",
    description: "OpenRig canonical skills and hooks",
    homepage: null,
    repository: "github:mvschwarz/openrig-plugins",
    license: "Apache-2.0",
  },
  codexManifest: {
    raw: { name: "openrig-core", version: "0.1.0", description: "OpenRig canonical skills and hooks", license: "Apache-2.0" },
    name: "openrig-core",
    version: "0.1.0",
    description: "OpenRig canonical skills and hooks",
    homepage: null,
    repository: null,
    license: "Apache-2.0",
  },
  skills: [
    { name: "openrig-user", relativePath: "skills/openrig-user" },
    { name: "openrig-architect", relativePath: "skills/openrig-architect" },
  ],
  hooks: [
    { runtime: "claude" as const, relativePath: "hooks/claude.json", events: ["SessionStart", "UserPromptSubmit", "Stop", "Notification"] },
    { runtime: "codex" as const, relativePath: "hooks/codex.json", events: ["SessionStart", "UserPromptSubmit", "Stop"] },
  ],
  mcpServers: [],
};

const FIXTURE_USED_BY = [
  {
    agentName: "advisor-lead",
    sourcePath: "/home/op/.openrig/specs/agents/advisor/lead/agent.yaml",
    profiles: ["default"],
  },
];

describe("rig plugin CLI (slice 3.4)", () => {
  let server: http.Server;
  let port: number;
  let lastQuery: Record<string, string | undefined>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      lastQuery = Object.fromEntries(url.searchParams.entries());

      if (url.pathname === "/api/plugins" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([FIXTURE_PLUGIN_ENTRY]));
        return;
      }
      if (url.pathname === "/api/plugins/openrig-core" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FIXTURE_PLUGIN_DETAIL));
        return;
      }
      if (url.pathname === "/api/plugins/openrig-core/used-by" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FIXTURE_USED_BY));
        return;
      }
      if (url.pathname === "/api/plugins/missing" && req.method === "GET") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "plugin_not_found" }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    lastQuery = {};
  });

  // ============================================================
  // rig plugin list (HG-4.1)
  // ============================================================

  describe("rig plugin list", () => {
    it("--json returns the plugin entries from /api/plugins", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      const { logs, exitCode } = await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "list", "--json"]);
      });

      expect(exitCode).toBeUndefined();
      const parsed = JSON.parse(logs.join("\n")) as Array<{ id: string }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.id).toBe("openrig-core");
    });

    it("default (table) output prints id + version + runtimes + source label + path (real PluginEntry fields)", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      const { logs, exitCode } = await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "list"]);
      });

      expect(exitCode).toBeUndefined();
      const out = logs.join("\n");
      expect(out).toContain("openrig-core");
      expect(out).toContain("0.1.0");
      expect(out).toContain("vendored:openrig-core");
      // Regression: real path field, not invented rootPath
      expect(out).toContain("/home/op/.openrig/plugins/openrig-core");
      // Regression: must NOT print invented count fields (they don't exist on PluginEntry)
      expect(out).not.toMatch(/\bskillCount\b/);
      expect(out).not.toMatch(/\bhookEventCount\b/);
      expect(out).not.toMatch(/\bmcpServerCount\b/);
    });

    it("--runtime claude passes runtime filter to the daemon route", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "list", "--runtime", "claude", "--json"]);
      });

      expect(lastQuery.runtime).toBe("claude");
    });

    it("--source vendored passes source filter to the daemon route", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "list", "--source", "vendored", "--json"]);
      });

      expect(lastQuery.source).toBe("vendored");
    });
  });

  // ============================================================
  // rig plugin show <id> (HG-4.2)
  // ============================================================

  describe("rig plugin show <id>", () => {
    it("--json returns the plugin detail from /api/plugins/:id", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      const { logs, exitCode } = await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "show", "openrig-core", "--json"]);
      });

      expect(exitCode).toBeUndefined();
      const parsed = JSON.parse(logs.join("\n")) as { entry: { id: string; path: string; lastSeenAt: string | null }; skills: unknown[]; hooks: unknown[] };
      expect(parsed.entry.id).toBe("openrig-core");
      expect(parsed.entry.path).toBe("/home/op/.openrig/plugins/openrig-core"); // real PluginEntry.path
      expect(parsed.skills).toHaveLength(2);
      expect(parsed.hooks).toHaveLength(2);
    });

    it("default (pretty) output uses REAL PluginDetail fields (name + relativePath + events array)", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      const { logs, exitCode } = await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "show", "openrig-core"]);
      });

      expect(exitCode).toBeUndefined();
      const out = logs.join("\n");

      // PluginEntry fields
      expect(out).toContain("openrig-core");
      expect(out).toContain("0.1.0");
      expect(out).toContain("/home/op/.openrig/plugins/openrig-core"); // entry.path
      expect(out).toContain("2026-05-11T05:00:00Z"); // entry.lastSeenAt

      // Manifests — real PluginManifestSummary fields
      expect(out).toMatch(/claude:/);
      expect(out).toMatch(/codex:/);
      expect(out).toContain("Apache-2.0");
      expect(out).toContain("github:mvschwarz/openrig-plugins");

      // Skills — uses skill.name + skill.relativePath (not invented id/path/description)
      expect(out).toContain("openrig-user");
      expect(out).toContain("openrig-architect");
      expect(out).toContain("skills/openrig-user");
      expect(out).toContain("skills/openrig-architect");

      // Hooks — uses runtime + events array (not invented eventCount alone) +
      // relativePath
      expect(out).toContain("hooks/claude.json");
      expect(out).toContain("hooks/codex.json");
      expect(out).toContain("SessionStart");
      expect(out).toContain("UserPromptSubmit");
      expect(out).toContain("Notification"); // Claude event count = 4, includes Notification
    });

    it("missing plugin id returns non-zero exit + error to stderr", async () => {
      const program = new Command();
      program.exitOverride();
      program.addCommand(pluginCommand(runningDeps(port)));

      const { errLogs, exitCode } = await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "plugin", "show", "missing"]);
      });

      expect(exitCode).toBe(1);
      expect(errLogs.join("\n")).toMatch(/not.*found|404|missing/i);
    });
  });
});
