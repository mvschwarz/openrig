// OPR.0.4.0.33 FR-5 — create writes convention-correct README
// frontmatter. scope-and-versioning §2 makes BOTH `stage` and `verified`
// mandatory (a bare `created:` is explicitly NOT an epistemic signal).
// Pre-slice-33 templates carried `stage` but omitted `verified`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";
import { readFrontmatter } from "../src/lib/scope/scope-fs.js";

function mktemp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-fm-")); }

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  fs.mkdirSync(missionsRoot, { recursive: true });
  fs.mkdirSync(path.join(missionsRoot, "release-0.4.0"), { recursive: true });
  fs.writeFileSync(
    path.join(missionsRoot, "release-0.4.0", "README.md"),
    "---\nid: OPR.0.4.0\nstage: wip\n---\n# release-0.4.0\n",
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
  } catch { /* exit captured */ }
  finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join("") };
}

const VERIFIED_RE = /^\d{4}-\d{2}-\d{2} against .+/;

describe("FR-5 — create writes the 2 mandatory frontmatter fields (stage + verified)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("slice create README carries both stage and a provenance-bearing verified", async () => {
    const r = await run(["slice", "create", "release-0.4.0", "fm-slice", "--json"], env.missionsRoot);
    const fm = readFrontmatter(path.join(JSON.parse(r.stdout).slice.path, "README.md"));
    expect(typeof fm.stage).toBe("string");
    expect(typeof fm.verified).toBe("string");
    expect(String(fm.verified)).toMatch(VERIFIED_RE);
  });

  it("mission create README carries both stage and a provenance-bearing verified", async () => {
    const r = await run(["mission", "create", "release-0.5.0", "--json"], env.missionsRoot);
    const fm = readFrontmatter(path.join(JSON.parse(r.stdout).mission.path, "README.md"));
    expect(typeof fm.stage).toBe("string");
    expect(typeof fm.verified).toBe("string");
    expect(String(fm.verified)).toMatch(VERIFIED_RE);
  });

  it("readme-only slice still carries stage + verified alongside the progress_rail marker", async () => {
    const r = await run(["slice", "create", "release-0.4.0", "fm-readme-only", "--readme-only", "--json"], env.missionsRoot);
    const readmePath = path.join(JSON.parse(r.stdout).slice.path, "README.md");
    const fm = readFrontmatter(readmePath);
    expect(fm.progress_rail).toBe("readme-only");
    expect(typeof fm.verified).toBe("string");
    expect(String(fm.verified)).toMatch(VERIFIED_RE);
  });
});
