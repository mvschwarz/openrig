import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { bundleCommand } from "../src/commands/bundle.js";
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
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

// Captured create bodies for assertion
let capturedCreateBodies: Record<string, unknown>[] = [];
// Captured install bodies for assertion (Item 2 Checkpoint 3.3)
let capturedInstallBodies: Record<string, unknown>[] = [];

describe("Bundle CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/bundles/create" && req.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        capturedCreateBodies.push(parsed);
        if (String(parsed.specPath ?? "").includes("missing")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing package" }));
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          bundleName: parsed.bundleName ?? "test",
          bundleVersion: parsed.bundleVersion ?? "0.1.0",
          archiveHash: "abc123",
          packages: 1,
        }));
      } else if (req.url === "/api/bundles/inspect" && req.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (String(parsed.bundlePath ?? "").includes("bad")) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Inspect failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ manifest: { name: "test", version: "0.1.0" }, digestValid: true, integrityResult: { passed: true } }));
      } else if (req.url === "/api/bundles/install" && req.method === "POST") {
        const parsed = JSON.parse(body);
        capturedInstallBodies.push(parsed);
        if (String(parsed.bundlePath ?? "").includes("blocked")) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "blocked" }));
          return;
        }
        if (parsed.plan) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "planned", runId: "run-1", stages: [] }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "completed", runId: "run-2", rigId: "rig-1" }));
        }
      } else if (req.url?.startsWith("/api/bundles/history") && req.method === "GET") {
        // Capture query for assertion if needed; for now return a static fixture
        const url = new URL(req.url, "http://x");
        const rigFilter = url.searchParams.get("rig");
        const allRecs = [
          { installedAt: "2026-05-18T10:00:00Z", bundlePath: "/tmp/a.rigbundle", targetRigName: "alpha", outcome: "success" },
          { installedAt: "2026-05-18T11:00:00Z", bundlePath: "/tmp/b.rigbundle", targetRigName: "beta", outcome: "failed" },
        ];
        const recs = rigFilter ? allRecs.filter((r) => r.targetRigName === rigFilter) : allRecs;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ records: recs, total: recs.length }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bundleCommand(runningDeps(port)));
    return prog;
  }

  // T11: create produces output
  it("bundle create prints confirmation", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "create", "/tmp/rig.yaml", "-o", "/tmp/test.rigbundle"]);
    });
    expect(logs.some((l) => l.includes("Bundle created"))).toBe(true);
    expect(logs.some((l) => l.includes("abc123"))).toBe(true);
  });

  it("bundle create uses --bundle-version without colliding with the CLI version flag", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node",
        "rig",
        "bundle",
        "create",
        "/tmp/rig.yaml",
        "-o",
        "/tmp/test.rigbundle",
        "--bundle-version",
        "2.0.0",
      ]);
    });
    expect(logs.some((l) => l.includes("v2.0.0"))).toBe(true);
  });

  // T12: inspect prints summary
  it("bundle inspect prints summary", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "inspect", "/tmp/test.rigbundle"]);
    });
    expect(logs.some((l) => l.includes("Bundle:"))).toBe(true);
    expect(logs.some((l) => l.includes("Integrity: PASS"))).toBe(true);
  });

  // T13: install runs bootstrap
  it("bundle install prints status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "install", "/tmp/test.rigbundle", "--yes", "--target", "/tmp/target"]);
    });
    expect(logs.some((l) => l.includes("completed"))).toBe(true);
    expect(logs.some((l) => l.includes("rig-1"))).toBe(true);
  });

  // T14: --json output
  it("bundle inspect --json outputs parseable JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "inspect", "/tmp/test.rigbundle", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.manifest.name).toBe("test");
  });

  // T15: --plan shows plan
  it("bundle install --plan shows planned status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "install", "/tmp/test.rigbundle", "--plan"]);
    });
    expect(logs.some((l) => l.includes("planned"))).toBe(true);
  });

  it("bundle create --json preserves failure exit code", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "create", "/tmp/missing.rig.yaml", "-o", "/tmp/test.rigbundle", "--json"]);
    });
    expect(JSON.parse(logs.join("")).error).toBe("Missing package");
    expect(exitCode).toBe(2);
  });

  it("bundle install --json preserves blocked exit code", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "install", "/tmp/blocked.rigbundle", "--json"]);
    });
    expect(JSON.parse(logs.join("")).error).toBe("blocked");
    expect(exitCode).toBe(1);
  });

  // T6: bundle create --rig-root passes rigRoot in request body
  it("bundle create --rig-root passes rigRoot in request body", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
        "--rig-root", "/my/project",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    expect(createBody!["rigRoot"]).toMatch(/\/my\/project/);
  });

  // Item 1 / slice-05: --notes flag is captured into provenance in the request body
  it("bundle create --notes wires the operator note into provenance.notes in the request body", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
        "--notes", "checkpoint-2-part-3 fixture",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    const provenance = createBody!["provenance"] as Record<string, unknown> | undefined;
    expect(provenance).toBeTruthy();
    expect(provenance!["notes"]).toBe("checkpoint-2-part-3 fixture");
  });

  // Item 1 / slice-05: provenance auto-includes hostname + cliVersion at invoke time
  it("bundle create automatically includes hostname + cliVersion in provenance (no flag needed)", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    const provenance = createBody!["provenance"] as Record<string, unknown> | undefined;
    expect(provenance).toBeTruthy();
    // hostname and cliVersion auto-populate (real os.hostname() + CLI package.json read)
    expect(typeof provenance!["sourceHost"]).toBe("string");
    expect((provenance!["sourceHost"] as string).length).toBeGreaterThan(0);
    expect(typeof provenance!["cliVersion"]).toBe("string");
    expect((provenance!["cliVersion"] as string).length).toBeGreaterThan(0);
    // notes is undefined when --notes not passed (no empty string sent)
    expect(provenance!["notes"]).toBeUndefined();
  });

  // Item 2 / slice-05: --min-daemon-version + --min-cli-version flags wire into request body compatibility
  it("bundle create --min-daemon-version and --min-cli-version wire into request body compatibility", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
        "--min-daemon-version", "0.3.2",
        "--min-cli-version", "0.3.2",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    const compatibility = createBody!["compatibility"] as Record<string, unknown> | undefined;
    expect(compatibility).toBeTruthy();
    expect(compatibility!["minDaemonVersion"]).toBe("0.3.2");
    expect(compatibility!["minCliVersion"]).toBe("0.3.2");
  });

  // Item 2 / slice-05: --min-daemon-version alone (partial) still wires
  it("bundle create --min-daemon-version alone wires partial compatibility into request body", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
        "--min-daemon-version", "0.3.2",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    const compatibility = createBody!["compatibility"] as Record<string, unknown> | undefined;
    expect(compatibility).toBeTruthy();
    expect(compatibility!["minDaemonVersion"]).toBe("0.3.2");
    expect(compatibility!["minCliVersion"]).toBeUndefined();
  });

  // Item 2 / slice-05 Checkpoint 3.3: bundle install --skip-version-check wires through
  it("bundle install --skip-version-check sets skipVersionCheck=true in request body", async () => {
    capturedInstallBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "install", "/tmp/test.rigbundle",
        "--yes", "--target", "/tmp/target",
        "--skip-version-check",
      ]);
    });
    const installBody = capturedInstallBodies[capturedInstallBodies.length - 1];
    expect(installBody).toBeTruthy();
    expect(installBody!["skipVersionCheck"]).toBe(true);
    // cliVersion auto-included (read at call time via getCliVersion)
    expect(typeof installBody!["cliVersion"]).toBe("string");
    expect((installBody!["cliVersion"] as string).length).toBeGreaterThan(0);
  });

  it("bundle install without --skip-version-check sets skipVersionCheck=false and still sends cliVersion", async () => {
    capturedInstallBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "install", "/tmp/test.rigbundle",
        "--yes", "--target", "/tmp/target",
      ]);
    });
    const installBody = capturedInstallBodies[capturedInstallBodies.length - 1];
    expect(installBody).toBeTruthy();
    expect(installBody!["skipVersionCheck"]).toBe(false);
    expect(typeof installBody!["cliVersion"]).toBe("string");
  });

  // Item 3 / slice-05 Checkpoint 4.2: --force flag wires through to request body
  it("bundle install --force sets force=true in request body", async () => {
    capturedInstallBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "install", "/tmp/test.rigbundle",
        "--yes", "--target", "/tmp/target",
        "--force",
      ]);
    });
    const installBody = capturedInstallBodies[capturedInstallBodies.length - 1];
    expect(installBody).toBeTruthy();
    expect(installBody!["force"]).toBe(true);
  });

  it("bundle install without --force sets force=false in request body (operator-explicit opt-in only)", async () => {
    capturedInstallBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "install", "/tmp/test.rigbundle",
        "--yes", "--target", "/tmp/target",
      ]);
    });
    const installBody = capturedInstallBodies[capturedInstallBodies.length - 1];
    expect(installBody).toBeTruthy();
    expect(installBody!["force"]).toBe(false);
  });

  // Item 4 / slice-05 Checkpoint 5.2: rig bundle history subcommand
  it("bundle history renders records as text by default", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "history"]);
    });
    expect(logs.some((l) => l.includes("Bundle install history"))).toBe(true);
    expect(logs.some((l) => l.includes("alpha"))).toBe(true);
    expect(logs.some((l) => l.includes("beta"))).toBe(true);
    expect(logs.some((l) => l.includes("success"))).toBe(true);
  });

  it("bundle history --json outputs parseable JSON with records array", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "history", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed.records)).toBe(true);
    expect(parsed.records.length).toBe(2);
    expect(parsed.total).toBe(2);
  });

  it("bundle history --rig filter passes through to the query string", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "bundle", "history", "--rig", "alpha", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].targetRigName).toBe("alpha");
  });

  // Item 2 / slice-05: no flags → compatibility omitted (no empty object sent)
  it("bundle create with neither min-version flag omits compatibility from request body", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    expect(createBody!["compatibility"]).toBeUndefined();
  });

  // Item 1 / slice-05: authorSession populates when OPENRIG_SESSION_NAME env is set
  it("bundle create includes authorSession when OPENRIG_SESSION_NAME env is set", async () => {
    capturedCreateBodies = [];
    const origEnv = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "velocity-driver@openrig-velocity";
    try {
      await captureLogs(async () => {
        await makeCmd().parseAsync([
          "node", "rig", "bundle", "create", "/tmp/rig.yaml",
          "-o", "/tmp/test.rigbundle",
        ]);
      });
    } finally {
      if (origEnv === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = origEnv;
    }
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    const provenance = createBody!["provenance"] as Record<string, unknown> | undefined;
    expect(provenance).toBeTruthy();
    expect(provenance!["authorSession"]).toBe("velocity-driver@openrig-velocity");
  });
});
