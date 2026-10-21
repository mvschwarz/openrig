import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { psCommand, type PsDeps } from "../src/commands/ps.js";
import type { DaemonClient, DaemonResponse } from "../src/client.js";

function mockClient(responses: Record<string, { status: number; data: unknown }>): DaemonClient & { _calls: Array<{ path: string; headers?: Record<string, string> }> } {
  const calls: Array<{ path: string; headers?: Record<string, string> }> = [];
  return {
    baseUrl: "http://remote:7433",
    get: async <T>(path: string, options?: { headers?: Record<string, string> }) => {
      calls.push({ path, headers: options?.headers });
      const r = responses[path] ?? { status: 404, data: { error: "not found" } };
      return { status: r.status, data: r.data as T } as DaemonResponse<T>;
    },
    post: async () => ({ status: 200, data: {} }) as DaemonResponse<unknown>,
    _calls: calls,
  } as unknown as DaemonClient & { _calls: typeof calls };
}

function makeCmd(deps: PsDeps): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(psCommand(deps));
  return prog;
}

function mockRegistry(hosts: Array<Record<string, unknown>>) {
  return () => ({ ok: true as const, registry: { hosts } });
}

async function captureLogs(fn: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  process.stdout.write = ((c: unknown) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
  try { await fn(); } catch {}
  console.log = origLog;
  console.error = origErr;
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  return { stdout, stderr };
}

afterEach(() => { vi.unstubAllEnvs(); process.exitCode = undefined; });

describe("rig ps --host HTTP", () => {
  it("calls /api/ps with remote bearer header", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-secret-123");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "rig-1", name: "test-rig" }] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--json"]);
    });
    expect(client._calls.length).toBeGreaterThanOrEqual(1);
    expect(client._calls[0]!.path).toContain("/api/ps");
    expect(client._calls[0]!.headers?.Authorization).toBe("Bearer remote-secret-123");
  });

  it("--nodes calls /api/rigs/:rigId/nodes with bearer", async () => {
    vi.stubEnv("HOST_B_TOKEN", "remote-secret");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "rig-1", name: "test-rig" }] },
      "/api/rigs/rig-1/nodes": { status: 200, data: [{ logicalId: "dev.impl" }] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    await captureLogs(async () => {
      // OPR.0.4.4.21 FR-2: remote --nodes requires an explicit target
      // (implicit scope defaults don't cross host boundaries).
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--rig", "test-rig", "--json"]);
    });
    const nodesCalls = client._calls.filter((c) => c.path.includes("/nodes"));
    expect(nodesCalls.length).toBe(1);
    expect(nodesCalls[0]!.headers?.Authorization).toBe("Bearer remote-secret");
  });

  it("missing bearer => no HTTP request", async () => {
    delete process.env.MISSING_TOKEN;
    const client = mockClient({});
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "MISSING_TOKEN" },
      ]),
    };
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--json"]);
    });
    expect(client._calls.length).toBe(0);
  });

  it("--summary returns summary object", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "rig", status: "running", nodeCount: 2, runningCount: 2 }] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--summary", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.totalRigs).toBe(1);
  });

  it("invalid --limit rejected before HTTP request", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({});
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--limit", "abc", "--json"]);
    });
    expect(client._calls.length).toBe(0);
    expect(stderr.some((s) => s.includes("non-negative integer"))).toBe(true);
  });

  it("--active sugar works on HTTP path", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [
        { rigId: "r1", name: "a", status: "running" },
        { rigId: "r2", name: "b", status: "stopped" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--active", "--json"]);
    });
    expect(client._calls.length).toBeGreaterThanOrEqual(1);
  });

  it("--active + --filter conflict rejected before HTTP request", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({});
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--active", "--filter", "status=running", "--json"]);
    });
    expect(client._calls.length).toBe(0);
    expect(stderr.some((s) => s.includes("cannot be combined"))).toBe(true);
  });

  it("warns once when a rig-tier context filter is ignored", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "demo", status: "running" }] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout, stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--json", "--filter", "contextUsage.state=critical"]);
    });
    expect(JSON.parse(stdout.join(""))).toEqual({
      entries: [expect.objectContaining({ rigId: "r1", name: "demo" })],
      totalRigs: 1,
      truncated: false,
    });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("contextUsage.state");
    expect(stderr[0]).toContain("was not applied");
    expect(stderr[0]).toContain("--nodes");
  });

  it("--nodes --json returns flattened node array (not rig wrappers)", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "alpha" }, { rigId: "r2", name: "beta" }] },
      "/api/rigs/r1/nodes": { status: 200, data: [{ logicalId: "dev.a", rigName: "alpha" }] },
      "/api/rigs/r2/nodes": { status: 200, data: [{ logicalId: "dev.b", rigName: "beta" }] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "-A", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].rigName).toBeDefined();
  });

  it("--nodes --limit 1 --fields logicalId,rigName returns envelope with totalNodes", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "alpha" }] },
      "/api/rigs/r1/nodes": { status: 200, data: [
        { logicalId: "dev.a", rigName: "alpha", runtime: "claude-code" },
        { logicalId: "dev.b", rigName: "alpha", runtime: "codex" },
        { logicalId: "dev.c", rigName: "alpha", runtime: "claude-code" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--rig", "alpha", "--json", "--limit", "1", "--fields", "logicalId,rigName"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.entries).toBeDefined();
    expect(parsed.entries.length).toBe(1);
    expect(parsed.totalNodes).toBe(3);
    expect(parsed.truncated).toBe(true);
  });

  it("--nodes --summary --limit 1 counts all nodes before limit", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "alpha" }] },
      "/api/rigs/r1/nodes": { status: 200, data: [
        { logicalId: "dev.a", sessionStatus: "running" },
        { logicalId: "dev.b", sessionStatus: "running" },
        { logicalId: "dev.c", sessionStatus: "stopped" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--rig", "alpha", "--summary", "--limit", "1", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.totalNodes).toBe(3);
  });

  it("--summary --limit 1 counts all rigs before limit", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [
        { rigId: "r1", name: "a", status: "running" },
        { rigId: "r2", name: "b", status: "stopped" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--summary", "--limit", "1", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.totalRigs).toBe(2);
  });

  it("--rig scopes the remote rig list before --summary and --limit", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [
        { rigId: "r1", name: "a", status: "running" },
        { rigId: "r2", name: "b", status: "stopped" },
        { rigId: "r3", rigName: "c", name: "c-display", status: "running" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const list = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--rig", "b", "--json"]);
    });
    expect(JSON.parse(list.stdout.join("")).map((e: { rigId: string }) => e.rigId)).toEqual(["r2"]);

    const byRigName = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--rig", "c", "--json"]);
    });
    expect(JSON.parse(byRigName.stdout.join("")).map((e: { rigId: string }) => e.rigId)).toEqual(["r3"]);

    const summary = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--rig", "b", "--summary", "--json"]);
    });
    expect(JSON.parse(summary.stdout.join("")).totalRigs).toBe(1);

    const envelope = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--rig", "c", "--limit", "1", "--json"]);
    });
    const parsed = JSON.parse(envelope.stdout.join(""));
    expect(parsed.totalRigs).toBe(1);
    expect(parsed.entries.map((e: { rigId: string }) => e.rigId)).toEqual(["r3"]);
  });

  it("--rig naming no rig on the host says so and exits 1, like the local view; --json keeps []", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "a", status: "running" }] },
      "/api/ps?includeArchived=true": { status: 200, data: [
        { rigId: "r1", name: "a", status: "running" },
        { rigId: "r9", name: "old", status: "stopped", isArchived: true },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    const run = async (...args: string[]) => {
      process.exitCode = undefined;
      const logs = await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", ...args]);
      });
      const exitCode = process.exitCode;
      process.exitCode = undefined;
      return { ...logs, exitCode };
    };

    for (const args of [["--rig", "nope"], ["--rig", "nope", "--summary"]]) {
      const r = await run(...args);
      expect(r.stderr.join("")).toContain("Rig 'nope' not found on host host-b. List rigs with: rig ps --host host-b");
      expect(r.stdout.join("")).toBe("");
      expect(r.exitCode).toBe(1);
    }

    const archived = await run("--rig", "old");
    expect(archived.stderr.join("")).toContain("Rig 'old' is archived on host host-b. Show it with: rig ps --host host-b --rig old --include-archived");
    expect(archived.exitCode).toBe(1);

    const json = await run("--rig", "nope", "--json");
    expect(JSON.parse(json.stdout.join(""))).toEqual([]);
    expect(json.exitCode).toBeUndefined();
  });

  it("a failed archived lookup is reported as a failure, not as 'not found'", async () => {
    vi.stubEnv("HOST_B_TOKEN", "tok");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "r1", name: "a", status: "running" }] },
      "/api/ps?includeArchived=true": { status: 503, data: { error: "busy" } },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" },
      ]),
    };
    for (const args of [["--rig", "nope"], ["--nodes", "--rig", "nope"]]) {
      process.exitCode = undefined;
      const { stderr } = await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", ...args]);
      });
      const exitCode = process.exitCode;
      process.exitCode = undefined;
      expect(stderr.join("")).toContain("503");
      expect(stderr.join("")).not.toContain("not found");
      // The remote rig view uses the cross-host error (1); the node view, the rig-list failure (2).
      expect(exitCode).toBe(args.includes("--nodes") ? 2 : 1);
    }
  });

  it("the help's exit codes list --rig naming no rig", async () => {
    const prog = makeCmd({ lifecycleDeps: {} as PsDeps["lifecycleDeps"], clientFactory: () => mockClient({}) });
    let out = "";
    prog.commands[0]!.configureOutput({ writeOut: (text) => { out += text; } });
    await prog.parseAsync(["node", "rig", "ps", "--help"]).catch(() => {});
    expect(out).toContain("Exit codes:");
    expect(out).toContain("--rig names no rig");
  });
});

