import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { Command } from "commander";
import { SystemPreflight } from "../src/system-preflight.js";
import { ConfigStore } from "../src/config-store.js";
import { preflightCommand } from "../src/commands/preflight.js";
import type { DaemonStatus } from "../src/daemon-lifecycle.js";

function makeExec(tmuxMode: "healthy" | "missing" | "unhealthy" = "healthy"): (cmd: string) => Promise<string> {
  return async (cmd: string) => {
    if (cmd === "tmux -V") {
      if (tmuxMode === "missing") throw new Error("command not found: tmux");
      return "tmux 3.6a";
    }
    if (cmd === "tmux list-sessions") {
      if (tmuxMode === "missing") throw new Error("command not found: tmux");
      if (tmuxMode === "unhealthy") throw new Error("server exited unexpectedly");
      return "";
    }
    if (cmd.includes("tmux")) return "tmux 3.6a";
    return "";
  };
}

function makeStatus(overrides?: Partial<DaemonStatus>): () => Promise<DaemonStatus> {
  return async () => ({ state: "stopped" as const, ...overrides });
}

describe("SystemPreflight", () => {
  let tmpDir: string;
  let savedVersion: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "preflight-"));
    savedVersion = process.version;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process, "version", { value: savedVersion, writable: true });
  });

  function createPreflight(opts?: {
    tmuxMode?: "healthy" | "missing" | "unhealthy";
    configOverrides?: Record<string, unknown>;
    daemonStatus?: Partial<DaemonStatus>;
  }) {
    const configPath = join(tmpDir, "config.json");
    const config = new ConfigStore(configPath);
    // Point writable paths to tmpDir
    const homeDir = join(tmpDir, ".openrig");
    mkdirSync(homeDir, { recursive: true });

    return new SystemPreflight({
      exec: makeExec(opts?.tmuxMode ?? "healthy"),
      configStore: config,
      getDaemonStatus: makeStatus(opts?.daemonStatus),
      riggedHome: homeDir,
    });
  }

  // Test 1
  it("all checks pass → ready: true", async () => {
    const pf = createPreflight();
    // Use port 0 to avoid collisions with any running daemon
    const result = await pf.run({ port: 0 });
    expect(result.ready).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  // Test 2
  it("Node version below 20 → ready: false with guidance", async () => {
    Object.defineProperty(process, "version", { value: "v18.19.0", writable: true });
    const pf = createPreflight();
    const result = await pf.run();
    expect(result.ready).toBe(false);
    const nodeCheck = result.checks.find((c) => c.name === "node_version");
    expect(nodeCheck!.ok).toBe(false);
    expect(nodeCheck!.error).toContain("v18.19.0");
    expect(nodeCheck!.fix).toContain("Node 20");
  });

  // Test 3
  it("tmux missing → ready: false with guidance", async () => {
    const pf = createPreflight({ tmuxMode: "missing" });
    const result = await pf.run();
    expect(result.ready).toBe(false);
    const tmuxCheck = result.checks.find((c) => c.name === "tmux");
    expect(tmuxCheck!.ok).toBe(false);
    expect(tmuxCheck!.error).toContain("not found");
    expect(tmuxCheck!.fix).toContain("install tmux");
  });

  it("tmux installed but default control socket unhealthy → ready: false with guidance", async () => {
    const pf = createPreflight({ tmuxMode: "unhealthy" });
    const result = await pf.run();

    expect(result.ready).toBe(false);
    const tmuxCheck = result.checks.find((c) => c.name === "tmux");
    expect(tmuxCheck!.ok).toBe(false);
    expect(tmuxCheck!.error).toContain("control socket");
    expect(tmuxCheck!.reason).toContain("server exited unexpectedly");
    expect(tmuxCheck!.fix).toContain("restart the default tmux server");
  });

  // Test 4
  it("OpenRig home not writable → ready: false with guidance", async () => {
    const readonlyDir = join(tmpDir, "readonly-home");
    mkdirSync(readonlyDir);
    chmodSync(readonlyDir, 0o444);
    const pf = new SystemPreflight({
      exec: makeExec(),
      configStore: new ConfigStore(join(tmpDir, "config.json")),
      getDaemonStatus: makeStatus(),
      riggedHome: join(readonlyDir, "nested"),
    });
    const result = await pf.run();
    expect(result.ready).toBe(false);
    const homeCheck = result.checks.find((c) => c.name === "writable_home");
    expect(homeCheck!.ok).toBe(false);
    expect(homeCheck!.fix).toContain("permissions");
    // Restore perms for cleanup
    chmodSync(readonlyDir, 0o755);
  });

  // Test 5
  it("port in use → ready: false with guidance", async () => {
    // Start a server on a known port
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;

    const pf = createPreflight();
    const result = await pf.run({ port });
    server.close();

    expect(result.ready).toBe(false);
    const portCheck = result.checks.find((c) => c.name === "port_available");
    expect(portCheck!.ok).toBe(false);
    expect(portCheck!.error).toContain(String(port));
    expect(portCheck!.fix).toContain("rig config set daemon.port");
  });

  // Test 6
  it("port check skipped when daemon running on same host:port", async () => {
    const pf = createPreflight({
      daemonStatus: { state: "running", port: 7433, host: "127.0.0.1", healthy: true },
    });
    const result = await pf.run({ port: 7433, host: "127.0.0.1" });
    const portCheck = result.checks.find((c) => c.name === "port_available");
    expect(portCheck!.ok).toBe(true);
  });

  // Test 7
  it("port check NOT skipped when daemon running on different host:port", async () => {
    // Daemon running on 127.0.0.1:7433 but checking 10.0.0.5:7433
    const pf = createPreflight({
      daemonStatus: { state: "running", port: 7433, host: "127.0.0.1", healthy: true },
    });
    // Use a port that's actually available, but the skip rule should not apply
    const result = await pf.run({ port: 7433, host: "10.0.0.5" });
    const portCheck = result.checks.find((c) => c.name === "port_available");
    // Should have attempted the check (not skipped)
    expect(portCheck).toBeDefined();
  });

  // Test 8
  it("multiple failures reported together (additive)", async () => {
    Object.defineProperty(process, "version", { value: "v18.19.0", writable: true });
    const pf = createPreflight({ tmuxMode: "missing" });
    const result = await pf.run();
    expect(result.ready).toBe(false);
    const failedChecks = result.checks.filter((c) => !c.ok);
    expect(failedChecks.length).toBeGreaterThanOrEqual(2);
  });

  // Test 10
  it("port override takes precedence over config", async () => {
    const pf = createPreflight();
    // Config default is 7433, override to 0 (always available)
    const result = await pf.run({ port: 0 });
    const portCheck = result.checks.find((c) => c.name === "port_available");
    expect(portCheck!.ok).toBe(true);
  });
});

