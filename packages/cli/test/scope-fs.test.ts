// release-0.3.2 slice 12 — scope-fs helpers + frontmatter parser tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  configuredMissionsRoot,
  ensureMissionId,
  findMission,
  findSlice,
  listMissions,
  listSlices,
  moveSlice,
  nextSliceNN,
  readFrontmatter,
  resolveMissionsRoot,
  splitFrontmatter,
  updateFrontmatter,
} from "../src/lib/scope/scope-fs.js";
import { ScopeCliError } from "../src/lib/scope/types.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-test-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

describe("frontmatter parser", () => {
  it("returns {} when there is no frontmatter delimiter", () => {
    const { frontmatter, body } = splitFrontmatter("# heading\n\nbody");
    expect(frontmatter).toEqual({});
    expect(body).toBe("# heading\n\nbody");
  });

  it("parses simple key/value pairs", () => {
    const src = "---\nid: OPR.0.3.2.12\nstatus: active\n---\nbody";
    const { frontmatter, body } = splitFrontmatter(src);
    expect(frontmatter).toEqual({ id: "OPR.0.3.2.12", status: "active" });
    expect(body).toBe("body");
  });

  it("reads CRLF frontmatter while preserving body bytes and authored mission identity", () => {
    const dir = mktemp();
    const body = "\r\n# Mission\r\n\r\nKeep body bytes.\r\n";
    const source = "---\r\nid: DEMO.1.2\r\nstatus: active\r\ndepends_on: [DEMO.1.1]\r\n---\r\n" + body;
    const missionDir = path.join(dir, "custom-mission");
    writeFile(path.join(missionDir, "SPEC.md"), source);
    const parsed = splitFrontmatter(source);
    expect(parsed.frontmatter).toEqual({ id: "DEMO.1.2", status: "active", depends_on: ["DEMO.1.1"] });
    expect(parsed.body).toBe(body);
    const mission = findMission(dir, "custom-mission");
    expect(mission.id).toBe("DEMO.1.2");
    expect(ensureMissionId(mission, dir)).toBe("DEMO.1.2");
    expect(fs.readFileSync(path.join(missionDir, "SPEC.md"), "utf8")).toBe(source);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requires a complete closing delimiter and accepts empty or EOF-terminated frontmatter", () => {
    for (const suffix of ["---suffix", "---\rnot-a-delimiter"]) {
      const content = `---\nid: DEMO.1.2\n${suffix}`;
      expect(splitFrontmatter(content)).toEqual({ frontmatter: {}, body: content });
    }
    expect(splitFrontmatter("---\r\n---\r\nbody")).toEqual({ frontmatter: {}, body: "body" });
    expect(splitFrontmatter("---\nid: DEMO.1.2\n---")).toEqual({ frontmatter: { id: "DEMO.1.2" }, body: "" });
  });

  it("preserves delimiters with trailing spaces or tabs for LF, CRLF and EOF", () => {
    for (const newline of ["\n", "\r\n"]) {
      for (const trailing of [" ", "\t", " \t"]) {
        const body = newline + "# Body" + newline;
        for (const ending of [newline + body, ""]) {
          const content = `---${trailing}${newline}id: DEMO.1.2${newline}---${trailing}${ending}`;
          expect(splitFrontmatter(content)).toEqual({ frontmatter: { id: "DEMO.1.2" }, body: ending ? body : "" });
        }
      }
    }
    const malformed = "---\nid: DEMO.1.2\n--- \tsuffix";
    expect(splitFrontmatter(malformed)).toEqual({ frontmatter: {}, body: malformed });
  });

  it("preserves unknown keys on update", () => {
    const dir = mktemp();
    const p = path.join(dir, "README.md");
    writeFile(p, "---\nstatus: active\ncustom: keep-me\n---\nbody\n");
    updateFrontmatter(p, { status: "shipped" });
    const fm = readFrontmatter(p);
    expect(fm.status).toBe("shipped");
    expect(fm.custom).toBe("keep-me");
  });

  it.each([
    "title: Fix: the parser\nstatus: active",
    "status: active\nstatus: shipped",
    "- root-list",
    "root-scalar",
    "status: *missing",
    "status: &state active\nrelated: *state",
  ])("warns and retains main's line-based update for invalid YAML: %j", (block) => {
    const dir = mktemp();
    const file = path.join(dir, "README.md");
    const original = `---\n${block}\n---\n\n# owned body\n`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFile(file, original);
      expect(() => updateFrontmatter(file, { status: "closed" })).not.toThrow();
      const updated = fs.readFileSync(file, "utf8");
      expect(updated).toContain("status: closed");
      expect(updated.endsWith("---\n\n# owned body\n")).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(file));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("frontmatter isn't valid YAML"));
      if (block.includes("*state")) expect(updated).toContain("related: *state");
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves CRLF delimiters, unowned comments, and body when updating a quoted key", () => {
    const dir = mktemp();
    const file = path.join(dir, "README.md");
    const original = "---\r\n\"status\": active # retained field note\r\n# keep\r\ncustom: 'retain: exactly'\r\n---\r\n\r\n# owned body\r\n";
    try {
      writeFile(file, original);
      updateFrontmatter(file, { status: "closed" });
      expect(fs.readFileSync(file, "utf8")).toBe(original.replace('"status": active', "status: closed"));
      expect(readFrontmatter(file)).toMatchObject({ status: "closed", custom: "retain: exactly" });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ["owned:\n  stale: value", "replacement"],
    ["owned: old", { fresh: ["one", "two"] }],
    ["owned:\n  - stale", { fresh: "value" }],
    ["owned:", ["fresh"]],
  ])("replaces the complete owned value in %j", (field, value) => {
    const dir = mktemp();
    const file = path.join(dir, "README.md");
    const unowned = "# retain this comment\ncustom: 'retain: exactly'";
    try {
      writeFile(file, `---\n${field}\n${unowned}\n---\nbody\n`);
      updateFrontmatter(file, { owned: value });
      expect(readFrontmatter(file)).toEqual({ owned: value, custom: "retain: exactly" });
      expect(fs.readFileSync(file, "utf8")).toContain(unowned);
      expect(fs.readFileSync(file, "utf8").endsWith("---\nbody\n")).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("generates minimal frontmatter when absent", () => {
    const dir = mktemp();
    const p = path.join(dir, "README.md");
    writeFile(p, "body only\n");
    updateFrontmatter(p, { id: "OPR.0.3.2" });
    const fm = readFrontmatter(p);
    expect(fm.id).toBe("OPR.0.3.2");
  });
});

describe("resolveMissionsRoot", () => {
  it("uses an explicit override path when present", () => {
    const root = mktemp();
    fs.mkdirSync(path.join(root, "missions"));
    expect(resolveMissionsRoot({ override: root })).toBe(path.join(root, "missions"));
  });

  it("throws ScopeCliError when no missions/ root is found", () => {
    const empty = mktemp();
    const missingMissions = path.join(empty, "missing-missions");
    const configPath = path.join(empty, "config.json");
    // An absent config inherits the default mission root, which may exist.
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { slicesRoot: missingMissions } }));
    const resolve = () => resolveMissionsRoot({ override: empty, cwd: empty, configPath });
    expect(resolve).toThrow(ScopeCliError);
    expect(resolve).toThrow(`Configured workspace.slices_root is not a readable directory: ${missingMissions}.`);
  });

  it("strictOverride refuses an explicit override with no missions tree instead of falling back", () => {
    // #995: the silent fallback let a command operate on the configured tree
    // while the caller had named another one.
    const configuredRoot = mktemp();
    const configuredMissions = path.join(configuredRoot, "missions");
    fs.mkdirSync(configuredMissions);
    const configPath = path.join(configuredRoot, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { slicesRoot: configuredMissions } }));
    const namedWithoutMissions = mktemp();

    expect(resolveMissionsRoot({ override: namedWithoutMissions, configPath })).toBe(configuredMissions);

    const strict = () => resolveMissionsRoot({ override: namedWithoutMissions, configPath, strictOverride: true });
    expect(strict).toThrow(ScopeCliError);
    expect(strict).toThrow("named by --workspace has no missions tree");
    // Dropping the flag does not clear the variable, so the flag's remedy says so.
    expect(strict).toThrow(/OPENRIG_WORK_ROOT in the environment still applies/);
  });

  it("strictOverride names OPENRIG_WORK_ROOT, and how to clear it, when the override came from the env", () => {
    const configuredRoot = mktemp();
    const configuredMissions = path.join(configuredRoot, "missions");
    fs.mkdirSync(configuredMissions);
    const configPath = path.join(configuredRoot, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { slicesRoot: configuredMissions } }));
    const prior = process.env.OPENRIG_WORK_ROOT;
    process.env.OPENRIG_WORK_ROOT = mktemp();
    try {
      const strict = () => resolveMissionsRoot({ configPath, strictOverride: true });
      expect(strict).toThrow("named by OPENRIG_WORK_ROOT has no missions tree");
      expect(strict).toThrow(/unset it to use the configured workspace/);
    } finally {
      if (prior === undefined) delete process.env.OPENRIG_WORK_ROOT;
      else process.env.OPENRIG_WORK_ROOT = prior;
    }
  });

  it("uses the typed workspace.slices_root setting instead of walking cwd", () => {
    const root = mktemp();
    const missions = path.join(root, "declared-missions");
    fs.mkdirSync(missions);
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { slicesRoot: missions } }));
    expect(resolveMissionsRoot({ override: root, cwd: root, configPath })).toBe(missions);
  });
});

