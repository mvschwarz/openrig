// release-0.3.2 slice 12 — `rig scope` command-surface integration
// tests. Drives the commander tree end-to-end with a tmp substrate
// fixture so every HG-N gate has direct coverage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";
import { readFrontmatter } from "../src/lib/scope/scope-fs.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-cmd-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "t@e.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "T"], { stdio: "ignore" });
  fs.mkdirSync(missionsRoot, { recursive: true });
  writeFile(
    path.join(missionsRoot, "release-0.3.2", "README.md"),
    "---\nid: OPR.0.3.2\n---\n# release-0.3.2\n",
  );
  writeFile(
    path.join(missionsRoot, "release-0.3.2", "slices", "01-existing", "README.md"),
    "---\nid: OPR.0.3.2.1\nstatus: active\n---\n# existing\n",
  );
  writeFile(
    path.join(missionsRoot, "backlog", "README.md"),
    "---\nid: OPR.99.0.1\n---\n# backlog\n",
  );
  writeFile(
    path.join(missionsRoot, "backlog", "slices", "01-debt-foo", "README.md"),
    "---\nid: OPR.99.0.1.1\nstatus: active\n---\n# debt\n",
  );
  execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", "seed", "-q"], { stdio: "ignore" });
  return { root, missionsRoot };
}

