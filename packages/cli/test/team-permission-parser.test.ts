import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";
import { TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK } from "../../daemon/src/adapters/kernel-authority.js";

const { decide } = createRequire(import.meta.url)(fileURLToPath(new URL("../../daemon/assets/claude-team-permissions.cjs", import.meta.url)));
const policy = { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK };
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "team-permission-parser-"));
  // The shell only records argv. The real CLI parser below has inert actions;
  // neither stage contacts a daemon or performs a lifecycle operation.
  writeFileSync(join(home, "rig"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function parse(command: string) {
  const shell = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
    encoding: "utf8", timeout: 3000,
    env: { PATH: `${home}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
  });
  expect(shell.status, shell.stderr).toBe(0);
  const program = createProgram(), calls: string[] = [];
  let output = "", error: string | undefined;
  const configure = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: text => { output += text; }, writeErr: text => { output += text; } });
    for (const child of cmd.commands) configure(child);
  };
  configure(program);
  program.commands.find(cmd => cmd.name() === "down")!.action(() => { calls.push("down"); });
  program.commands.find(cmd => cmd.name() === "seat")!.commands.find(cmd => cmd.name() === "stop")!
    .action(() => { calls.push("seat stop"); });
  try { await program.parseAsync(JSON.parse(shell.stdout), { from: "user" }); }
  catch (e) { error = (e as { code?: string }).code; }
  return { calls, output, error, decision: decide(command, policy) };
}

describe("team hook agrees with real CLI dispatch", () => {
  it.each([
    "rig down example", "rig -- down example",
    "rig -- down --help", "rig -- down -h",
    "command rig down example", "nice -n 5 rig down example",
    "if true; then rig down example; fi", "for s in example; do rig down $s; done",
    "{ rig down example; }", "rig down -- --help",
    "rig seat stop example@demo --reason --help",
  ])("asks when the action really dispatches: %s", async command => {
    const observed = await parse(command);
    expect(observed.error).toBeUndefined(); expect(observed.calls).toHaveLength(1);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    ["rig seat -- stop example@demo --reason maintenance", "commander.missingMandatoryOptionValue"],
    ["rig -- down --help example", "commander.excessArguments"],
  ])("keeps invalid separator forms conservative: %s", async (command, error) => {
    const observed = await parse(command);
    expect(observed.error).toBe(error); expect(observed.calls).toEqual([]);
    expect(observed.decision).toBe("ask");
  });
  it.each([
    "rig down example --help", "rig down --help example", "rig down -h example",
    "rig seat stop --help example@demo",
  ])("allows help with no action: %s", async command => {
    const observed = await parse(command);
    expect(observed.error).toBe("commander.helpDisplayed"); expect(observed.calls).toEqual([]);
    expect(observed.output).toContain("Usage:"); expect(observed.decision).toBe("allow");
  });
});
