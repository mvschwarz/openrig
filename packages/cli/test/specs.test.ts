import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { specsCommand } from "../src/commands/specs.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-03T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

const LIBRARY_ENTRIES = [
  { id: "abc123", kind: "rig", name: "review-rig", version: "0.2", sourceType: "builtin", sourcePath: "/builtin/review-rig.yaml", relativePath: "review-rig.yaml", updatedAt: "2026-04-01T00:00:00Z", summary: "A review rig" },
  { id: "def456", kind: "agent", name: "impl-agent", version: "1.0", sourceType: "user_file", sourcePath: "/home/user/.openrig/specs/impl-agent.yaml", relativePath: "impl-agent.yaml", updatedAt: "2026-04-01T00:00:00Z" },
];

const RIG_REVIEW = {
  sourceState: "library_item", kind: "rig", name: "review-rig", version: "0.2", format: "pod_aware",
  libraryEntryId: "abc123", sourcePath: "/builtin/review-rig.yaml",
  pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", runtime: "claude-code", profile: "default" }], edges: [] }],
  edges: [], graph: { nodes: [], edges: [] }, raw: "name: review-rig\n",
};

describe("Specs CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url === "/api/specs/library" || url.startsWith("/api/specs/library?")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        const kind = new URL(`http://localhost${url}`).searchParams.get("kind");
        const filtered = kind ? LIBRARY_ENTRIES.filter((e) => e.kind === kind) : LIBRARY_ENTRIES;
        res.end(JSON.stringify(filtered));
      } else if (url === "/api/specs/library/abc123") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entry: LIBRARY_ENTRIES[0], yaml: "name: review-rig\n" }));
      } else if (url === "/api/specs/library/abc123/review") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(RIG_REVIEW));
      } else if (url === "/api/specs/library/sync" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(LIBRARY_ENTRIES));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(port)));
    return prog;
  }

  it("specs ls prints library entries", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "specs", "ls"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("review-rig");
    expect(output).toContain("impl-agent");
  });

  it("specs ls --json prints raw JSON array", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "specs", "ls", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it("specs show resolves by name and prints metadata", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "specs", "show", "review-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("review-rig");
    expect(output).toContain("/builtin/review-rig.yaml");
  });

  it("specs show with ambiguous name errors with candidates", async () => {
    // Create a server with duplicate names
    const dupServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { ...LIBRARY_ENTRIES[0], id: "aaa" },
        { ...LIBRARY_ENTRIES[0], id: "bbb", sourcePath: "/other/review-rig.yaml" },
      ]));
    });
    await new Promise<void>((resolve) => { dupServer.listen(0, resolve); });
    const dupPort = (dupServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(dupPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "specs", "show", "review-rig"]);
    });
    dupServer.close();

    expect(logs.join("\n")).toContain("ambiguous");
    expect(exitCode).toBe(1);
  });

  it("specs preview --json returns structured review", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "specs", "preview", "review-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.kind).toBe("rig");
    expect(parsed.sourceState).toBe("library_item");
    expect(parsed.libraryEntryId).toBe("abc123");
  });

  it("specs sync reports updated count", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "specs", "sync"]);
    });
    expect(logs.join("\n")).toContain("2");
  });

  it("specs add validates, copies, and reports entry ID", async () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // Use temp dir as HOME to avoid polluting real ~/.openrig/specs/
    const tmpDir = mkdtempSync(join(tmpdir(), "specs-add-"));
    const specPath = join(tmpDir, "test-spec.yaml");
    writeFileSync(specPath, 'name: test-spec\nversion: "0.2"\npods: []\nedges: []\n');
    const savedHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;

    const addServer = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url.startsWith("/api/specs/review/rig") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ kind: "rig", name: "test-spec" }));
        } else if (url === "/api/specs/library/sync" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ id: "new-id", kind: "rig", name: "test-spec", sourcePath: join(tmpDir, ".openrig", "specs", "test-spec.yaml") }]));
        } else if (url === "/api/specs/library") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([]));
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { addServer.listen(0, resolve); });
    const addPort = (addServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(addPort)));

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "specs", "add", specPath]);
    });

    addServer.close();

    // Verify it copied to temp HOME, not real HOME
    expect(existsSync(join(tmpDir, ".openrig", "specs", "test-spec.yaml"))).toBe(true);

    process.env["HOME"] = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });

    const output = logs.join("\n");
    expect(output).toContain("Added");
    expect(output).toContain("test-spec");
    expect(output).toContain("ID:");
  });
});
