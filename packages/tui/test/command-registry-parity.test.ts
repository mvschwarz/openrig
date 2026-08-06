// REGISTRY I1 (ruling 64f1dbdf, PM pin 1) — the PARITY SUITE: an action that is not
// registered cannot exist. RED-first: this file imported the registry before it existed.
import { describe, it, expect } from "vitest";
import { COMMAND_REGISTRY, type CommandEntry } from "../src/commands/registry.js";
import { parseCommand } from "../src/grammar.js";

describe("command registry — sole source (PM pin 1: parity fails CI at introduction)", () => {
  it("every registry entry parses to a NON-error action via its sample invocation", () => {
    for (const entry of COMMAND_REGISTRY) {
      const action = parseCommand(entry.sample);
      expect(action.type, `${entry.name} sample '${entry.sample}'`).not.toBe("error");
    }
  });

  it("every entry carries the full contract: name, aliases, args, description, context", () => {
    for (const e of COMMAND_REGISTRY) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(Array.isArray(e.aliases)).toBe(true);
      expect(typeof e.args).toBe("string");
      expect(e.description.length).toBeGreaterThan(0);
      expect(["standard", "always"]).toContain(e.context);
    }
  });

  it("aliases are first-class: an alias parses to the SAME action as the canonical name (byte-equal)", () => {
    for (const e of COMMAND_REGISTRY) {
      for (const alias of e.aliases) {
        const aliasSample = e.sample.replace(new RegExp(`^${e.name}`), alias);
        expect(parseCommand(aliasSample), `${e.name} alias ${alias}`).toEqual(parseCommand(e.sample));
      }
    }
  });

  it("PARITY: every verb the grammar accepts IS a registered command (no unregistered verb parses)", () => {
    // A verb outside the registry must produce the error action — enforcement by construction.
    expect(parseCommand("definitely-unregistered-verb x").type).toBe("error");
    // The registry names ride the grammar's own error listing (serialized, never hand-maintained).
    const err = parseCommand("definitely-unregistered-verb x");
    if (err.type === "error") {
      for (const e of COMMAND_REGISTRY.filter((x: CommandEntry) => !x.prefix)) {
        expect(err.message).toContain(e.name);
      }
    }
  });

  it("P10 teaching migrant: `graph` is a REGISTERED command whose action equals `tab graph`", () => {
    const entry = COMMAND_REGISTRY.find((e: CommandEntry) => e.name === "graph");
    expect(entry).toBeDefined();
    expect(parseCommand("graph")).toEqual(parseCommand("tab graph"));
    expect(entry!.description).toMatch(/graph/i);
  });
});
