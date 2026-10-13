import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { doctorCommand } from "../src/commands/doctor.js";

const fixture = vi.hoisted(() => ({ home: "", exec: vi.fn() }));
vi.mock("node:child_process", async () => ({ ...await vi.importActual("node:child_process"), execSync: fixture.exec }));
vi.mock("../src/config-store.js", () => ({ ConfigStore: class {
  resolve() { return { daemon: { host: "127.0.0.1", port: 1 }, db: { path: path.join(fixture.home, "db.sqlite") }, transcripts: { enabled: false, path: path.join(fixture.home, "transcripts") } }; }
} }));
vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  class Socket {
    handlers = new Map<string, () => void>();
    setTimeout() {}
    on(event: string, fn: () => void) { this.handlers.set(event, fn); }
    connect() { this.handlers.get("error")?.(); }
    destroy() {}
  }
  return { ...actual, default: { ...actual, Socket } };
});
const originalExit = process.exitCode;
beforeEach(() => {
  fixture.home = mkdtempSync(path.join(tmpdir(), "openrig-doctor-executor-"));
  vi.stubEnv("OPENRIG_HOME", fixture.home);
  vi.stubEnv("CODEX_HOME", path.join(fixture.home, "codex"));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  vi.spyOn(console, "log").mockImplementation(() => {});
  fixture.exec.mockReset().mockImplementation((command: string, options: { timeout?: number }) => {
    // Deterministic slow-success discriminator: a newly imposed deadline would
    // turn an otherwise successful existing tmux probe into a failure.
    if (command.startsWith("tmux ") && options.timeout !== undefined) throw new Error("ETIMEDOUT: synthetic slow successful probe");
    if (command === "tmux -V") return "tmux 3.4";
    if (command === "tmux show-options -gqv mouse") return "on";
    if (command === "cmux capabilities --json") return '{"capabilities":[]}';
    return "available";
  });
});
afterEach(() => {
  rmSync(fixture.home, { recursive: true, force: true });
  process.exitCode = originalExit;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("doctor default executor", () => {
  it("keeps existing probes unbounded while bounding only the new provider calls", async () => {
    await new Command().addCommand(doctorCommand()).parseAsync(["node", "rig", "doctor", "--json"]);
    const body = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(body.checks.find((check: { name: string }) => check.name === "tmux").status).toBe("pass");
    const calls = fixture.exec.mock.calls as Array<[string, { timeout?: number }]>;
    const prior = calls.filter(([command]) => !/^(claude|codex) /.test(command));
    expect(prior.some(([command]) => command === "tmux list-sessions")).toBe(true);
    expect(prior.every(([,options]) => !Object.hasOwn(options, "timeout"))).toBe(true);
    const auth = calls.filter(([command]) => /^(claude|codex) /.test(command));
    expect(auth.map(([command]) => command)).toEqual(["claude --version", "claude auth status", "codex --version", "codex login status"]);
    expect(auth.every(([,options]) => options.timeout === 30_000)).toBe(true);
  });

  it("explains unused-provider login failures in human output without changing the exit rule", async () => {
    const delegate = fixture.exec.getMockImplementation()!;
    fixture.exec.mockImplementation((command: string, options: { timeout?: number }) => {
      if (command === "codex login status") throw new Error("Not logged in");
      return delegate(command, options);
    });
    await new Command().addCommand(doctorCommand()).parseAsync(["node", "rig", "doctor"]);
    const text = vi.mocked(console.log).mock.calls.map(call => call.join(" ")).join("\n");
    expect(text).toContain("[FAIL] codex_auth:");
    expect(text).toContain("Only the harnesses selected for your project need a login; an unused harness does not.");
    expect(process.exitCode).toBe(1);
  });
});
