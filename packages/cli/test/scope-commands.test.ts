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
  const missionsRoot = path.join(root, "openrig-work", "missions");
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
    expect(tiers.map((c) => c.name()).sort()).toEqual(["mission", "slice"]);
    for (const tier of tiers) {
      expect(tier.description()).toBeTruthy();
      for (const verb of tier.commands) {
        expect(verb.description()).toBeTruthy();
      }
    }
  });
});