describe("configuredMissionsRoot", () => {
  it("returns the configured slices root when it is a readable directory", () => {
    const root = mktemp();
    const missions = path.join(root, "declared-missions");
    fs.mkdirSync(missions);
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { slicesRoot: missions } }));
    expect(configuredMissionsRoot(configPath)).toBe(missions);
  });

  it("returns null when the setting is unset or not a readable directory", () => {
    const root = mktemp();
    const unsetPath = path.join(root, "unset.json");
    fs.writeFileSync(unsetPath, JSON.stringify({}));
    expect(configuredMissionsRoot(unsetPath)).toBeNull();

    const missingPath = path.join(root, "missing.json");
    fs.writeFileSync(missingPath, JSON.stringify({ workspace: { slicesRoot: path.join(root, "nope") } }));
    expect(configuredMissionsRoot(missingPath)).toBeNull();

    const filePath = path.join(root, "a-file");
    fs.writeFileSync(filePath, "not a directory");
    const fileConfig = path.join(root, "file.json");
    fs.writeFileSync(fileConfig, JSON.stringify({ workspace: { slicesRoot: filePath } }));
    expect(configuredMissionsRoot(fileConfig)).toBeNull();
  });
});

describe("listMissions + listSlices + nextSliceNN", () => {
  let root: string;
  let missionsRoot: string;

  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    // mission with 2 active + 1 closed slice
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\n# release-0.3.2\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "slices", "01-foo", "README.md"),
      "---\nid: OPR.0.3.2.1\nstatus: active\n---\nbody\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "slices", "02-bar", "README.md"),
      "---\nid: OPR.0.3.2.2\nstatus: active\n---\nbody\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "closed", "04-baz", "README.md"),
      "---\nid: OPR.0.3.2.4\nstatus: closed-stale\n---\nbody\n",
    );
    // mission with no README — should be skipped as "no slice count basis"
    fs.mkdirSync(path.join(missionsRoot, "no-readme"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists missions sorted by name with slice counts; SKIPS dirs without README.md (HG-8)", () => {
    const missions = listMissions(missionsRoot);
    // no-readme/ has no README.md and must NOT appear (HG-8 / PRD §2.1).
    expect(missions.map((m) => m.name)).toEqual(["release-0.3.2"]);
    const r = missions.find((m) => m.name === "release-0.3.2")!;
    expect(r.activeSliceCount).toBe(2);
    expect(r.closedSliceCount).toBe(1);
    expect(r.id).toBe("OPR.0.3.2");
  });

  it("HG-8 discriminator: 3 dirs / 1 without README → exactly 2 missions listed", () => {
    // Seed a third mission alongside the existing fixture for a clear
    // make-it-fail-first signal per guard BC verdict.
    writeFile(
      path.join(missionsRoot, "backlog", "README.md"),
      "---\nid: OPR.99.0.1\n---\n# backlog\n",
    );
    const missions = listMissions(missionsRoot);
    expect(missions.map((m) => m.name).sort()).toEqual(["backlog", "release-0.3.2"]);
    // The README-less directory survives on disk but does not show up.
    expect(fs.existsSync(path.join(missionsRoot, "no-readme"))).toBe(true);
  });

  it("listSlices active filter excludes closed/shipped (HG-1)", () => {
    const mission = findMission(missionsRoot, "release-0.3.2");
    const active = listSlices(mission, "active");
    expect(active.map((s) => s.name).sort()).toEqual(["01-foo", "02-bar"]);
    const closed = listSlices(mission, "closed");
    expect(closed.map((s) => s.name)).toEqual(["04-baz"]);
  });

  it("nextSliceNN skips numbers already used in slices/ AND closed/ (HG-3)", () => {
    const missionAbs = path.join(missionsRoot, "release-0.3.2");
    // existing: 01, 02, 04 → next should be 5 (not 3 — numbers never reused).
    expect(nextSliceNN(missionAbs)).toBe(5);
  });
});