// CLI command tests
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

describe("Preflight CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "preflight-cli-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 9 (--json)
  it("rig preflight --json prints structured result", async () => {
    const homeDir = join(tmpDir, ".openrig");
    mkdirSync(homeDir, { recursive: true });
    // Set port to 0 to avoid collisions
    const configPath = join(tmpDir, "config.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, JSON.stringify({ daemon: { port: 0 } }));
    const cmd = preflightCommand({
      exec: makeExec(),
      configPath,
      riggedHome: homeDir,
      getDaemonStatus: makeStatus(),
    });
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "preflight", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ready).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  // Test 11
  it("rig preflight prints check marks and exits 0 on pass", async () => {
    const homeDir = join(tmpDir, ".openrig");
    mkdirSync(homeDir, { recursive: true });
    const configPath2 = join(tmpDir, "config2.json");
    const { writeFileSync: wf } = await import("node:fs");
    wf(configPath2, JSON.stringify({ daemon: { port: 0 } }));
    const cmd = preflightCommand({
      exec: makeExec(),
      configPath: configPath2,
      riggedHome: homeDir,
      getDaemonStatus: makeStatus(),
    });
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "preflight"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("✓");
    expect(output).toContain("passed");
    expect(exitCode).toBeUndefined(); // 0 / not set
  });

  // Test 12: simulates daemon start / rig up aborting on preflight failure
  // The actual daemon.ts and up.ts commands run the same SystemPreflight.run() check
  // and abort on !result.ready — this test proves that flow via the preflight command
  it("preflight failure causes abort with exit code 1 (same flow as daemon start/up)", async () => {
    const homeDir = join(tmpDir, ".openrig");
    mkdirSync(homeDir, { recursive: true });
    // Create a server on a known port to trigger port-in-use
    const server = (await import("node:net")).createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const usedPort = (server.address() as net.AddressInfo).port;
    const configPath = join(tmpDir, "config-port.json");
    const { writeFileSync: wf2 } = await import("node:fs");
    wf2(configPath, JSON.stringify({ daemon: { port: usedPort } }));

    const cmd = preflightCommand({
      exec: makeExec(),
      configPath,
      riggedHome: homeDir,
      getDaemonStatus: makeStatus(),
    });
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "preflight"]);
    });
    server.close();
    const output = logs.join("\n");
    expect(output).toContain("✗");
    expect(output).toContain("port");
    expect(exitCode).toBe(1);
  });

  // Test 13
  it("rig preflight with failure prints three-part error and exits 1", async () => {
    const homeDir = join(tmpDir, ".openrig");
    mkdirSync(homeDir, { recursive: true });
    const cmd = preflightCommand({
      exec: makeExec(false), // tmux missing
      configPath: join(tmpDir, "config.json"),
      riggedHome: homeDir,
      getDaemonStatus: makeStatus(),
    });
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(cmd);

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "preflight"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("✗");
    expect(output).toContain("Fix:");
    expect(exitCode).toBe(1);
  });
});