describe("rig ps --all-hosts fan-out", () => {
  it("unknown --hosts id returns error", async () => {
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => mockClient({}),
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://x", bearer_env: "TOK" },
      ]),
    };
    const { stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--hosts", "typo-host", "--json"]);
    });
    expect(stderr.some((s) => s.includes("unknown host ids"))).toBe(true);
  });

  it("ssh-only --hosts id gets per-host failure entry", async () => {
    vi.stubEnv("TOK", "secret");
    const client = mockClient({
      "/api/ps": { status: 200, data: [] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "ssh-host", transport: "ssh", target: "vm.local" },
        { id: "http-host", transport: "http", url: "http://x", bearer_env: "TOK" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--hosts", "ssh-host", "--json"]);
    });
    // OPR.0.4.4.21 FR-5 — the shared P4 contract: an SSH-declared host is a
    // STRUCTURED unsupported-transport status in hosts[], never silence.
    const parsed = JSON.parse(stdout.join(""));
    expect(Array.isArray(parsed.items)).toBe(true);
    const sshEntry = parsed.hosts.find((h: { hostId: string }) => h.hostId === "ssh-host");
    expect(sshEntry).toBeDefined();
    expect(sshEntry.status).toBe("unsupported-transport");
  });

  // OPR.0.4.4.21 FR-5 — the intra-P4 shared payload contract
  // (fanout-contract.ts): items stamped with origin hostId + the per-host
  // structured status array covering EVERY targeted host.
  it("fan-out --json emits AggregatedPayload: hostId-stamped items + closed-enum statuses", async () => {
    vi.stubEnv("TOK_B", "secret-b");
    delete process.env.TOK_C; // host-c bearer missing -> auth-failed
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "rig-1", name: "remote-rig", nodeCount: 2, runningCount: 2, status: "running" }] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
        { id: "host-c", transport: "http", url: "http://c", bearer_env: "TOK_C" },
        { id: "ssh-d", transport: "ssh", target: "d.local" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    // items: only reachable hosts contribute rows; every row carries its origin
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].hostId).toBe("host-b");
    expect(parsed.items[0].name).toBe("remote-rig");
    // hosts[]: every targeted host appears with a closed-enum status
    const byId = Object.fromEntries(parsed.hosts.map((h: { hostId: string; status: string }) => [h.hostId, h.status]));
    expect(byId["host-b"]).toBe("ok");
    expect(byId["host-c"]).toBe("auth-failed");
    expect(byId["ssh-d"]).toBe("unsupported-transport");
    expect(parsed.hosts).toHaveLength(3);
  });

  // OPR.0.4.4.21 FR-5 — fan-out per-node requires the FULL explicit ladder
  // (--nodes -A); anything less errors (never silent rig-tier data under a
  // --nodes flag).
  it("fan-out --nodes WITHOUT -A errors, teaching the full ladder", async () => {
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => mockClient({}),
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
      ]),
    };
    const { stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "--json"]);
    });
    const err = stderr.join("\n");
    expect(err).toContain("FULL explicit ladder");
    expect(err).toContain("--nodes -A");
  });

  // OPR.0.4.4.21 FR-5 — the PRD's full-ladder exception implemented:
  // --all-hosts --nodes -A fans out per-node, PROJECTED rows stamped with
  // their origin hostId; non-HTTP hosts still appear as
  // unsupported-transport statuses.
  it("fan-out --nodes -A returns AggregatedPayload of projected node rows (full ladder)", async () => {
    vi.stubEnv("TOK_B", "secret-b");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "rig-1", name: "remote-rig", rigName: "remote-rig" }] },
      "/api/rigs/rig-1/nodes": { status: 200, data: [
        { rigId: "rig-1", rigName: "remote-rig", logicalId: "dev.impl", sessionStatus: "running", resumeToken: "SECRET" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
        { id: "ssh-d", transport: "ssh", target: "d.local" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "-A", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].hostId).toBe("host-b");
    expect(parsed.items[0].logicalId).toBe("dev.impl");
    // projected rows: resumeTokenPresent boolean, never the token value
    expect(parsed.items[0].resumeTokenPresent).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    const byId = Object.fromEntries(parsed.hosts.map((h: { hostId: string; status: string }) => [h.hostId, h.status]));
    expect(byId["host-b"]).toBe("ok");
    expect(byId["ssh-d"]).toBe("unsupported-transport");
  });

  // OPR.0.4.4.21 rev1-r2 B1 — the SECURITY pin: explicit --fields on the
  // full fan-out ladder projects ONLY the named fields (+ the hostId origin
  // carriage) — resume material can never survive a projection.
  it("fan-out --nodes -A --full --fields projects named fields only (no resume leakage)", async () => {
    vi.stubEnv("TOK_B", "secret-b");
    const client = mockClient({
      "/api/ps": { status: 200, data: [{ rigId: "rig-1", name: "remote-rig", rigName: "remote-rig" }] },
      "/api/rigs/rig-1/nodes": { status: 200, data: [
        { rigId: "rig-1", rigName: "remote-rig", logicalId: "dev.impl", sessionStatus: "running",
          resumeToken: "SECRET-TOKEN", resumeCommand: "claude --resume SECRET-TOKEN" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
      ]),
    };
    const { stdout } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "-A", "--full", "--json", "--fields", "logicalId"]);
    });
    const raw = stdout.join("");
    const parsed = JSON.parse(raw);
    expect(parsed.items).toHaveLength(1);
    expect(Object.keys(parsed.items[0]).sort()).toEqual(["hostId", "logicalId"]);
    expect(parsed.items[0]).toEqual({ logicalId: "dev.impl", hostId: "host-b" });
    expect(raw).not.toContain("SECRET-TOKEN");
    expect(raw).not.toContain("resumeToken");
    expect(raw).not.toContain("resumeCommand");
  });

  it("fan-out honors --limit and --filter on the merged items (shared composition)", async () => {
    vi.stubEnv("TOK_B", "secret-b");
    vi.stubEnv("TOK_C", "secret-c");
    const client = mockClient({
      "/api/ps": { status: 200, data: [
        { rigId: "rig-1", name: "run-rig", rigName: "run-rig", status: "running" },
        { rigId: "rig-2", name: "stop-rig", rigName: "stop-rig", status: "stopped" },
      ] },
    });
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
        { id: "host-c", transport: "http", url: "http://c", bearer_env: "TOK_C" },
      ]),
    };
    // --filter status=running: 2 hosts × 1 matching rig each
    const { stdout: filteredOut } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--json", "--filter", "status=running"]);
    });
    const filtered = JSON.parse(filteredOut.join(""));
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((i: { name: string }) => i.name === "run-rig")).toBe(true);
    // --limit 1 applies to the MERGED list; hosts[] stays complete
    const { stdout: limitedOut } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--json", "--limit", "1"]);
    });
    const limited = JSON.parse(limitedOut.join(""));
    expect(limited.items).toHaveLength(1);
    expect(limited.hosts).toHaveLength(2);
  });

  it("fan-out --summary errors honestly (no summary member in the shared contract)", async () => {
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => mockClient({}),
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
      ]),
    };
    const { stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--summary", "--json"]);
    });
    expect(stderr.join("\n")).toContain("does not compose with the merged fan-out payload");
  });

  it("fan-out rejects bogus --fields BEFORE any HTTP call", async () => {
    const client = mockClient({});
    const deps: PsDeps = {
      lifecycleDeps: {} as PsDeps["lifecycleDeps"],
      clientFactory: () => client,
      hostRegistryLoader: mockRegistry([
        { id: "host-b", transport: "http", url: "http://b", bearer_env: "TOK_B" },
      ]),
    };
    const { stderr } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--all-hosts", "--json", "--fields", "bogus"]);
    });
    expect(stderr.join("\n")).toContain("bogus");
    expect(client._calls).toHaveLength(0);
  });
});
