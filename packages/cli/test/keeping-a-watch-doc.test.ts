import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";

// OPR.0.7.0.3: docs/reference/keeping-a-watch.md teaches an operator to keep a person's watch with
// today's commands. This guards the page against CLI drift: every `rig ...` command it names must
// resolve to a real subcommand, and every option it uses must be declared on that subcommand.
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/reference/keeping-a-watch.md");

function commandsInPage(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of markdown.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const joined = block[1]!.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) if (line.trim().startsWith("rig ")) commands.push(line.trim());
  }
  for (const inline of markdown.matchAll(/`(rig [^`]+)`/g)) commands.push(inline[1]!);
  return commands;
}

function resolve(program: Command, command: string): { sub: Command; options: string[] } {
  // Drop quoted arguments so their words aren't read as subcommands or options.
  const tokens = command.replace(/"[^"]*"/g, "ARG").split(/\s+/).slice(1);
  let sub = program;
  let i = 0;
  for (; i < tokens.length; i++) {
    const next = sub.commands.find((c) => c.name() === tokens[i]);
    if (!next) break;
    sub = next;
  }
  return { sub, options: tokens.slice(i).filter((t) => t.startsWith("-")) };
}

describe("keeping-a-watch reference page", () => {
  const page = readFileSync(PAGE, "utf8");
  const commands = commandsInPage(page);
  const program = createProgram();

  it("names the commands the watch pattern relies on", () => {
    const names = commands.map((c) => resolve(program, c).sub.name());
    for (const needed of ["create", "block", "show", "update", "list"]) expect(names).toContain(needed);
  });

  it.each(commands)("%s resolves to a real subcommand with declared options", (command) => {
    const { sub, options } = resolve(program, command);
    expect(sub, command).not.toBe(program);
    expect(sub.commands.length, `${command} stops at a command group`).toBe(0);
    const declared = new Set(sub.options.flatMap((o) => [o.long, o.short].filter(Boolean)));
    for (const option of options) expect(declared, `${command}: ${option}`).toContain(option.split("=")[0]);
  });
});