describe("findSlice + resolution variants", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\nbody",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "slices", "07-target", "README.md"),
      "---\nid: OPR.0.3.2.7\nstatus: active\n---\nbody",
    );
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("resolves a mission-relative path with --mission hint", () => {
    const slice = findSlice(missionsRoot, "07-target", "release-0.3.2");
    expect(slice.name).toBe("07-target");
    expect(slice.id).toBe("OPR.0.3.2.7");
  });

  it("resolves an absolute path", () => {
    const abs = path.join(missionsRoot, "release-0.3.2", "slices", "07-target");
    const slice = findSlice(missionsRoot, abs);
    expect(slice.missionName).toBe("release-0.3.2");
  });

  it.each(["workspace", "missions", "declared mission"])(
    "resolves a hinted bare slice past an unrelated %s directory",
    (collision) => {
      const scratch = path.join(collision === "workspace" ? root : missionsRoot, "07-target");
      fs.mkdirSync(scratch);
      if (collision === "declared mission") writeFile(path.join(scratch, "README.md"), "# Other mission\n");
      const slice = findSlice(missionsRoot, "07-target", "release-0.3.2");
      expect(slice.absPath).toBe(path.join(missionsRoot, "release-0.3.2", "slices", "07-target"));
      expect(slice.id).toBe("OPR.0.3.2.7");
    },
  );

  it.each(["relative", "absolute", "trailing separator"])(
    "keeps an invalid explicit %s path refusal despite a valid mission hint",
    (form) => {
      const scratch = path.join(root, "07-target");
      fs.mkdirSync(scratch);
      const argument = form === "absolute" ? scratch : form === "relative" ? `.${path.sep}07-target` : `07-target${path.sep}`;
      expect(() => findSlice(missionsRoot, argument, "release-0.3.2")).toThrow(
        `resolved to ${scratch} but no parent mission was found`,
      );
    },
  );

  it.each(["mission relative", "workspace relative", "absolute"])(
    "preserves a valid explicit %s path in another mission",
    (form) => {
      const other = path.join(missionsRoot, "other", "slices", "07-target");
      writeFile(path.join(missionsRoot, "other", "README.md"), "---\nid: OPR.9.1\n---\nbody");
      writeFile(path.join(other, "README.md"), "---\nid: OPR.9.1.7\nstatus: active\n---\nother body");
      const argument = form === "absolute" ? other : path.join(
        ...(form === "workspace relative" ? ["missions"] : []), "other", "slices", "07-target",
      );
      const slice = findSlice(missionsRoot, argument, "release-0.3.2");
      expect(slice.absPath).toBe(other);
      expect(slice.missionName).toBe("other");
      expect(slice.id).toBe("OPR.9.1.7");
    },
  );

  it("preserves the first context error when a hinted slice does not exist", () => {
    const first = path.join(root, "07-target");
    fs.mkdirSync(first);
    fs.mkdirSync(path.join(missionsRoot, "07-target"));
    expect(() => findSlice(missionsRoot, "07-target", "missing-mission")).toThrow(
      `resolved to ${first} but no parent mission was found`,
    );
  });

  it("keeps an unhinted bare collision refusal", () => {
    const scratch = path.join(root, "07-target");
    fs.mkdirSync(scratch);
    expect(() => findSlice(missionsRoot, "07-target")).toThrow(
      `resolved to ${scratch} but no parent mission was found`,
    );
  });

  it("prefers active slices over closed slices after a bare-name collision", () => {
    fs.mkdirSync(path.join(root, "07-target"));
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "closed", "07-target", "README.md"),
      "---\nid: OPR.0.3.2.7\nstatus: closed-wontfix\n---\nclosed body",
    );
    expect(findSlice(missionsRoot, "07-target", "release-0.3.2").absPath).toBe(
      path.join(missionsRoot, "release-0.3.2", "slices", "07-target"),
    );
  });

  it("resolves a closed slice after a bare-name collision when no active slice exists", () => {
    fs.mkdirSync(path.join(root, "07-target"));
    const mission = path.join(missionsRoot, "release-0.3.2");
    fs.mkdirSync(path.join(mission, "closed"));
    fs.renameSync(path.join(mission, "slices", "07-target"), path.join(mission, "closed", "07-target"));
    expect(findSlice(missionsRoot, "07-target", "release-0.3.2").absPath).toBe(
      path.join(mission, "closed", "07-target"),
    );
  });

  it("3-part error when slice not found (HG-10)", () => {
    expect(() => findSlice(missionsRoot, "99-missing", "release-0.3.2")).toThrow(/not found/);
  });
});

