import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { wantsJsonOutput, runProgram } from "../src/cli-error.js";

describe("JSON output selection respects the operand boundary", () => {
  it("does not treat literal message text after -- as output options", () => {
    expect(wantsJsonOutput(["send", "seat@rig", "--", "--json"])).toBe(false);
    expect(wantsJsonOutput(["send", "seat@rig", "--", "--format", "json"])).toBe(false);
    expect(wantsJsonOutput(["send", "seat@rig", "--", "--output=json"])).toBe(false);
  });
  it("retains explicit output options before --", () => {
    expect(wantsJsonOutput(["send", "--json", "seat@rig", "--", "text"])).toBe(true);
    expect(wantsJsonOutput(["send", "-o", "json", "--", "text"])).toBe(true);
  });
});

it("reports a real Commander action failure as text when --json is message content", async () => {
  const program = new Command("rig");
  const messages: string[] = [];
  program.command("send").argument("<seat>").argument("<message>").option("--json")
    .action((_seat: string, message: string) => {
      messages.push(message);
      throw new Error("fixture delivery failed");
    });
  const out: string[] = [], err: string[] = [], exits: number[] = [];
  expect(await runProgram(program, ["node", "rig", "send", "seat@rig", "--", "--json"], {
    out: (text) => out.push(text), err: (text) => err.push(text), exit: (code) => { exits.push(code); },
  })).toBe(1);
  expect(messages).toEqual(["--json"]);
  expect(out).toEqual([]);
  expect(err).toEqual(["error: fixture delivery failed"]);
  expect(exits).toEqual([1]);
});