interface CaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], workspace: string): Promise<CaptureResult> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__EXIT__${exitCode}`);
  }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", path.dirname(workspace)]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) {
      stderrBuf.push(msg + "\n");
    }
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return {
    exitCode,
    stdout: stdoutBuf.join(""),
    stderr: stderrBuf.join(""),
  };
}

// ---------------------------------------------------------------------
// HG-1 + HG-9: rig scope slice ls --json + state filter
// ---------------------------------------------------------------------

describe("rig scope slice ls", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("HG-1 + HG-9: --json returns active slices from a specific mission", async () => {
    const r = await run(["slice", "ls", "--mission", "release-0.3.2", "--state", "active", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.slices.map((s: { name: string }) => s.name)).toEqual(["01-existing"]);
    expect(parsed.slices[0].id).toBe("OPR.0.3.2.1");
  });

  it("returns slices from all missions when --mission is omitted", async () => {
    const r = await run(["slice", "ls", "--json"], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.count).toBe(2);
  });
});

// ---------------------------------------------------------------------
// HG-2: rig scope slice show
// ---------------------------------------------------------------------

describe("rig scope slice show (HG-2)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("renders frontmatter + README + children", async () => {
    const r = await run([
      "slice", "show", "01-existing",
      "--mission", "release-0.3.2",
      "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.slice.id).toBe("OPR.0.3.2.1");
    expect(parsed.slice.readme).toContain("# existing");
  });
});

// ---------------------------------------------------------------------
// HG-3 + HG-4 + HG-15: rig scope slice create
// ---------------------------------------------------------------------

describe("rig scope slice create", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("HG-3: auto-finds next NN, never reuses numbers", async () => {
    // Add a closed slice 04 so existing NNs are 01 + 04. Next must be 05.
    writeFile(
      path.join(env.missionsRoot, "release-0.3.2", "closed", "04-old", "README.md"),
      "---\nid: OPR.0.3.2.4\nstatus: closed-stale\n---\n",
    );
    const r = await run([
      "slice", "create", "release-0.3.2", "new-thing", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.slice.name).toMatch(/^05-/);
  });

  it("HG-4: --template populates the template", async () => {
    const r = await run([
      "slice", "create", "release-0.3.2", "perf-fix",
      "--template", "bug-fix", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    const readme = fs.readFileSync(path.join(parsed.slice.path, "README.md"), "utf8");
    expect(readme).toMatch(/## Repro/);
    expect(readme).toMatch(/## Expected/);
  });

  it("HG-15: created slice frontmatter has a conformant dot-ID", async () => {
    const r = await run([
      "slice", "create", "release-0.3.2", "tdd-foo", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    const fm = readFrontmatter(path.join(parsed.slice.path, "README.md"));
    expect(fm.id).toBe("OPR.0.3.2.2");
    expect(typeof fm.id === "string" && /^OPR\.0\.3\.2\.\d+$/.test(fm.id as string)).toBe(true);
  });

  it("AC-1: slice create scaffolds PROGRESS.md by default", async () => {
    const r = await run([
      "slice", "create", "release-0.3.2", "scaffold-test", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    const progressPath = path.join(parsed.slice.path, "PROGRESS.md");
    expect(fs.existsSync(progressPath)).toBe(true);
    const content = fs.readFileSync(progressPath, "utf8");
    expect(content).toContain("# Progress");
    expect(content).toContain("Implementation complete");
  });

  it("AC-1: slice create --readme-only writes marker instead of PROGRESS.md", async () => {
    const r = await run([
      "slice", "create", "release-0.3.2", "no-progress", "--readme-only", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    const progressPath = path.join(parsed.slice.path, "PROGRESS.md");
    expect(fs.existsSync(progressPath)).toBe(false);
    const readme = fs.readFileSync(path.join(parsed.slice.path, "README.md"), "utf8");
    expect(readme).toMatch(/progress_rail:\s*readme-only/);
  });
});

// ---------------------------------------------------------------------
// HG-5 + HG-9: rig scope slice ship — git mv + frontmatter update
// ---------------------------------------------------------------------

describe("rig scope slice ship (HG-5)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("git mv + frontmatter status: shipped-to-release-X.Y", async () => {
    const r = await run([
      "slice", "ship", "01-debt-foo", "release-0.3.2",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.shipped.git.usedGit).toBe(true);
    // Source removed; target present.
    expect(fs.existsSync(path.join(env.missionsRoot, "backlog", "slices", "01-debt-foo"))).toBe(false);
    expect(fs.existsSync(parsed.shipped.to.path)).toBe(true);
    const fm = readFrontmatter(path.join(parsed.shipped.to.path, "README.md"));
    expect(fm.status).toBe("shipped-to-release-0.3.2");
    expect(fm.mission).toBe("release-0.3.2");
  });
});

// ---------------------------------------------------------------------
// HG-6: rig scope slice close --reason
// ---------------------------------------------------------------------

describe("rig scope slice close (HG-6)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("moves to closed/ + sets status: closed-<reason>", async () => {
    const r = await run([
      "slice", "close", "01-debt-foo",
      "--mission", "backlog",
      "--reason", "wontfix",
      "--note", "obsolete by design",
      "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(path.join(env.missionsRoot, "backlog", "slices", "01-debt-foo"))).toBe(false);
    expect(fs.existsSync(path.join(env.missionsRoot, "backlog", "closed", "01-debt-foo"))).toBe(true);
    const fm = readFrontmatter(path.join(env.missionsRoot, "backlog", "closed", "01-debt-foo", "README.md"));
    expect(fm.status).toBe("closed-wontfix");
    expect(fm["closure-note"]).toBe("obsolete by design");
  });

  it("rejects unknown --reason values", async () => {
    const r = await run([
      "slice", "close", "01-debt-foo",
      "--mission", "backlog",
      "--reason", "fishy",
      "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------
// HG-7: rig scope slice move
// ---------------------------------------------------------------------

describe("rig scope slice move (HG-7)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("moves between missions; auto-renumber; frontmatter.mission updates", async () => {
    const r = await run([
      "slice", "move", "01-debt-foo", "release-0.3.2",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.moved.to.name).toMatch(/^02-/); // 01 was taken
    expect(parsed.moved.to.id).toBe("OPR.0.3.2.2");
    const fm = readFrontmatter(path.join(parsed.moved.to.path, "README.md"));
    expect(fm.mission).toBe("release-0.3.2");
  });
});

// ---------------------------------------------------------------------
// HG-8: rig scope mission ls
// ---------------------------------------------------------------------

describe("rig scope mission ls (HG-8)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("--json lists missions with id + slice counts", async () => {
    const r = await run(["mission", "ls", "--json"], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    const names = parsed.missions.map((m: { name: string }) => m.name).sort();
    expect(names).toEqual(["backlog", "release-0.3.2"]);
  });
});

describe("rig scope mission show", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("renders frontmatter + README + slice inventory", async () => {
    const r = await run(["mission", "show", "release-0.3.2", "--json"], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mission.id).toBe("OPR.0.3.2");
    expect(parsed.mission.slices.length).toBe(1);
  });
});

// ---------------------------------------------------------------------
// HG-14 + HG-15: rig scope mission create (PROMOTED to v0 per Amendment §B)
// ---------------------------------------------------------------------

describe("rig scope mission create (HG-14 + HG-15)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("HG-14: mission create is invocable with the SAME pattern as slice create", async () => {
    // Symmetry test: both verbs take (positional name) + (--template) +
    // (--json) and emit { ok, [tier]: { name, id, template, path } }.
    const r = await run([
      "mission", "create", "release-0.4.0", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.mission.name).toBe("release-0.4.0");
    expect(parsed.mission.path).toBeTruthy();
    expect(parsed.mission.template).toBe("release");
  });

  it("HG-15: created mission frontmatter has a conformant dot-ID per §1", async () => {
    const r = await run(["mission", "create", "release-0.5.0", "--json"], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mission.id).toBe("OPR.0.5.0");
    const fm = readFrontmatter(path.join(parsed.mission.path, "README.md"));
    expect(fm.id).toBe("OPR.0.5.0");
  });

  it("HG-15: non-release names get an escape-band ID (uniform-numeric)", async () => {
    const r = await run([
      "mission", "create", "experiments-foo", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mission.id).toMatch(/^OPR\.99\.0\.\d+$/);
  });

  it("HG-15: accepts an explicit --id override and rejects malformed ones", async () => {
    const ok = await run([
      "mission", "create", "weird-thing",
      "--id", "OPR.99.0.42", "--json",
    ], env.missionsRoot);
    expect(JSON.parse(ok.stdout).mission.id).toBe("OPR.99.0.42");

    const bad = await run([
      "mission", "create", "another-weird-thing",
      "--id", "OPR.A.1", "--json",
    ], env.missionsRoot);
    expect(bad.exitCode).toBe(1);
  });

  it("BLOCK 1 discriminator: mission create rejects slice-depth --id (OPR.0.3.2.12)", async () => {
    // Per guard BC verdict: a 4-segment slice-shape must NOT pass
    // mission --id validation. Without tier-aware validation this
    // would succeed and create a mission with a slice-shaped id.
    const r = await run([
      "mission", "create", "wrong-tier",
      "--id", "OPR.0.3.2.12", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.fact).toMatch(/not a mission-tier dot-ID/);
  });

  it("BLOCK 1 follow-up: mission create still accepts valid mission shapes (escape band + release)", async () => {
    const eb = await run([
      "mission", "create", "exp-band",
      "--id", "OPR.99.0.42", "--json",
    ], env.missionsRoot);
    expect(eb.exitCode).toBe(0);
    expect(JSON.parse(eb.stdout).mission.id).toBe("OPR.99.0.42");

    const rel = await run([
      "mission", "create", "release-0.6.0", "--json",
    ], env.missionsRoot);
    expect(rel.exitCode).toBe(0);
    expect(JSON.parse(rel.stdout).mission.id).toBe("OPR.0.6.0");
  });

  it("BC-2 BLOCK 1 discriminator: rejects escape-band with non-zero middle segment (OPR.99.7.8)", async () => {
    const r = await run([
      "mission", "create", "bad-eb",
      "--id", "OPR.99.7.8", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  // OPR.0.3.2.21.FR-3 — auto-scaffold MISSION_NOTES.md alongside README.
  it("FR-3: mission create auto-scaffolds MISSION_NOTES.md with placeholders substituted (default ON; built-in template)", async () => {
    const r = await run(["mission", "create", "release-0.6.0", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.mission.missionNotesPath).toBeTruthy();
    expect(parsed.mission.missionNotesResolvedFrom).toBe("built-in");
    const mnPath = parsed.mission.missionNotesPath as string;
    expect(fs.existsSync(mnPath)).toBe(true);
    const content = fs.readFileSync(mnPath, "utf8");
    // Placeholders must be substituted.
    expect(content).not.toMatch(/\{\{mission_id\}\}/);
    expect(content).not.toMatch(/\{\{mission_name\}\}/);
    expect(content).not.toMatch(/\{\{created_date\}\}/);
    // Substituted values present.
    expect(content).toMatch(/mission: OPR\.0\.6\.0/);
    // titleFromSlug("0.6.0") → "0.6.0" (no separators to titlecase); the
    // bare version string is what lands in mission_name.
    expect(content).toMatch(/name: 0\.6\.0/);
    expect(content).toMatch(/cont\.0 — mission scaffolded/);
    // Canonical structure markers.
    expect(content).toMatch(/## §1\. Top-of-mind context/);
    expect(content).toMatch(/## §10\. What NOT to reconstruct/);
    expect(content).toMatch(/## §A\. <first-seat>@<rig> notes/);
  });

  it("FR-3: --no-mission-notes opts out — README created, MISSION_NOTES.md is NOT", async () => {
    const r = await run([
      "mission", "create", "release-0.7.0",
      "--no-mission-notes", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    // README still produced.
    expect(fs.existsSync(parsed.mission.readmePath)).toBe(true);
    // MISSION_NOTES suppressed.
    expect(parsed.mission.missionNotesPath).toBeNull();
    expect(parsed.mission.missionNotesResolvedFrom).toBeNull();
    expect(fs.existsSync(path.join(parsed.mission.path, "MISSION_NOTES.md"))).toBe(false);
  });

  it("FR-3: OPENRIG_MISSION_NOTES_TEMPLATE_PATH env var overrides the built-in template", async () => {
    // Write a custom template at a temp path containing a distinctive marker.
    const customTemplatePath = path.join(env.root, "custom-mission-notes-template.md");
    fs.writeFileSync(
      customTemplatePath,
      "---\nmission: {{mission_id}}\n---\n\n# CUSTOM TEMPLATE — {{mission_name}}\n\nCREATED ON {{created_date}}\n",
      "utf8",
    );
    const prior = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
    process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = customTemplatePath;
    try {
      const r = await run(["mission", "create", "release-0.8.0", "--json"], env.missionsRoot);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.mission.missionNotesResolvedFrom).toBe("env");
      const content = fs.readFileSync(parsed.mission.missionNotesPath as string, "utf8");
      expect(content).toMatch(/CUSTOM TEMPLATE — 0\.8\.0/);
      expect(content).toMatch(/mission: OPR\.0\.8\.0/);
      // Built-in canonical sections must NOT appear (proves we used the custom one).
      expect(content).not.toMatch(/## §1\. Top-of-mind context/);
    } finally {
      if (prior === undefined) delete process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
      else process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = prior;
    }
  });

  it("FR-3: OPENRIG_MISSION_NOTES_TEMPLATE_PATH pointing at a missing file fails with a 3-part error and no mission dir leaked", async () => {
    const prior = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
    process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = path.join(env.root, "does-not-exist.md");
    try {
      const r = await run(["mission", "create", "release-0.9.0", "--json"], env.missionsRoot);
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.fact).toMatch(/OPENRIG_MISSION_NOTES_TEMPLATE_PATH/);
      // Discriminator (guard catch qitem-20260601121058): the failed scaffold
      // MUST NOT leave a half-created mission dir behind. Without the
      // verify-first-then-write reorder, the mission dir + README would
      // exist after this command, and a retry would hit
      // "Mission folder already exists." which the operator would
      // reasonably read as a CLI bug.
      const leakedPath = path.join(env.missionsRoot, "release-0.9.0");
      expect(fs.existsSync(leakedPath), `expected no half-created mission at ${leakedPath} after stale env-var failure`).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
      else process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = prior;
    }
  });

  it("AC-1: mission create scaffolds PROGRESS.md by default", async () => {
    const r = await run(["mission", "create", "release-0.6.1", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const progressPath = path.join(parsed.mission.path, "PROGRESS.md");
    expect(fs.existsSync(progressPath)).toBe(true);
    const content = fs.readFileSync(progressPath, "utf8");
    expect(content).toContain("# Progress");
    expect(content).toContain("Scope complete");
  });
});

// ---------------------------------------------------------------------
// BC-2 BLOCK 2: README-less dirs are rejected at every mutation surface
// ---------------------------------------------------------------------

describe("BC-2 BLOCK 2 — README-less dirs are not declared missions at any mutation surface", () => {
  let env: { root: string; missionsRoot: string };

  beforeEach(() => {
    env = seedSubstrate();
    // Sneak a README-less directory into missions/ to verify every
    // surface rejects it consistently with listMissions.
    fs.mkdirSync(path.join(env.missionsRoot, "no-readme"), { recursive: true });
  });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("mission ls omits no-readme (already in HG-8 above; sanity check here)", async () => {
    const r = await run(["mission", "ls", "--json"], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.missions.map((m: { name: string }) => m.name)).not.toContain("no-readme");
  });

  it("mission show no-readme exits 1 with the 3-part 'not a declared mission' error", async () => {
    const r = await run(["mission", "show", "no-readme", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.fact).toMatch(/no README\.md|not a declared mission/);
  });

  it("slice create no-readme exits 1 + does NOT create slices/foo/", async () => {
    const r = await run([
      "slice", "create", "no-readme", "foo", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(path.join(env.missionsRoot, "no-readme", "slices", "01-foo"))).toBe(false);
  });

  it("slice ship to no-readme target exits 1; source slice unmoved", async () => {
    const srcAbs = path.join(env.missionsRoot, "backlog", "slices", "01-debt-foo");
    expect(fs.existsSync(srcAbs)).toBe(true);
    const r = await run([
      "slice", "ship", "01-debt-foo", "no-readme",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    // Source unchanged.
    expect(fs.existsSync(srcAbs)).toBe(true);
  });

  it("slice move to no-readme target exits 1; source slice unmoved", async () => {
    const srcAbs = path.join(env.missionsRoot, "backlog", "slices", "01-debt-foo");
    const r = await run([
      "slice", "move", "01-debt-foo", "no-readme",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(srcAbs)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// BLOCK 3 discriminator: ship + move persist target.id back to target README
// ---------------------------------------------------------------------

describe("BLOCK 3 — ship/move persist target mission id into target README", () => {
  let env: { root: string; missionsRoot: string };

  beforeEach(() => {
    env = seedSubstrate();
    // Replace release-0.3.2/README.md with an ID-LESS variant so we
    // can observe the lazy-adopt-and-persist behavior.
    fs.writeFileSync(
      path.join(env.missionsRoot, "release-0.3.2", "README.md"),
      "# release-0.3.2\n\n(no id frontmatter yet)\n",
      "utf8",
    );
    execFileSync("git", ["-C", env.root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", env.root, "commit", "-m", "strip-target-id", "-q"], { stdio: "ignore" });
  });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("slice ship: target mission gains a persisted id; child id = targetId.NN", async () => {
    const r = await run([
      "slice", "ship", "01-debt-foo", "release-0.3.2",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    // Target README now has id: OPR.0.3.2 written back.
    const targetFm = readFrontmatter(path.join(env.missionsRoot, "release-0.3.2", "README.md"));
    expect(targetFm.id).toBe("OPR.0.3.2");
    // Child id matches parent.NN.
    expect(parsed.shipped.to.id).toBe("OPR.0.3.2.2");
  });

  it("slice move: target mission gains a persisted id; child id = targetId.NN", async () => {
    const r = await run([
      "slice", "move", "01-debt-foo", "release-0.3.2",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    const targetFm = readFrontmatter(path.join(env.missionsRoot, "release-0.3.2", "README.md"));
    expect(targetFm.id).toBe("OPR.0.3.2");
    expect(parsed.moved.to.id).toBe("OPR.0.3.2.2");
  });

  it("sibling missions without id remain UNCHANGED after a ship/move (narrow lazy adoption, not mass-migrate)", async () => {
    // Spawn an unrelated id-less mission alongside; assert it survives
    // untouched through a ship to a different mission.
    fs.mkdirSync(path.join(env.missionsRoot, "untouched-mission"), { recursive: true });
    fs.writeFileSync(
      path.join(env.missionsRoot, "untouched-mission", "README.md"),
      "# untouched\n",
      "utf8",
    );
    execFileSync("git", ["-C", env.root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", env.root, "commit", "-m", "seed-sibling", "-q"], { stdio: "ignore" });
    const before = fs.readFileSync(path.join(env.missionsRoot, "untouched-mission", "README.md"), "utf8");
    await run([
      "slice", "ship", "01-debt-foo", "release-0.3.2",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    const after = fs.readFileSync(path.join(env.missionsRoot, "untouched-mission", "README.md"), "utf8");
    expect(after).toBe(before);
    expect(readFrontmatter(path.join(env.missionsRoot, "untouched-mission", "README.md")).id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// HG-10: 3-part error shape
// ---------------------------------------------------------------------

describe("3-part error shape (HG-10)", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("ship to nonexistent target mission yields fact/consequence/action", async () => {
    const r = await run([
      "slice", "ship", "01-debt-foo", "release-9.9.9",
      "--mission", "backlog", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.fact).toBeTruthy();
    expect(parsed.error.consequence).toBeTruthy();
    expect(parsed.error.action).toBeTruthy();
  });
});

// ---------------------------------------------------------------------
// HG-12: --help exists for every command
// ---------------------------------------------------------------------

describe("--help is present on every command (HG-12)", () => {
  it("every tier and verb has help text", () => {
    const cmd = scopeCommand();
    expect(cmd.description()).toBeTruthy();
    const tiers = cmd.commands;
    expect(tiers.map((c) => c.name()).sort()).toEqual(["audit", "mission", "slice"]);
    for (const tier of tiers) {
      expect(tier.description()).toBeTruthy();
      for (const verb of tier.commands) {
        expect(verb.description()).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------
// Guard BLOCKING: audit edge cases
// ---------------------------------------------------------------------

describe("rig scope audit edge cases (guard BLOCKING fixes)", () => {
  let substrate: { root: string; missionsRoot: string };
  beforeEach(() => {
    substrate = seedSubstrate();
  });
  afterEach(() => {
    fs.rmSync(substrate.root, { recursive: true, force: true });
  });

  it("README-less mission with PROGRESS.md emits orphan_progress (not a false clear)", async () => {
    const missionDir = path.join(substrate.missionsRoot, "no-readme-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const result = await run(["audit", "--mission", "no-readme-mission", "--json"], substrate.missionsRoot);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.mission.findings.some((f: { kind: string }) => f.kind === "orphan_progress")).toBe(true);
  });

  it("NN-slug slice dir with no README and no PROGRESS emits findings (not skipped)", async () => {
    const sliceDir = path.join(substrate.missionsRoot, "release-0.3.2", "slices", "02-bare");
    fs.mkdirSync(sliceDir, { recursive: true });
    const result = await run(["audit", "--mission", "release-0.3.2", "--json"], substrate.missionsRoot);
    const parsed = JSON.parse(result.stdout);
    const sliceEntry = parsed.slices.find((s: { name: string }) => s.name === "02-bare");
    expect(sliceEntry).toBeDefined();
    expect(sliceEntry.findings.some((f: { kind: string }) => f.kind === "missing_id")).toBe(true);
    expect(sliceEntry.findings.some((f: { kind: string }) => f.kind === "missing_progress")).toBe(true);
  });

  it("non-slice-shaped dir in slices/ with README + PROGRESS emits finding", async () => {
    const sliceDir = path.join(substrate.missionsRoot, "release-0.3.2", "slices", "random-notes");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.0.3.2.99\n---\n# notes\n", "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const result = await run(["audit", "--mission", "release-0.3.2", "--json"], substrate.missionsRoot);
    const parsed = JSON.parse(result.stdout);
    const sliceEntry = parsed.slices.find((s: { name: string }) => s.name === "random-notes");
    expect(sliceEntry).toBeDefined();
    expect(sliceEntry.findings.some((f: { kind: string }) => f.kind === "id_convention_violation" || f.kind === "slice_naming_convention")).toBe(true);
  });
});