describe("BC-2 BLOCK 2 — findMission rejects README-less directories", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\n",
    );
    // README-less directory next to a real mission — scratch/junk.
    fs.mkdirSync(path.join(missionsRoot, "no-readme"));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("findMission throws 3-part error when target directory has no README.md", () => {
    expect(() => findMission(missionsRoot, "no-readme")).toThrow(/not a declared mission|no README/);
  });

  it("findMission still resolves declared missions normally", () => {
    expect(findMission(missionsRoot, "release-0.3.2").name).toBe("release-0.3.2");
  });
});

describe("ensureMissionId", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("returns existing frontmatter id when present", () => {
    writeFile(
      path.join(missionsRoot, "weird-name", "README.md"),
      "---\nid: OPR.99.0.7\n---\n",
    );
    const m = findMission(missionsRoot, "weird-name");
    expect(ensureMissionId(m, missionsRoot)).toBe("OPR.99.0.7");
  });

  it("derives from release-X.Y.Z pattern when no id present", () => {
    writeFile(path.join(missionsRoot, "release-0.4.0", "README.md"), "");
    const m = findMission(missionsRoot, "release-0.4.0");
    expect(ensureMissionId(m, missionsRoot)).toBe("OPR.0.4.0");
  });

  it("falls into escape band for non-release names", () => {
    writeFile(path.join(missionsRoot, "backlog", "README.md"), "");
    const m = findMission(missionsRoot, "backlog");
    const id = ensureMissionId(m, missionsRoot);
    expect(id).toMatch(/^OPR\.99\.0\.\d+$/);
  });
});

