import { describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";
import { COMMAND_LOADERS, createLazyProgram } from "../src/lazy-program.js";

describe("lazy-program", () => {
  const full = createProgram();

  it("exposes the community-harness command in eager and lazy help without an old-name alias", async () => {
    const oldName = ["agent", "app"].join("-");
    expect(COMMAND_LOADERS.has("community-harness")).toBe(true);
    expect(COMMAND_LOADERS.has(oldName)).toBe(false);
    expect(full.helpInformation()).toContain("community-harness");
    expect(full.helpInformation()).not.toContain(oldName);
    const lazy = await createLazyProgram("community-harness");
    expect(lazy?.commands[0]?.commands.map(command => command.name())).toEqual(["list"]);
    expect(lazy?.commands[0]?.helpInformation()).toContain("Community harnesses");
    expect(full.commands.map(command => command.name()).filter(name => name === "community-harness")).toHaveLength(1);
  });

  it("names every top-level command of createProgram, in its order", () => {
    expect([...COMMAND_LOADERS.keys()]).toEqual(full.commands.map((c) => c.name()));
  });

  it("builds, for each name, the same command as createProgram", async () => {
    for (const expected of full.commands) {
      const program = await createLazyProgram(expected.name());
      expect(program?.commands).toHaveLength(1);
      const [command] = program!.commands;
      expect(command.name()).toBe(expected.name());
      expect(command.helpInformation()).toBe(expected.helpInformation());
      expect(command.commands.map((c) => c.name())).toEqual(expected.commands.map((c) => c.name()));
    }
  });

  // `--help` lists each subcommand with its description; without one it shows a blank summary.
  it("gives every command a help summary", () => {
    const blank: string[] = [];
    const walk = (command: typeof full, path: string): void => {
      for (const child of command.commands) {
        const childPath = `${path} ${child.name()}`;
        if (!child.description().trim()) blank.push(childPath);
        walk(child, childPath);
      }
    };
    walk(full, "rig");
    expect(blank).toEqual([]);
  });

  it("keeps the root's name, description and version", async () => {
    const program = await createLazyProgram("--version");
    expect(program?.name()).toBe(full.name());
    expect(program?.description()).toBe(full.description());
    expect(program?.version()).toBe(full.version());
    expect(program?.commands).toHaveLength(0);
  });

  it("leaves help, no argument and unknown names to the full program", async () => {
    for (const first of [undefined, "--help", "-h", "help", "queu", "constructor"]) {
      expect(await createLazyProgram(first)).toBeNull();
    }
  });
});
