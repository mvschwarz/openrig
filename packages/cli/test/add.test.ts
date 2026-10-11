import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { createProgram } from "../src/index.js";
import { Command } from "commander";
import { addMemberCommand } from "../src/commands/add.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

function mockLifecycleDeps(): LifecycleDeps {
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

const OK_RESPONSE = {
  ok: true,
  result: {
    podId: "pod-123",
    podNamespace: "infra",
    node: { logicalId: "infra.server2", nodeId: "n2", status: "launched", sessionName: "infra-server2@test" },
    warnings: ["Startup submission unverified in worker@fixture"],
  },
};

const CONFLICT_RESPONSE = {
  ok: false,
  code: "member_conflict",
  message: 'Member "infra.server" already exists in rig "test". Pick a different member id, or remove the existing seat first.',
};

const NOT_FOUND_RESPONSE = {
  ok: false,
  code: "pod_not_found",
  message: 'Pod "nope" not found in rig "test". Existing pods: infra. Check the namespace, or add a new pod with `rig expand`.',
};

const RIG_NOT_FOUND_RESPONSE = {
  ok: false,
  code: "rig_not_found",
  message: 'Rig "ghost" not found.',
};

const ALPHA_ID = "01KALPHA0000000000000000AA";
const DUPE_ID_1 = "01KDUPE10000000000000000AA";
const DUPE_ID_2 = "01KDUPE20000000000000000AA";
const ARCHIVED_ID = "01KARCH00000000000000000AA";
const COLLIDE_ID = "01KCOLLIDE00000000000000AA";
const RIG_SUMMARIES = [
  { id: ALPHA_ID, name: "alpha", nodeCount: 2, archivedAt: null },
  { id: DUPE_ID_1, name: "dupe", nodeCount: 1, archivedAt: null },
  { id: DUPE_ID_2, name: "dupe", nodeCount: 1, archivedAt: null },
  // An archived rig, plus an ACTIVE rig whose name is that archived rig's id.
  { id: ARCHIVED_ID, name: "old-team", nodeCount: 1, archivedAt: "2026-06-01T00:00:00Z" },
  { id: COLLIDE_ID, name: ARCHIVED_ID, nodeCount: 1, archivedAt: null },
];

const FAILED_LAUNCH_RESPONSE = {
  ok: true,
  result: {
    podId: "pod-123",
    podNamespace: "infra",
    node: { logicalId: "infra.server2", nodeId: "n2", status: "failed", error: "harness launch failed" },
    warnings: [],
  },
};

describe("rig add", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let fragmentPath: string;
  let capturedBody: Record<string, unknown> | null = null;
  let capturedUrl: string | null = null;
  let summaryStatus = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/api/rigs/summary")) {
        res.writeHead(summaryStatus, { "Content-Type": "application/json" });
        // Mirrors the route: archived rigs only with ?includeArchived=true.
        const includeArchived = new URL(req.url, "http://x").searchParams.get("includeArchived") === "true";
        const rigs = includeArchived ? RIG_SUMMARIES : RIG_SUMMARIES.filter((r) => r.archivedAt == null);
        res.end(JSON.stringify(summaryStatus === 200 ? rigs : { error: "unavailable" }));
      } else if (req.method === "POST" && req.url?.includes("/members")) {
        capturedUrl = req.url;
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          capturedBody = parsed;
          const memberId = parsed.member?.id;
          if (req.url?.startsWith("/api/rigs/ghost/")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify(RIG_NOT_FOUND_RESPONSE));
          } else if (req.url?.includes("/nope/")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify(NOT_FOUND_RESPONSE));
          } else if (memberId === "server") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(CONFLICT_RESPONSE));
          } else if (memberId === "failer") {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(FAILED_LAUNCH_RESPONSE));
          } else {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(OK_RESPONSE));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  let savedHostSelected: string | undefined;

  beforeEach(() => {
    capturedBody = null;
    capturedUrl = null;
    summaryStatus = 200;
    // Hermetic host selection: never read the real ~/.openrig/config.json.
    savedHostSelected = process.env["OPENRIG_HOST_SELECTED"];
    process.env["OPENRIG_HOST_SELECTED"] = "local";
    tmpDir = join(tmpdir(), `add-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    fragmentPath = join(tmpDir, "member.yaml");
    writeFileSync(fragmentPath, `id: server2\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
  });

  afterEach(() => {
    if (savedHostSelected === undefined) delete process.env["OPENRIG_HOST_SELECTED"];
    else process.env["OPENRIG_HOST_SELECTED"] = savedHostSelected;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runningDeps(): StatusDeps {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-07T00:00:00Z" } as DaemonState);
          return null;
        }),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
  }

  function makeCmd(deps?: StatusDeps): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(addMemberCommand(deps ?? runningDeps()));
    return prog;
  }

  it("parses rig-id, pod-namespace, and member-fragment-path", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    const output = logs.join("\n");
    expect(output).toContain("infra.server2");
    expect(output).toContain("OK");
    expect(logs.join("\n")).toContain("Startup submission unverified in worker@fixture");
  });

  it("--json returns the raw API response", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath, "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.node.logicalId).toBe("infra.server2");
  });

  it("human output shows the launched member with its session", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    const output = logs.join("\n");
    expect(output).toContain("[OK] infra.server2");
    expect(output).toContain("infra-server2@test");
  });

  it("duplicate member id -> exit 1 with the honest conflict message", async () => {
    writeFileSync(fragmentPath, `id: server\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("already exists");
    expect(output).toContain("Pick a different member id");
  });

  it("pod not found -> exit 1 with the honest not-found message", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "nope", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("not found");
    expect(output).toContain("Existing pods: infra");
  });

  it("launched-but-failed node -> exit 1 (status surfaced)", async () => {
    writeFileSync(fragmentPath, `id: failer\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("[FAIL] infra.server2");
    expect(output).toContain("harness launch failed");
  });

  it("--json exits non-zero when the new node did not launch", async () => {
    writeFileSync(fragmentPath, `id: failer\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath, "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.result.node.status).toBe("failed");
    expect(exitCode).toBe(1);
  });

  it("wired via createProgram", async () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "add");
    expect(cmd).toBeDefined();
  });

  // Governance FM2: rig add must NOT silently strip pod-local edges from the
  // fragment file - they must reach the daemon, in both wrapper and bare forms.
  it("forwards wrapper-form edges to the daemon (not stripped)", async () => {
    capturedBody = null;
    writeFileSync(fragmentPath, `member:\n  id: server2\n  runtime: terminal\n  agent_ref: "builtin:terminal"\n  profile: none\n  cwd: /tmp\nedges:\n  - from: server2\n    to: server\n    kind: delegates_to\n`);
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(capturedBody).not.toBeNull();
    expect((capturedBody as { member: { id: string } }).member.id).toBe("server2");
    expect((capturedBody as { edges: unknown[] }).edges).toEqual([{ from: "server2", to: "server", kind: "delegates_to" }]);
  });

  it("lifts bare-form top-level edges out to pod-local edges (not dropped into the member)", async () => {
    capturedBody = null;
    writeFileSync(fragmentPath, `id: server2\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\nedges:\n  - from: server2\n    to: server\n    kind: delegates_to\n`);
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    const sent = capturedBody as { member: Record<string, unknown>; edges: unknown[] };
    expect(sent.edges).toEqual([{ from: "server2", to: "server", kind: "delegates_to" }]);
    // edges lifted OUT of the member, not silently carried as an ignored field.
    expect(sent.member["edges"]).toBeUndefined();
    expect(sent.member["id"]).toBe("server2");
  });

  it("rejects a present-but-non-array edges field (exit 1, never posted, no silent omit)", async () => {
    capturedBody = null;
    writeFileSync(fragmentPath, `member:\n  id: server2\n  runtime: terminal\n  agent_ref: "builtin:terminal"\n  profile: none\n  cwd: /tmp\nedges: not-an-array\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("edges");
    // Rejected before the POST - never silently omitted and sent.
    expect(capturedBody).toBeNull();
  });

  // Identity ergonomics: `rig whoami --json` names the rig, so `rig add` must
  // accept that exact unique name as well as the id.
  describe("rig name or id", () => {
    it("an exact unique name resolves to that rig's id", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "alpha", "infra", fragmentPath]);
      });
      expect(exitCode).toBeUndefined();
      expect(capturedUrl).toBe(`/api/rigs/${ALPHA_ID}/pods/infra/members`);
      expect(logs.join("\n")).toContain("[OK] infra.server2");
    });

    it("an id is posted unchanged", async () => {
      await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", DUPE_ID_2, "infra", fragmentPath]);
      });
      expect(capturedUrl).toBe(`/api/rigs/${DUPE_ID_2}/pods/infra/members`);
    });

    it("an archived rig's exact id wins over an active rig with that name", async () => {
      await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", ARCHIVED_ID, "infra", fragmentPath]);
      });
      expect(capturedUrl).toBe(`/api/rigs/${ARCHIVED_ID}/pods/infra/members`);
    });

    it("an archived rig's name does not resolve (posted as typed)", async () => {
      await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "old-team", "infra", fragmentPath]);
      });
      expect(capturedUrl).toBe("/api/rigs/old-team/pods/infra/members");
    });

    it("a missing name keeps the daemon's rig_not_found (exit 1)", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "ghost", "infra", fragmentPath]);
      });
      expect(exitCode).toBe(1);
      expect(capturedUrl).toBe("/api/rigs/ghost/pods/infra/members");
      expect(logs.join("\n")).toContain('Rig "ghost" not found.');
    });

    it("an ambiguous name refuses without posting and lists the matching ids", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "dupe", "infra", fragmentPath]);
      });
      expect(exitCode).toBe(1);
      expect(capturedUrl).toBeNull();
      const output = logs.join("\n");
      expect(output).toContain("'dupe' matches 2 rigs");
      expect(output).toContain(`rig add ${DUPE_ID_1} infra ${fragmentPath}`);
      expect(output).toContain(`rig add ${DUPE_ID_2} infra ${fragmentPath}`);
    });

    it("suggested re-run commands quote a fragment path with spaces and keep --rig-root", async () => {
      const spaced = join(tmpDir, "my member.yaml");
      writeFileSync(spaced, `id: server2\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "dupe", "infra", spaced, "--rig-root", "/tmp/my root"]);
      });
      expect(capturedUrl).toBeNull();
      expect(logs.join("\n")).toContain(`rig add ${DUPE_ID_1} infra '${spaced}' --rig-root '/tmp/my root'`);
    });

    it("--json: an ambiguous name returns rig_ambiguous with the candidate ids", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "dupe", "infra", fragmentPath, "--json"]);
      });
      expect(exitCode).toBe(1);
      expect(capturedUrl).toBeNull();
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("rig_ambiguous");
      expect(parsed.candidates).toEqual([DUPE_ID_1, DUPE_ID_2]);
    });

    it("summary unavailable -> the raw handle is posted as before", async () => {
      summaryStatus = 500;
      await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "alpha", "infra", fragmentPath]);
      });
      expect(capturedUrl).toBe("/api/rigs/alpha/pods/infra/members");
    });

    it("summary unavailable + rig_not_found -> hints that a name could not be resolved", async () => {
      summaryStatus = 500;
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "add", "ghost", "infra", fragmentPath]);
      });
      expect(exitCode).toBe(1);
      const output = logs.join("\n");
      expect(output).toContain('Rig "ghost" not found.');
      expect(output).toContain("Could not list rigs to resolve a name");
    });

    // A selected remote host makes whoami/ps report THAT host's rigs, but rig
    // add only talks to the local daemon. A copied name must not land on a
    // same-named local rig.
    describe("with a remote host selected", () => {
      beforeEach(() => { process.env["OPENRIG_HOST_SELECTED"] = "host-b"; });

      it("refuses a name that matches a local rig, without posting", async () => {
        const { logs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "add", "alpha", "infra", fragmentPath]);
        });
        expect(exitCode).toBe(1);
        expect(capturedUrl).toBeNull();
        const output = logs.join("\n");
        expect(output).toContain("host-b");
        expect(output).toContain("local daemon");
        expect(output).toContain("Nothing was added");
      });

      it("--json: refuses with remote_host_selected", async () => {
        const { logs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "add", "dupe", "infra", fragmentPath, "--json"]);
        });
        expect(exitCode).toBe(1);
        expect(capturedUrl).toBeNull();
        const parsed = JSON.parse(logs.join("\n"));
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe("remote_host_selected");
      });

      it("an exact local id is posted unchanged, as before", async () => {
        await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "add", ALPHA_ID, "infra", fragmentPath]);
        });
        expect(capturedUrl).toBe(`/api/rigs/${ALPHA_ID}/pods/infra/members`);
      });

      it("an archived rig's exact id is posted unchanged, not refused as a name", async () => {
        const { exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "add", ARCHIVED_ID, "infra", fragmentPath]);
        });
        expect(exitCode).toBeUndefined();
        expect(capturedUrl).toBe(`/api/rigs/${ARCHIVED_ID}/pods/infra/members`);
      });

      it("an unknown handle keeps the daemon's rig_not_found", async () => {
        const { logs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "add", "ghost", "infra", fragmentPath]);
        });
        expect(exitCode).toBe(1);
        expect(capturedUrl).toBe("/api/rigs/ghost/pods/infra/members");
        expect(logs.join("\n")).toContain('Rig "ghost" not found.');
      });
    });

    it("help names the accepted identity form", () => {
      const help = addMemberCommand(runningDeps()).helpInformation();
      expect(help).toContain("<rig>");
      expect(help).toContain("Rig name or ID");
    });
  });
});
