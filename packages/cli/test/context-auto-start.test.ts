import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";

describe("context add local auto-start", () => {
  let root: string;
  let source: string;
  let previousExit: typeof process.exitCode;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "context-auto-start-"));
    source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "manifest.yaml"), "name: fixture-pack\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: NOTES.md\n    role: instruction\n");
    writeFileSync(join(source, "NOTES.md"), "fixture context\n");
    vi.stubEnv("OPENRIG_HOME", join(root, "state"));
    vi.stubEnv("OPENRIG_CONTEXT_ROOT", join(root, "context"));
    vi.stubEnv("OPENRIG_DB", join(root, "state", "fixture.sqlite"));
    vi.stubEnv("OPENRIG_TRANSCRIPTS_PATH", join(root, "transcripts"));
    vi.stubEnv("OPENRIG_PORT", "42761");
    vi.stubEnv("OPENRIG_HOST", "127.0.0.1");
    vi.stubEnv("RIGGED_HOST", "");
    previousExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = previousExit;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(initial: "stopped" | "running" | "unknown" = "stopped", stale = false) {
    let started = initial === "running";
    let state: string | null = stale
      ? JSON.stringify({ pid: 900001, port: 42760, host: "127.0.0.1", db: "fixture.sqlite", startedAt: "2026-01-01T00:00:00Z" })
      : null;
    const statePath = join(root, "state", "daemon.json");
    if (state) {
      mkdirSync(join(root, "state"), { recursive: true });
      writeFileSync(statePath, state);
    }
    const lifecycleDeps: LifecycleDeps = {
      acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
      spawn: vi.fn(() => {
        started = true;
        return Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null, unref: vi.fn() }) as never;
      }),
      fetch: vi.fn(async () => {
        if (initial === "unknown") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        if (!started) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        return { ok: true, json: async () => ({ pid: 4321, bind: { mode: "explicit", hosts: ["127.0.0.1"], tailscaleDetected: false } }) };
      }),
      kill: vi.fn(() => true),
      readFile: vi.fn((p) => p === STATE_FILE ? state : null),
      writeFile: vi.fn((p, content) => { if (p === STATE_FILE) state = content; }),
      removeFile: vi.fn(),
      exists: vi.fn((p) => p === STATE_FILE && state !== null),
      mkdirp: vi.fn(),
      openForAppend: vi.fn(() => 3),
      isProcessAlive: vi.fn(() => started),
      sleep: async () => {},
    };
    const post = vi.fn(async () => ({ status: 200, data: { count: 1, entries: [], errors: [] } }));
    const clientFactory = vi.fn(() => ({ post }) as unknown as DaemonClient);
    const preflightExec = vi.fn(async (cmd: string) => cmd === "tmux -V" ? "tmux 3.6a" : "");
    const command = () => new Command().exitOverride().addCommand(contextCommand({ lifecycleDeps, clientFactory, preflightExec }));
    const add = () => command().parseAsync(["node", "rig", "context", "add", source, "--json"]);
    return { lifecycleDeps, clientFactory, preflightExec, post, command, add };
  }

  it("starts a stopped local daemon with configured paths then syncs the installed pack", async () => {
    const f = fixture();
    await f.add();
    expect(process.exitCode).toBeUndefined();
    expect(f.lifecycleDeps.spawn).toHaveBeenCalledOnce();
    const options = vi.mocked(f.lifecycleDeps.spawn).mock.calls[0]![2];
    expect(options.env.OPENRIG_PORT).toBe("42761");
    expect(options.env.OPENRIG_DB).toBe(join(root, "state", "fixture.sqlite"));
    expect(options.env.OPENRIG_HOST).toBeUndefined(); // Routing is not bind intent.
    expect(f.clientFactory).toHaveBeenCalledWith("http://127.0.0.1:42761");
    expect(f.post).toHaveBeenCalledWith("/api/context-packs/library/sync");
    expect(readFileSync(join(root, "context", "fixture-pack", "NOTES.md"), "utf8")).toBe("fixture context\n");
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ count: 1 });
  });

  it("uses a running daemon without a start or preflight", async () => {
    const f = fixture("running");
    await f.add();
    expect(process.exitCode).toBeUndefined();
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.lifecycleDeps.spawn).not.toHaveBeenCalled();
    expect(f.preflightExec).not.toHaveBeenCalled();
  });

  it.each(["OPENRIG_URL", "RIGGED_URL"])("does not auto-start for an explicit %s endpoint", async (key) => {
    vi.stubEnv(key, "http://127.0.0.1:42762");
    const f = fixture();
    await f.add();
    expect(process.exitCode).toBe(1);
    expect(f.lifecycleDeps.spawn).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([
    ["OPENRIG_HOST", false], ["OPENRIG_HOST", true],
    ["RIGGED_HOST", false], ["RIGGED_HOST", true],
    ["config-file", false], ["config-file", true],
  ] as const)("remote selection %s with stale state=%s does not spawn locally", async (source, stale) => {
    vi.stubEnv("OPENRIG_HOST", "");
    if (source === "config-file") {
      mkdirSync(join(root, "state"), { recursive: true });
      writeFileSync(join(root, "state", "config.json"), JSON.stringify({ daemon: { host: "remote.example.invalid" } }));
    } else {
      vi.stubEnv(source, "remote.example.invalid");
    }
    const f = fixture("stopped", stale);
    await f.add();
    expect(f.lifecycleDeps.spawn).not.toHaveBeenCalled();
    expect(f.preflightExec).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("preserves an unverified daemon result without spawning a replacement", async () => {
    const f = fixture("unknown");
    await f.add();
    expect(process.exitCode).toBe(1);
    expect(f.lifecycleDeps.spawn).not.toHaveBeenCalled();
  });

  it("keeps preflight failures visible and does not spawn", async () => {
    const f = fixture();
    f.preflightExec.mockRejectedValue(new Error("tmux missing"));
    await f.add();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("tmux was not found");
    expect(f.lifecycleDeps.spawn).not.toHaveBeenCalled();
  });

  it("leaves the daemon-free trace command independent", async () => {
    const f = fixture();
    await f.command().parseAsync(["node", "rig", "context", "trace", "--rig", "missing-fixture", "--name", "NOTES.md"]);
    expect(f.lifecycleDeps.fetch).not.toHaveBeenCalled();
    expect(f.lifecycleDeps.spawn).not.toHaveBeenCalled();
  });
});
