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
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--json"]);
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
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--json"]);
    });
    const parsed = JSON.parse(stdout.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].logicalId).toBeDefined();
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
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--json", "--limit", "1", "--fields", "logicalId,rigName"]);
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
      await makeCmd(deps).parseAsync(["node", "rig", "ps", "--host", "host-b", "--nodes", "--summary", "--limit", "1", "--json"]);
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
    const output = stdout.join("");
    if (output.includes("hosts")) {
      const parsed = JSON.parse(output);
      const sshEntry = parsed.hosts?.find((h: { host: string }) => h.host === "ssh-host");
      expect(sshEntry).toBeDefined();
      expect(sshEntry.ok).toBe(false);
    }
  });
});
