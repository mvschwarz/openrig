import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { rigCommand, type RigDeps } from "../src/commands/rig.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

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
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-29T00:00:00Z" };
}

function runningLifecycleDeps(port: number): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) return JSON.stringify(runningState(port));
      return null;
    }),
    fetch: vi.fn(async () => ({ ok: true })),
  });
}

// Track received headers for assertion
let capturedHeaders: Record<string, string | undefined> = {};

function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // POST /api/rigs/import/validate
    if (req.method === "POST" && url.pathname === "/api/rigs/import/validate") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("INVALID")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, errors: ["missing schema_version", "name is required"] }));
        } else if (body.includes("ALIASPIN")) {
          // OPR.0.5.3.3: valid + a fail-open alias-pin advisory naming the canonical id.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: true, errors: [], advisories: ['pods.dev.members.driver: model pin "fable" is an alias form — pin the canonical id "claude-fable-5" (5.3 requires exact/canonical pins).'] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: true, errors: [] }));
        }
      });
      return;
    }

    // POST /api/rigs/import/preflight
    if (req.method === "POST" && url.pathname === "/api/rigs/import/preflight") {
      capturedHeaders = {
        "x-rig-root": req.headers["x-rig-root"] as string | undefined,
      };
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("AMBIGUOUS")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, warnings: [], errors: ["ambiguous node collision: orchestrator defined in multiple pods"] }));
        } else if (body.includes("COLLISION")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, warnings: ["node name collision: worker shadows pod-a/worker"], errors: [] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: true, warnings: ["cmux unavailable"], errors: [] }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

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

describe("rig spec", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function rigDeps(fileContent: string): RigDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn(() => fileContent),
    };
  }

  // T3: rig spec validate invalid rig -> exit 1, output contains errors
  it("rig spec validate invalid: prints errors, exitCode 1", async () => {
    const deps = rigDeps("INVALID");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "validate", "rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("missing schema_version");
    expect(output).toContain("name is required");
    expect(exitCode).toBe(1);
  });

  // OPR.0.5.3.3 item 2: alias-pin advisories print (fail-open — spec still valid, exit not 1).
  it("rig spec validate prints alias-pin advisories naming the canonical id, fail-open", async () => {
    const deps = rigDeps("ALIASPIN");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "validate", "rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("spec advisory"); // advisory surfaced
    expect(output).toContain("claude-fable-5"); // names the canonical id
    expect(output).toContain("Rig spec valid"); // fail-open: still valid
    expect(exitCode).not.toBe(1);
  });

  // Slice 16 (item 2): rig spec audit flags stale seat ids in the culture.
  function rigDepsMap(files: Record<string, string>): RigDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn((p: string) => {
        const key = Object.keys(files).find((k) => p.endsWith(k));
        if (key === undefined) throw new Error(`no such file: ${p}`);
        return files[key]!;
      }),
    };
  }

  it("rig spec audit: flags a stale culture seat id after a rename", async () => {
    const rigYaml = "schema_version: 1\nname: t\nculture_file: CULTURE.md\npods:\n  - id: dev1\n    members:\n      - id: builder\n      - id: qa\n";
    // culture still names the OLD id `dev1.impl` (renamed to dev1.builder)
    const culture = "The dev pod: `dev1.builder` builds, dispatch to `dev1.impl` for legacy, `dev1.qa` gates.";
    const deps = rigDepsMap({ "rig.yaml": rigYaml, "CULTURE.md": culture });
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "audit", "/x/rig.yaml", "--json"]));
    const result = JSON.parse(logs.join("\n"));
    const stale = result.findings.find((f: { kind: string }) => f.kind === "stale_culture_seat_id");
    expect(stale).toBeDefined();
    expect(stale.message).toContain("dev1.impl");
  });

  it("rig spec audit: consistent culture ids → no stale finding; a file path is not a false positive", async () => {
    const rigYaml = "schema_version: 1\nname: t\nculture_file: CULTURE.md\nstartup:\n  files: [x.md]\npods:\n  - id: dev1\n    members:\n      - id: impl\n";
    const culture = "The `dev1.impl` implements. See `docs/reference.md` and `README.md`.";
    const deps = rigDepsMap({ "rig.yaml": rigYaml, "CULTURE.md": culture });
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "audit", "/x/rig.yaml", "--json"]));
    const result = JSON.parse(logs.join("\n"));
    expect(result.findings.map((f: { kind: string }) => f.kind)).not.toContain("stale_culture_seat_id");
  });

  // T4: rig spec preflight -> exit 0, output contains "ready" + warnings
  it("rig spec preflight ready: prints ready + warnings", async () => {
    const deps = rigDeps("schema_version: 1\nname: test-rig\nnodes: []\n");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "preflight", "/tmp/rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("Preflight ready");
    expect(output).toContain("cmux unavailable");
    expect(exitCode).toBeUndefined();
  });

  // T7: rig spec preflight with collision warnings -> output shows warnings
  it("rig spec preflight with collision warnings: shows warnings", async () => {
    const deps = rigDeps("schema_version: 1\nname: test-rig\nCOLLISION\nnodes: []\n");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "preflight", "/tmp/rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("node name collision");
    expect(output).toContain("not ready");
    expect(exitCode).toBe(1);
  });

  // T8: rig spec preflight with ambiguous collision -> exit 1, output shows error
  it("rig spec preflight with ambiguous collision: exit 1, shows error", async () => {
    const deps = rigDeps("schema_version: 1\nname: test-rig\nAMBIGUOUS\nnodes: []\n");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "spec", "preflight", "/tmp/rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("ambiguous node collision");
    expect(output).toContain("not ready");
    expect(exitCode).toBe(1);
  });

  it("rig spec audit reports missing culture and startup context without blocking", async () => {
    const clientFactory = vi.fn(() => new DaemonClient(`http://127.0.0.1:${port}`));
    const deps: RigDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      clientFactory,
      readFile: vi.fn(() => "version: '0.2'\nname: sparse-rig\npods: []\nedges: []\n"),
    };
    const program = new Command();
    program.exitOverride();
    const specCommand = rigCommand(deps);
    specCommand.exitOverride();
    program.addCommand(specCommand);

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "spec", "audit", "rig.yaml"]),
    );
    const output = logs.join("\n");
    expect(output).toContain("2 advisory findings");
    expect(output).toContain("culture_file");
    expect(output).toContain("startup.files");
    expect(output).toContain("openrig-architect");
    expect(exitCode).toBeUndefined();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("rig spec audit reports a complete spec clean as JSON", async () => {
    const deps = rigDeps([
      "version: '0.2'",
      "name: complete-rig",
      "culture_file: CULTURE.md",
      "startup:",
      "  files:",
      "    - path: startup/context.md",
      "      delivery_hint: guidance_merge",
      "pods: []",
      "edges: []",
      "",
    ].join("\n"));
    const program = new Command();
    program.exitOverride();
    const specCommand = rigCommand(deps);
    specCommand.exitOverride();
    program.addCommand(specCommand);

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "spec", "audit", "rig.yaml", "--json"]),
    );
    expect(JSON.parse(logs.join("\n"))).toEqual({
      clean: true,
      findingCount: 0,
      findings: [],
    });
    expect(exitCode).toBeUndefined();
  });
});
