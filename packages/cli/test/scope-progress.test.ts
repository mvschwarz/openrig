// OPR.0.4.0.33 — `rig scope ... progress` update verb + `... repair`
// backfill, driven end-to-end through the commander tree against a tmp
// substrate fixture.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-prog-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  fs.mkdirSync(missionsRoot, { recursive: true });
  writeFile(
    path.join(missionsRoot, "release-0.4.0", "README.md"),
    "---\nid: OPR.0.4.0\nstage: wip\n---\n# release-0.4.0\n",
  );
  return { root, missionsRoot };
}

interface CaptureResult { exitCode: number; stdout: string; stderr: string; }

async function run(args: string[], workspace: string): Promise<CaptureResult> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", path.dirname(workspace)]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) stderrBuf.push(msg + "\n");
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") };
}

/** Create a slice via the CLI and return its absolute path. */
async function createSlice(env: { missionsRoot: string }, slug: string, extra: string[] = []): Promise<string> {
  const r = await run(["slice", "create", "release-0.4.0", slug, ...extra, "--json"], env.missionsRoot);
  return JSON.parse(r.stdout).slice.path as string;
}

describe("rig scope slice progress (FR-3 add/set)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("--add appends a UI-valid checkbox row into the default Rail section", async () => {
    const slicePath = await createSlice(env, "verb-add");
    const r = await run(["slice", "progress", slicePath, "--add", "Guard approved", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/## Rail\n\n- \[ \] Guard approved/);
    // H1 title source preserved.
    expect(progress).toMatch(/^# Progress —/m);
  });

  it("--add --section targets an existing section; --status sets the indicator", async () => {
    const slicePath = await createSlice(env, "verb-section");
    const r = await run([
      "slice", "progress", slicePath,
      "--add", "QA passed", "--section", "Acceptance", "--status", "done", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/## Acceptance[\s\S]*- \[x\] QA passed/);
    expect(progress).not.toMatch(/## Acceptance[\s\S]*## Acceptance/); // no duplicate section
  });

  it("--set rewrites an existing row's status; idempotent re-run is a no-op", async () => {
    const slicePath = await createSlice(env, "verb-set");
    const first = await run([
      "slice", "progress", slicePath, "--set", "Implementation complete", "--status", "done", "--json",
    ], env.missionsRoot);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).progress.changed).toBe(true);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    expect(progress).toContain("- [x] Implementation complete");

    const again = await run([
      "slice", "progress", slicePath, "--set", "Implementation complete", "--status", "done", "--json",
    ], env.missionsRoot);
    expect(JSON.parse(again.stdout).progress.changed).toBe(false);
  });

  it("--add is idempotent: the same row twice does not duplicate", async () => {
    const slicePath = await createSlice(env, "verb-idem");
    await run(["slice", "progress", slicePath, "--add", "Once", "--json"], env.missionsRoot);
    await run(["slice", "progress", slicePath, "--add", "Once", "--json"], env.missionsRoot);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    const occurrences = progress.split("- [ ] Once").length - 1;
    expect(occurrences).toBe(1);
  });

  it("errors when neither --add nor --set is given", async () => {
    const slicePath = await createSlice(env, "verb-neither");
    const r = await run(["slice", "progress", slicePath, "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("errors when BOTH --add and --set are given", async () => {
    const slicePath = await createSlice(env, "verb-both");
    const r = await run([
      "slice", "progress", slicePath, "--add", "x", "--set", "y", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("rejects an unknown --status value", async () => {
    const slicePath = await createSlice(env, "verb-badstatus");
    const r = await run([
      "slice", "progress", slicePath, "--add", "x", "--status", "wip", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("edits the README rail for a readme-only slice (not a PROGRESS.md)", async () => {
    const slicePath = await createSlice(env, "verb-readme-only", ["--readme-only"]);
    expect(fs.existsSync(path.join(slicePath, "PROGRESS.md"))).toBe(false);
    const r = await run(["slice", "progress", slicePath, "--add", "Rail item", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(slicePath, "PROGRESS.md"))).toBe(false); // still no PROGRESS.md
    const readme = fs.readFileSync(path.join(slicePath, "README.md"), "utf8");
    expect(readme).toMatch(/## Rail\n\n- \[ \] Rail item/);
    expect(readme).toMatch(/progress_rail:\s*readme-only/); // frontmatter preserved
  });

  it("errors when the scope has no progress surface (stale-host ghost)", async () => {
    // A slice dir with a README but no PROGRESS.md and no readme-only
    // marker — the founder-reported stale-host artifact shape.
    const ghost = path.join(env.missionsRoot, "release-0.4.0", "slices", "02-ghost");
    writeFile(path.join(ghost, "README.md"), "---\nid: OPR.0.4.0.2\n---\n# ghost\n");
    const r = await run(["slice", "progress", ghost, "--add", "x", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.action).toMatch(/repair|create/);
  });
});

describe("rig scope mission progress (FR-3)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("--add updates the mission PROGRESS.md", async () => {
    // Backfill the mission PROGRESS.md first (the seed mission has none).
    await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    const r = await run([
      "mission", "progress", "release-0.4.0", "--add", "Mission milestone", "--section", "Milestones", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const progress = fs.readFileSync(path.join(env.missionsRoot, "release-0.4.0", "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/## Milestones[\s\S]*- \[ \] Mission milestone/);
  });
});

describe("rig scope repair (FR-6 backfill)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("mission repair backfills a missing PROGRESS.md; re-run is a no-op", async () => {
    const progressPath = path.join(env.missionsRoot, "release-0.4.0", "PROGRESS.md");
    expect(fs.existsSync(progressPath)).toBe(false);
    const first = await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    expect(first.exitCode).toBe(0);
    expect(fs.existsSync(progressPath)).toBe(true);
    const content = fs.readFileSync(progressPath, "utf8");
    expect(content).toMatch(/^# Progress —/m);

    const second = await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    const parsed = JSON.parse(second.stdout);
    expect(parsed.created.length).toBe(0); // nothing new
    expect(fs.readFileSync(progressPath, "utf8")).toBe(content); // unchanged
  });

  it("mission repair backfills PROGRESS-less slices but skips readme-only ones", async () => {
    // A stale-host ghost slice (README, no PROGRESS, no marker).
    const ghost = path.join(env.missionsRoot, "release-0.4.0", "slices", "02-ghost");
    writeFile(path.join(ghost, "README.md"), "---\nid: OPR.0.4.0.2\n---\n# ghost\n");
    // An intentional readme-only slice.
    await createSlice(env, "small-one", ["--readme-only"]);

    const r = await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    // Ghost slice got a PROGRESS.md.
    expect(fs.existsSync(path.join(ghost, "PROGRESS.md"))).toBe(true);
    // readme-only slice was NOT forced a PROGRESS.md.
    const readmeOnlySlice = path.join(env.missionsRoot, "release-0.4.0", "slices");
    const roDir = fs.readdirSync(readmeOnlySlice).find((d) => d.includes("small-one"))!;
    expect(fs.existsSync(path.join(readmeOnlySlice, roDir, "PROGRESS.md"))).toBe(false);
  });

  it("slice repair backfills a single PROGRESS-less slice", async () => {
    const ghost = path.join(env.missionsRoot, "release-0.4.0", "slices", "03-lonely");
    writeFile(path.join(ghost, "README.md"), "---\nid: OPR.0.4.0.3\n---\n# lonely\n");
    const r = await run(["slice", "repair", ghost, "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).result.created).toBe(true);
    expect(fs.existsSync(path.join(ghost, "PROGRESS.md"))).toBe(true);
  });
});