// ---------------------------------------------------------------------
// git mv path — uses real git in a tmp repo (HG-5, HG-11)
// ---------------------------------------------------------------------

function initRepo(root: string): void {
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Tester"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "init", "-q"], { stdio: "ignore" });
}

describe("moveSlice — literal directory names in the dirty-tree guard", () => {
  let root: string;
  beforeEach(() => {
    root = mktemp();
    // Exercise Git's default pathspec interpretation independently of the host.
    for (const key of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
      vi.stubEnv(key, "0");
    }
    initRepo(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.skipIf(process.platform === "win32").each([
    [":(exclude)workspace", "outside", true],
    [":!workspace", "outside", true],
    [":(literal)workspace", "inside", false],
    ["workspace", "outside", true],
    ["workspace", "inside", false],
    ["literal:workspace", "outside", true],
    ["workspace[owned]", "outside", true],
  ] as const)("checks the selected slice under %s with %s edits", (workspaceName, dirty, shouldMove) => {
    const missionsRoot = path.join(root, workspaceName, "missions");
    const src = path.join(missionsRoot, "backlog", "slices", "01-owned");
    const dest = path.join(missionsRoot, "backlog", "closed", "01-owned");
    const readme = path.join(src, "README.md");
    const unrelated = path.join(root, "unrelated.txt");
    writeFile(readme, "---\nstatus: active\n---\n# Owned slice\n");
    writeFile(unrelated, "Owned unrelated baseline\n");
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-m", "seed", "-q"], { stdio: "ignore" });
    fs.appendFileSync(dirty === "inside" ? readme : unrelated, "Owned uncommitted edit\n");
    const before = fs.readFileSync(readme);
    const unrelatedBefore = fs.readFileSync(unrelated);

    if (shouldMove) {
      expect(moveSlice(src, dest).usedGit).toBe(true);
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(path.join(dest, "README.md"))).toEqual(before);
    } else {
      expect(() => moveSlice(src, dest)).toThrow(/uncommitted changes/);
      expect(fs.existsSync(path.dirname(dest))).toBe(false);
      expect(fs.readFileSync(readme)).toEqual(before);
    }
    expect(fs.readFileSync(unrelated)).toEqual(unrelatedBefore);
  });
});

describe("moveSlice — git mv preserves history (HG-5) + refuses dirty tree (HG-11)", () => {
  let root: string;
  let missionsRoot: string;
  beforeEach(() => {
    root = mktemp();
    missionsRoot = path.join(root, "missions");
    initRepo(root);
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeFile(
      path.join(missionsRoot, "backlog", "README.md"),
      "---\nid: OPR.99.0.1\n---\n# backlog\n",
    );
    writeFile(
      path.join(missionsRoot, "backlog", "slices", "01-foo", "README.md"),
      "---\nid: OPR.99.0.1.1\nstatus: active\n---\n# foo\n",
    );
    writeFile(
      path.join(missionsRoot, "release-0.3.2", "README.md"),
      "---\nid: OPR.0.3.2\n---\n# release\n",
    );
    execFileSync("git", ["-C", root, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "commit", "-m", "seed", "-q"], { stdio: "ignore" });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("uses git mv inside a repo and preserves the file via git log --follow", () => {
    const src = path.join(missionsRoot, "backlog", "slices", "01-foo");
    const dest = path.join(missionsRoot, "release-0.3.2", "slices", "01-foo");
    const result = moveSlice(src, dest);
    expect(result.usedGit).toBe(true);
    execFileSync("git", ["-C", root, "commit", "-m", "ship", "-q"], { stdio: "ignore" });
    const log = execFileSync("git", [
      "-C", root, "log", "--follow", "--pretty=format:%s", "--", path.relative(root, path.join(dest, "README.md")),
    ], { encoding: "utf8" });
    expect(log).toMatch(/seed/);
    expect(log).toMatch(/ship/);
  });

  it("refuses to move when slice has uncommitted local edits (HG-11)", () => {
    const src = path.join(missionsRoot, "backlog", "slices", "01-foo");
    fs.writeFileSync(path.join(src, "README.md"), "dirty\n", "utf8");
    const dest = path.join(missionsRoot, "release-0.3.2", "slices", "02-foo");
    expect(() => moveSlice(src, dest)).toThrow(/uncommitted/);
    expect(fs.existsSync(path.dirname(dest))).toBe(false);
  });

  it("falls back to fs.rename outside a git repo", () => {
    const dir = mktemp();
    const src = path.join(dir, "src");
    const dest = path.join(dir, "dest");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "README.md"), "body");
    const result = moveSlice(src, dest);
    expect(result.usedGit).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("BLOCK 4 discriminator: handles symlinked src/dest paths without escaping the repo (macOS /var↔/private/var class)", () => {
    // Build a parallel tree of symlinks pointing at the real repo
    // tree. Without realpath normalization inside moveSlice, path.relative
    // would resolve to ../.. and git mv would reject with "outside
    // repository". With normalization, git mv succeeds and history
    // follows the move via --follow.
    const linkParent = mktemp();
    const linkRoot = path.join(linkParent, "linked-substrate");
    fs.symlinkSync(root, linkRoot);
    // Sanity: the symlinked tree resolves to a different absolute path
    // than the real tree (covers the /var↔/private/var class on macOS
    // and any other path-resolving symlink class on other OSes).
    expect(fs.realpathSync(linkRoot)).not.toBe(linkRoot);
    const src = path.join(linkRoot, "missions", "backlog", "slices", "01-foo");
    const dest = path.join(linkRoot, "missions", "release-0.3.2", "slices", "01-foo");
    const result = moveSlice(src, dest);
    expect(result.usedGit).toBe(true);
    expect(result.repoRoot).toBe(fs.realpathSync(root)); // git returned the realpath
    // git mv staged a rename; history follows.
    execFileSync("git", ["-C", root, "commit", "-m", "ship-via-symlink", "-q"], { stdio: "ignore" });
    const log = execFileSync("git", [
      "-C", root, "log", "--follow", "--pretty=format:%s", "--",
      "missions/release-0.3.2/slices/01-foo/README.md",
    ], { encoding: "utf8" });
    expect(log).toMatch(/seed/);
    expect(log).toMatch(/ship-via-symlink/);
    fs.rmSync(linkParent, { recursive: true, force: true });
  });
});
