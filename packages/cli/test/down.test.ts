import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { downCommand } from "../src/commands/down.js";
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

describe("Down CLI", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown> | undefined;
  let responseOverride: { status: number; body: Record<string, unknown> } | null;
  // When null, GET /api/rigs/summary returns 404 -> down falls back to today's
  // id-only behavior (so every pre-existing id-based test passes unchanged).
  // When set, the summary is served at 200 to exercise name resolution.
  let summaryOverride: Array<{ id: string; name: string; archivedAt?: string | null; lifecycleState?: string }> | null;
  // Count POST /api/down calls so the AC-3 discriminator can assert that an
  // ambiguous name reaches teardown ZERO times (fail-safe).
  let downCallCount: number;

  beforeAll(async () => {
    responseOverride = null;
    summaryOverride = null;
    downCallCount = 0;
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url?.split("?")[0] === "/api/rigs/summary" && req.method === "GET") {
        if (summaryOverride === null) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summaryOverride));
        return;
      }

      if (req.url === "/api/down" && req.method === "POST") {
        downCallCount += 1;
        lastBody = JSON.parse(body);

        if (responseOverride) {
          res.writeHead(responseOverride.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseOverride.body));
          return;
        }

        const rigId = lastBody?.["rigId"] as string;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          rigId, sessionsKilled: 2, snapshotId: null,
          deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [],
        }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    responseOverride = null;
    summaryOverride = null;
    downCallCount = 0;
    lastBody = undefined;
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(downCommand(runningDeps(port)));
    return prog;
  }

  // T1: down success -> exit 0
  it("down success prints summary and exits 0", async () => {
    responseOverride = null;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("stopped"))).toBe(true);
    expect(logs.some((l) => l.includes("2 session(s) killed"))).toBe(true);
    expect(exitCode).toBeUndefined(); // 0
  });

  // T2a: down alreadyStopped (no delete) -> exit 1
  it("down alreadyStopped with no delete exits 1", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 0, snapshotId: null, deleted: false, deleteBlocked: false, alreadyStopped: true, errors: [] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("already stopped"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  // T2b: down alreadyStopped + deleted -> exit 0 (deletion succeeded)
  it("down alreadyStopped with successful delete exits 0", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 0, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: true, errors: [] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("deleted"))).toBe(true);
    expect(exitCode).toBeUndefined(); // 0
  });

  // T2c: deleted + snapshot error -> exit 2
  it("down deleted with snapshot errors exits 2", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 2, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: false, errors: ["Snapshot failed: disk full"] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("warning"))).toBe(true);
    expect(exitCode).toBe(2);
  });

  // T3: down with errors, deleted=false -> exit 2
  it("down with errors and no delete exits 2", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 1, snapshotId: null, deleted: false, deleteBlocked: true, alreadyStopped: false, errors: ["Kill failed for session 'r01-x': timeout"] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(exitCode).toBe(2);
  });

  // T4: down --delete sends delete:true
  it("down --delete sends delete flag", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 2, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: false, errors: [] },
    };
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--delete"]);
    });
    expect(lastBody?.["delete"]).toBe(true);
  });

  // T5: down --snapshot sends snapshot:true
  it("down --snapshot sends snapshot flag", async () => {
    responseOverride = null;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--snapshot"]);
    });
    expect(lastBody?.["snapshot"]).toBe(true);
  });

  // T6: down --force sends force:true
  it("down --force sends force flag", async () => {
    responseOverride = null;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--force"]);
    });
    expect(lastBody?.["force"]).toBe(true);
  });

  // T7: down --json raw output
  it("down --json outputs raw JSON", async () => {
    responseOverride = null;
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.rigId).toBe("rig-1");
    expect(parsed.sessionsKilled).toBe(2);
  });

  // T8: down 404 -> exit 2
  it("down with 404 exits 2", async () => {
    responseOverride = { status: 404, body: { error: "Rig not found: missing" } };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "missing"]);
    });
    expect(exitCode).toBe(2);
  });

  // T9: --json + alreadyStopped -> exit 1
  it("down --json with alreadyStopped exits 1", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 0, snapshotId: null, deleted: false, deleteBlocked: false, alreadyStopped: true, errors: [] },
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--json"]);
    });
    expect(exitCode).toBe(1);
  });

  // T10: --json + 200 + errors -> exit 2
  it("down --json with errors exits 2", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 2, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: false, errors: ["Snapshot failed: disk full"] },
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--json"]);
    });
    expect(exitCode).toBe(2);
  });

  // ---- OPR.0.3.3.22: down accepts name-or-id ----

  // AC-1: down by name resolves the name to its id and tears down.
  it("AC-1: down by name resolves the name to its id and tears down", async () => {
    summaryOverride = [{ id: "rig-abc", name: "product-team" }];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "product-team"]);
    });
    expect(lastBody?.["rigId"]).toBe("rig-abc"); // resolved id, not the name
    expect(downCallCount).toBe(1);
    expect(logs.some((l) => l.includes("rig-abc") && l.includes("stopped"))).toBe(true);
    expect(exitCode).toBeUndefined(); // 0
  });

  // AC-2: down by id still works when the id is present in the summary (no regression).
  it("AC-2: down by exact id resolves directly (id-match wins, even if a name also matches)", async () => {
    // A rig whose NAME equals another rig's id-shaped handle would be a trap;
    // assert the exact-id match is taken first and posts that id.
    summaryOverride = [
      { id: "rig-xyz", name: "alpha" },
      { id: "rig-collide", name: "rig-xyz" }, // name collides with the first rig's id
    ];
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-xyz"]);
    });
    expect(lastBody?.["rigId"]).toBe("rig-xyz"); // id-exact-match wins, not the name-collision rig
    expect(downCallCount).toBe(1);
    expect(exitCode).toBeUndefined();
  });

  // AC-3 (LOAD-BEARING DISCRIMINATOR): ambiguous active name tears down NOTHING.
  it("AC-3: ambiguous name is refused and NEITHER rig is torn down (no /api/down POST)", async () => {
    summaryOverride = [
      { id: "rig-1a", name: "product-team" },
      { id: "rig-2b", name: "product-team" },
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "product-team"]);
    });
    // The discriminator: teardown was never attempted.
    expect(downCallCount).toBe(0);
    expect(lastBody).toBeUndefined(); // no POST body ever parsed
    // Honest 3-part error listing both ids + the remediation.
    const out = logs.join("\n");
    expect(out).toContain("rig-1a");
    expect(out).toContain("rig-2b");
    expect(out).toMatch(/rig down rig-1a|rig down rig-2b/);
    expect(out.toLowerCase()).toContain("ambiguous");
    expect(exitCode).toBe(2);
  });

  // AC-3 --json: same fail-safe, structured error with candidate ids, no POST.
  it("AC-3 --json: ambiguous name emits structured error with candidates and does not POST", async () => {
    summaryOverride = [
      { id: "rig-1a", name: "product-team" },
      { id: "rig-2b", name: "product-team" },
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "product-team", "--json"]);
    });
    expect(downCallCount).toBe(0);
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.error.candidates).toEqual(["rig-1a", "rig-2b"]);
    expect(exitCode).toBe(2);
  });

  // AC-4: honest not-found when a good summary contains no id/name match. No POST.
  it("AC-4: not-found name halts with an honest error and no teardown", async () => {
    summaryOverride = [{ id: "rig-abc", name: "product-team" }];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "no-such-rig"]);
    });
    expect(downCallCount).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("no-such-rig");
    expect(out).toContain("rig ps");
    expect(exitCode).toBe(2);
  });

  // AC-5 regression: flags flow through unchanged when a name resolves to an id.
  it("AC-5: --delete/--force/--snapshot flow through when a name resolves", async () => {
    summaryOverride = [{ id: "rig-abc", name: "product-team" }];
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "product-team", "--delete", "--force", "--snapshot"]);
    });
    expect(lastBody?.["rigId"]).toBe("rig-abc");
    expect(lastBody?.["delete"]).toBe(true);
    expect(lastBody?.["force"]).toBe(true);
    expect(lastBody?.["snapshot"]).toBe(true);
  });

  // Passthrough: summary unavailable (non-200) -> today's id-only behavior preserved.
  it("falls back to id-only POST when the rig summary is unavailable", async () => {
    summaryOverride = null; // GET /api/rigs/summary -> 404
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(lastBody?.["rigId"]).toBe("rig-1"); // raw handle posted, as today
    expect(downCallCount).toBe(1);
    expect(exitCode).toBeUndefined();
  });

  // AC-2 (archived): an archived rig's id still reaches the canonical /api/down
  // id path. The summary is fetched with includeArchived=true, so the archived
  // id id-matches and POSTs (today's behavior preserved).
  it("AC-2 archived: down by an archived rig id still POSTs the id (no regression)", async () => {
    summaryOverride = [{ id: "rig-arch", name: "old-team", archivedAt: "2026-06-01T00:00:00Z" }];
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-arch"]);
    });
    expect(lastBody?.["rigId"]).toBe("rig-arch");
    expect(downCallCount).toBe(1);
    expect(exitCode).toBeUndefined();
  });

  // Governance pt-5: an active+archived same-name pair is NOT ambiguous - only
  // the ACTIVE candidate counts for name resolution; it resolves and tears down.
  it("active+archived same-name pair resolves the ACTIVE rig (not ambiguous)", async () => {
    summaryOverride = [
      { id: "rig-active", name: "product-team", archivedAt: null },
      { id: "rig-archived", name: "product-team", archivedAt: "2026-06-01T00:00:00Z" },
    ];
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "product-team"]);
    });
    expect(lastBody?.["rigId"]).toBe("rig-active"); // the active one, not ambiguous
    expect(downCallCount).toBe(1);
    expect(exitCode).toBeUndefined();
  });

  // An archived-only name does not resolve by name (use the id / archive path).
  it("archived-only name does not resolve by name (not_found, no teardown)", async () => {
    summaryOverride = [{ id: "rig-archived", name: "old-team", archivedAt: "2026-06-01T00:00:00Z" }];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "old-team"]);
    });
    expect(downCallCount).toBe(0); // name path excludes archived -> no match -> halt
    expect(logs.join("\n")).toContain("old-team");
    expect(exitCode).toBe(2);
  });
});
