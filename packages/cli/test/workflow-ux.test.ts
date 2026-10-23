// release-0.3.2 slice 01 (OPR.0.3.2.1) — GA-polish coverage for the
// rig workflow command surface.
//
// Scope: static --help + description coverage; the what/state/next
// summary behavior is verified at the building-block level via
// printOutcomeSummary unit tests (exported for this purpose), since
// the live action path is gated by getDaemonStatus and tested at the
// integration tier elsewhere.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  workflowCommand,
  printOutcomeSummary,
  type OutcomeSummary,
} from "../src/commands/workflow.js";

describe("rig workflow --help carries examples on every command (HG-4)", () => {
  const expectedVerbs = [
    "validate",
    "instantiate",
    "project",
    "list",
    "specs",
    "show",
    "trace",
    "continue",
    "revise",
  ];

  // Commander v13 attaches `addHelpText('after', ...)` as a listener
  // that fires when --help is rendered; `helpInformation()` returns
  // Usage+Options+Subcommands but NOT the after-text. Source-scan the
  // command file to prove every verb carries an Examples block —
  // catches drift if a future refactor drops `addHelpText` from one
  // verb but leaves the others.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workflowSrc = readFileSync(
    path.resolve(here, "../src/commands/workflow.ts"),
    "utf8",
  );

  for (const verb of expectedVerbs) {
    it(`${verb} has an addHelpText('after', ...) block with an Examples section`, () => {
      const root = workflowCommand();
      const sub = root.commands.find((c) => c.name() === verb);
      expect(sub, `verb ${verb} should be registered`).toBeTruthy();
      // Source-scan: locate the command(...) declaration and look
      // for an Examples block in the addHelpText that follows.
      const verbBlockRe = new RegExp(
        `\\.command\\("${verb}[ "(<]([\\s\\S]*?)\\.action\\(`,
        "m",
      );
      const match = verbBlockRe.exec(workflowSrc);
      expect(match, `couldn't locate builder for "${verb}"`).toBeTruthy();
      const block = match![0];
      expect(block).toMatch(/\.addHelpText\("after",/);
      expect(block).toMatch(/Examples?:/i);
      expect(block).toMatch(/\$ rig workflow /); // at least one concrete example invocation
    });
  }

  it("every verb has a non-empty description", () => {
    const root = workflowCommand();
    for (const sub of root.commands) {
      expect(
        sub.description().length,
        `verb ${sub.name()} needs a description`,
      ).toBeGreaterThan(0);
    }
  });

  it("the top-level command itself is documented", () => {
    const root = workflowCommand();
    expect(root.description().length).toBeGreaterThan(0);
  });
});

describe("printOutcomeSummary — what/state/next ending (HG-4)", () => {
  function captureStdout(): { logs: string[]; restore: () => void } {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    return { logs, restore: () => { console.log = original; } };
  }

  const baseSummary: OutcomeSummary = {
    what: "Closed QITEM-123 (handoff) and projected QITEM-456 to velocity-qa@openrig-velocity",
    state: "instance WF01ABC = active",
    next: "Inspect: rig queue show QITEM-456",
  };

  it("emits 4 lines (blank + what + state + next) in human mode on success", () => {
    const out = captureStdout();
    printOutcomeSummary(false, 200, baseSummary);
    out.restore();
    const joined = out.logs.join("\n");
    expect(joined).toMatch(/what:\s+Closed QITEM-123/);
    expect(joined).toMatch(/state:\s+instance WF01ABC = active/);
    expect(joined).toMatch(/next:\s+Inspect: rig queue show QITEM-456/);
    // Blank separator line precedes the summary.
    expect(out.logs[0]).toBe("");
  });

  it("suppresses output in --json mode (machine consumers stay clean)", () => {
    const out = captureStdout();
    printOutcomeSummary(true, 200, baseSummary);
    out.restore();
    expect(out.logs.length).toBe(0);
  });

  it("suppresses output when status >= 400 (error path uses its own surface)", () => {
    const out = captureStdout();
    printOutcomeSummary(false, 500, baseSummary);
    out.restore();
    expect(out.logs.length).toBe(0);
  });

  it("suppresses output when summary is null", () => {
    const out = captureStdout();
    printOutcomeSummary(false, 200, null);
    out.restore();
    expect(out.logs.length).toBe(0);
  });
});
