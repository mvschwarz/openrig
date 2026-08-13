// OPR.0.4.1.11.3a — visual slices need an intent-visual slot in the
// generated IMPL-PRD/slice scaffold so builders see the approved target.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-intent-"));
}

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  fs.mkdirSync(path.join(missionsRoot, "release-0.4.1"), { recursive: true });
  fs.writeFileSync(
    path.join(missionsRoot, "release-0.4.1", "README.md"),
    "---\nid: OPR.0.4.1\nstage: wip\n---\n# release-0.4.1\n",
    "utf8",
  );
  return { root, missionsRoot };
}

async function run(args: string[], workspace: string): Promise<{ exitCode: number; stdout: string }> {
  const stdoutBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", path.dirname(workspace)]);
  } catch {
    // Commander/process.exit paths are captured above.
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join("") };
}

describe("OPR.0.4.1.11.3a intent visual scaffold slot", () => {
  let substrate: { root: string; missionsRoot: string };

  beforeEach(() => { substrate = seedSubstrate(); });
  afterEach(() => { fs.rmSync(substrate.root, { recursive: true, force: true }); });

  it("slice create emits the intent image, durable diff, and twin rebuild command", async () => {
    const r = await run(["slice", "create", "release-0.4.1", "visual-slot", "--json"], substrate.missionsRoot);

    expect(r.exitCode).toBe(0);
    const readmePath = path.join(JSON.parse(r.stdout).slice.path, "SPEC.md");
    const readme = fs.readFileSync(readmePath, "utf8");

    expect(readme).toContain("## Intent visual");
    expect(readme).toContain("![Intent visual](./intent.png)");
    expect(readme).toContain("[change.diff](./change.diff)");
    expect(readme).toContain("TWIN_ROUTE=<route> npm run twin:build");
    expect(readme).toContain("twin-out/intent.html");
    expect(readme).toContain("Non-visual slices: mark this section N/A.");
  });
});
