// S5b final-fix round 2 (r2 artifact 8d9ec788) — every CLI consumer of the
// direct instantiate/materialize routes must render the locked rig_name_running
// teaching refusal VERBATIM, not wrap it in check-your-spec/validate noise.
// The stub serves the daemon's post-fix 409 outcome shape.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { adoptCommand } from "../src/commands/adopt.js";
import { importCommand } from "../src/commands/import.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

const TEACHING =
  'A rig named "dupe-cli" is already RUNNING: 01RIGID with 1 running session(s) ' +
  "(checked: existing rigs with this name for sessions in status 'running'). " +
  "Nothing was created or launched. Alternatives: work with the running rig " +
  "(rig ps --nodes / rig send), stop it first with 'rig down dupe-cli', " +
  "or launch this spec under a different name.";

function mockLifecycleDeps(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) {
        return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState);
      }
      return null;
    }),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

describe("rig import rendering — rig_name_running teaching refusal (S5b r2)", () => {
  let server: http.Server;
  let port: number;
  let specPath: string;
  let tempDir: string;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if ((req.url === "/api/rigs/import" || req.url === "/api/rigs/import/materialize") && req.method === "POST") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          code: "rig_name_running",
          error: TEACHING,
          runningRig: { id: "01RIGID", name: "dupe-cli", runningSessionCount: 1 },
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-rnr-"));
    specPath = path.join(tempDir, "rig.yaml");
    fs.writeFileSync(specPath, 'version: "0.2"\nname: dupe-cli\npods: []\nedges: []\n');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function run(mode: "--instantiate" | "--materialize-only" | "adopt"): Promise<{ out: string; exitCode: number | undefined }> {
    const captured: string[] = [];
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => captured.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => captured.push(args.join(" ")));
    try {
      const prog = new Command();
      prog.exitOverride();
      const deps = {
        lifecycleDeps: mockLifecycleDeps(port),
        clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      };
      const args = mode === "adopt"
        ? ["node", "rig", "adopt", specPath, "--bind", "crew.a=existing-session"]
        : ["node", "rig", "import", specPath, mode];
      prog.addCommand(mode === "adopt" ? adoptCommand(deps as never) : importCommand(deps as never));
      await prog.parseAsync(args).catch(() => {});
    } finally {
      vi.restoreAllMocks();
    }
    const exitCode = process.exitCode;
    process.exitCode = originalExit;
    return { out: captured.join("\n"), exitCode };
  }

  for (const mode of ["--instantiate", "--materialize-only", "adopt"] as const) {
    it(`${mode}: renders the teaching refusal verbatim — no spec-blaming or daemon-logs noise`, async () => {
      const { out, exitCode } = await run(mode);

      expect(out).toBe(TEACHING);
      expect(exitCode).toBe(1);
    });
  }
});
