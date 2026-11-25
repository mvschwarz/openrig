// Commands that accept --json report an unreachable daemon as JSON on stdout,
// the same way `rig archive --json` does (#3405).
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";
import { addMemberCommand } from "../src/commands/add.js";
import { agentCommand } from "../src/commands/agent.js";
import { createCommand } from "../src/commands/create.js";
import { expandCommand } from "../src/commands/expand.js";
import { forkCommand } from "../src/commands/fork.js";
import { growCommand } from "../src/commands/grow.js";
import { importCommand } from "../src/commands/import.js";
import { reconcileSessionCommand } from "../src/commands/reconcile-session.js";
import { restoreCommand } from "../src/commands/restore.js";
import { rigCommand } from "../src/commands/rig.js";
import { seatCommand } from "../src/commands/seat.js";
import { skillCommand } from "../src/commands/skill.js";

function unreachableDaemonDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => {
      throw new Error("connection refused");
    }),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => false),
  };
}

const specPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "openrig-json-guard-")), "spec.yaml");
fs.writeFileSync(specPath, "name: demo\n");

type Factory = (deps: never) => Command;
const cases: Array<[string, Factory, string[]]> = [
  ["add", addMemberCommand as Factory, ["add", "demo", "dev", specPath]],
  ["agent validate", agentCommand as Factory, ["agent", "validate", specPath]],
  ["create", createCommand as Factory, ["create", "demo", "--runtime", "claude-code", "--cwd", "/tmp"]],
  ["expand", expandCommand as Factory, ["expand", "demo", specPath]],
  ["fork", forkCommand as Factory, ["fork", "impl@demo", "--rig", "demo", "--pod", "dev", "--member", "impl2"]],
  ["grow", growCommand as Factory, ["grow", "demo", "impl2"]],
  ["import --materialize-only", importCommand as Factory, ["import", specPath, "--materialize-only"]],
  ["reconcile-session", reconcileSessionCommand as Factory, ["reconcile-session", "impl@demo"]],
  ["restore status", restoreCommand as Factory, ["restore", "status", "attempt-1", "--rig", "demo"]],
  ["spec show", rigCommand as Factory, ["spec", "show", "demo"]],
  ["spec preflight", rigCommand as Factory, ["spec", "preflight", specPath]],
  ["seat history", seatCommand as Factory, ["seat", "history", "--rig", "demo", "--node-id", "node-1"]],
  ["seat retire-held-message", seatCommand as Factory, ["seat", "retire-held-message", "impl@demo", "msg-1", "--reason", "test"]],
  ["seat status", seatCommand as Factory, ["seat", "status", "impl@demo"]],
  ["seat switch-client", seatCommand as Factory, ["seat", "switch-client", "impl@demo"]],
  ["seat clear-attention", seatCommand as Factory, ["seat", "clear-attention", "impl@demo"]],
  ["seat effort", seatCommand as Factory, ["seat", "effort", "impl@demo"]],
  ["seat runtime-home", seatCommand as Factory, ["seat", "runtime-home", "impl@demo"]],
  ["seat set-resume-token", seatCommand as Factory, ["seat", "set-resume-token", "impl@demo", "--token-stdin", "--reason", "test"]],
  ["skill audit", skillCommand as Factory, ["skill", "audit"]],
];

describe("--json when the daemon cannot be reached", () => {
  it.each(cases)("%s prints the guard error as JSON and exits 1", async (_name, makeCommand, argv) => {
    const clientFactory = vi.fn();
    const program = new Command();
    program.exitOverride();
    program.addCommand(makeCommand({
      lifecycleDeps: unreachableDaemonDeps(),
      clientFactory,
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readStdin: async () => "token",
    } as never));
    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { stdout.push(args.join(" ")); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    let exitCode: number | string | undefined;
    try {
      await program.parseAsync(["node", "rig", ...argv, "--json"]);
    } finally {
      exitCode = process.exitCode;
      process.exitCode = previousExitCode;
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      error: { fact: expect.any(String), consequence: expect.any(String), action: expect.any(String) },
    });
  });
});
