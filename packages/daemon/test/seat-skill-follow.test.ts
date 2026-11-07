// A skill whose resource says `on_restore: follow_source` takes today's bytes and today's selection when a restore
// brings its seat back with its conversation; a seat's edit is still never overwritten.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { chmodSync, statSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { planProjection } from "../src/domain/projection-planner.js";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanSeatSkills, ensureSeatSkillPlugin, followSeatSkills, recordSeatSkillFollowing, recordSeatSkillWrite, rehydrateSeatSkills, seatSkillPaths, seatSkillReplay,
} from "../src/domain/seat-skill-storage.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("a restore brings a following skill's copy up to its source, and keeps a seat's edit", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-follow-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  /** Create isolated seat storage and helpers that model a recorded skill projection. */
  function seat(runtime = "claude-code") {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
    ensureSeatSkillPlugin(paths);
    const sourceOf = (id: string) => join(home, "skills", id);
    const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
    /** A skill as a launch leaves it: source and seat copy alike, every file recorded, following its source or not. */
    const launched = (id: string, files: Record<string, string>, follow = true) => {
      for (const [rel, text] of Object.entries(files)) {
        put(join(sourceOf(id), rel), text);
        put(join(paths.skillsRoot, id, rel), text);
        recordSeatSkillWrite(paths.skillsRoot, join(paths.skillsRoot, id, rel), join(sourceOf(id), rel), text);
      }
      if (follow) recordSeatSkillFollowing(paths.skillsRoot, id, sourceOf(id));
    };
    const copy = (id: string, rel: string) => readFileSync(join(paths.skillsRoot, id, rel), "utf8");
    return { paths, sourceOf, put, launched, copy };
  }

  it("refreshes an unchanged copy from its changed source, and records the new bytes", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1", "scripts/check.sh": "check v1" });
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    put(join(sourceOf("infra-review"), "references/aws.md"), "new reference");
    rmSync(join(sourceOf("infra-review"), "scripts"), { recursive: true });

    const out = followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] });

    expect(out).toEqual({ refreshed: ["infra-review"], added: [], removed: [], warnings: [] });
    expect(copy("infra-review", "SKILL.md")).toBe("v2");
    expect(copy("infra-review", "references/aws.md")).toBe("new reference");
    expect(existsSync(join(paths.skillsRoot, "infra-review", "scripts"))).toBe(false);
    // The record now holds today's bytes, so the next rig down removes the copy and the next restore puts it back.
    expect(cleanSeatSkills(paths).kept).toEqual([]);
    expect(rehydrateSeatSkills(paths).restored.sort()).toEqual([
      join(paths.skillsRoot, "infra-review", "SKILL.md"), join(paths.skillsRoot, "infra-review", "references/aws.md")]);
  });
  it("refreshes a copy rig down removed for being unchanged, so the restore doesn't name it missing", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    cleanSeatSkills(paths);
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");

    expect(followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] }).refreshed)
      .toEqual(["infra-review"]);
    expect(copy("infra-review", "SKILL.md")).toBe("v2");
    expect(rehydrateSeatSkills(paths)).toEqual({ restored: [], kept: [], missing: [], refused: [] });
  });

  it("refreshes a copy whose source changed before rig down, whether rig down removed it or kept it", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    cleanSeatSkills(paths);

    expect(followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] }))
      .toEqual({ refreshed: ["infra-review"], added: [], removed: [], warnings: [] });
    expect(copy("infra-review", "SKILL.md")).toBe("v2");
    expect(rehydrateSeatSkills(paths)).toEqual({ restored: [], kept: [], missing: [], refused: [] });
  });

  it("leaves an unchanged skill whose source hasn't moved to the usual rehydration, and reports nothing", () => {
    const { paths, sourceOf, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    cleanSeatSkills(paths);

    expect(followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] }))
      .toEqual({ refreshed: [], added: [], removed: [], warnings: [] });
    expect(rehydrateSeatSkills(paths).restored).toEqual([join(paths.skillsRoot, "infra-review", "SKILL.md")]);
    expect(copy("infra-review", "SKILL.md")).toBe("v1");
  });

  it("records a moved source even when its bytes are identical, so down can rehydrate it", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    const moved = join(home, "moved");
    put(join(moved, "SKILL.md"), "v1");
    followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: moved }] });
    rmSync(sourceOf("infra-review"), { recursive: true });
    expect(cleanSeatSkills(paths).kept).toEqual([]);
    expect(rehydrateSeatSkills(paths).missing).toEqual([]);
    expect(copy("infra-review", "SKILL.md")).toBe("v1");
  });

  it.skipIf(process.platform === "win32")("takes an executable-mode change even when a script's bytes are identical", () => {
    const { paths, sourceOf, launched } = seat();
    launched("infra-review", { "SKILL.md": "v1", "scripts/check.sh": "exit 0" });
    chmodSync(join(sourceOf("infra-review"), "scripts/check.sh"), 0o755);
    chmodSync(join(paths.skillsRoot, "infra-review", "scripts/check.sh"), 0o644);
    followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] });
    expect(statSync(join(paths.skillsRoot, "infra-review", "scripts/check.sh")).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32").each(["claude-code", "codex"])("keeps a seat-local chmod through down, refresh and deselection for %s", (runtime) => {
    const { paths, sourceOf, put, launched, copy } = seat(runtime);
    launched("infra-review", { "SKILL.md": "v1", "scripts/check.sh": "exit 0" });
    const script = join(paths.skillsRoot, "infra-review", "scripts/check.sh");
    const editedMode = (statSync(script).mode & 0o777) ^ 0o100;
    chmodSync(script, editedMode);
    expect(cleanSeatSkills(paths).kept).toContain(script);
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    const result = followSeatSkills(paths, { selected: new Set(["infra-review"]),
      following: [{ id: "infra-review", source: sourceOf("infra-review") }] });
    expect(result.refreshed).toEqual([]);
    expect(result.warnings.join("\n")).toContain("was edited");
    expect(rehydrateSeatSkills(paths).kept).toContain(script);
    expect(copy("infra-review", "scripts/check.sh")).toBe("exit 0");
    expect(followSeatSkills(paths, { selected: new Set(), following: [] }).removed).toEqual([]);
    expect(statSync(script).mode & 0o777).toBe(editedMode);
  });

  it.skipIf(process.platform === "win32")("takes source mode changes after down and records the refreshed mode", () => {
    const { paths, sourceOf, launched } = seat();
    launched("infra-review", { "SKILL.md": "v1", "scripts/check.sh": "exit 0" });
    const script = join(paths.skillsRoot, "infra-review", "scripts/check.sh");
    cleanSeatSkills(paths);
    chmodSync(join(sourceOf("infra-review"), "scripts/check.sh"), 0o755);
    expect(followSeatSkills(paths, { selected: new Set(["infra-review"]),
      following: [{ id: "infra-review", source: sourceOf("infra-review") }] }).refreshed).toEqual(["infra-review"]);
    expect(statSync(script).mode & 0o777).toBe(0o755);
    expect(cleanSeatSkills(paths).kept).toEqual([]);
    rehydrateSeatSkills(paths);
    expect(statSync(script).mode & 0o777).toBe(0o755);
    chmodSync(script, 0o644);
    expect(cleanSeatSkills(paths).kept).toContain(script);
  });

  it.skipIf(process.platform === "win32").each([false, true])("rehydrates keep_saved with compatible permission records (legacy=%s)", (legacy) => {
    const { paths, sourceOf, launched } = seat();
    launched("infra-review", { "SKILL.md": "v1" }, false);
    const file = join(paths.skillsRoot, "infra-review", "SKILL.md");
    const savedMode = statSync(file).mode & 0o777;
    if (legacy) {
      const record = JSON.parse(readFileSync(paths.projectionsPath, "utf8"));
      delete record.files[file].mode;
      writeFileSync(paths.projectionsPath, JSON.stringify(record));
    }
    cleanSeatSkills(paths);
    chmodSync(join(sourceOf("infra-review"), "SKILL.md"), 0o755);
    expect(rehydrateSeatSkills(paths).restored).toContain(file);
    expect(statSync(file).mode & 0o777).toBe(legacy ? 0o755 : savedMode);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps the whole saved skill when a source subdirectory cannot be read", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1", "references/aws.md": "saved reference" });
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    const references = join(sourceOf("infra-review"), "references");
    chmodSync(references, 0o000);
    try {
      const result = followSeatSkills(paths, { selected: new Set(["infra-review"]),
        following: [{ id: "infra-review", source: sourceOf("infra-review") }] });
      expect(result.refreshed).toEqual([]);
      expect(result.warnings.join(" ")).toContain("can't be read");
      expect(copy("infra-review", "SKILL.md")).toBe("v1");
      expect(copy("infra-review", "references/aws.md")).toBe("saved reference");
    } finally { chmodSync(references, 0o755); }
  });

  it("records a partial refresh so a later restore can finish it", () => {
    const { paths, sourceOf, launched, put, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1", "old.txt": "old" });
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    put(join(sourceOf("infra-review"), "new.txt"), "new");
    rmSync(join(sourceOf("infra-review"), "old.txt"));
    const selection = { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] };
    const write = fs.writeFileSync;
    const failure = new Error("fixture disk write failed");
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (String(file).startsWith(join(paths.skillsRoot, "infra-review", "new.txt.openrig-"))) throw failure;
      return write(file, ...args);
    });
    try { expect(() => followSeatSkills(paths, selection)).toThrow(failure); }
    finally { spy.mockRestore(); }
    expect(Object.keys(JSON.parse(readFileSync(paths.projectionsPath, "utf8")).files))
      .toEqual([join(paths.skillsRoot, "infra-review", "SKILL.md")]);
    expect(followSeatSkills(paths, selection).warnings).toEqual([]);
    expect(copy("infra-review", "SKILL.md")).toBe("v2");
    expect(copy("infra-review", "new.txt")).toBe("new");
  });

  it.each([false, true])("reports an ownership-write failure without hiding a refresh error (refresh fails=%s)", failRefresh => {
    const { paths, sourceOf, launched, put } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    const write = fs.writeFileSync;
    const refreshError = new Error("fixture refresh failed");
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (String(file).startsWith(`${paths.projectionsPath}.openrig-`)) throw new Error("fixture record failed");
      if (failRefresh && String(file).startsWith(join(paths.skillsRoot, "infra-review", "SKILL.md.openrig-"))) throw refreshError;
      return write(file, ...args);
    });
    const refresh = () => followSeatSkills(paths, { selected: new Set(["infra-review"]),
      following: [{ id: "infra-review", source: sourceOf("infra-review") }] });
    try {
      if (failRefresh) expect(refresh).toThrow(refreshError);
      else expect(refresh().warnings.join(" ")).toContain("could not record skill ownership");
    } finally { spy.mockRestore(); }
  });

  it("names a missing following skill when rehydration cannot recover it", () => {
    const { paths, sourceOf, launched } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    cleanSeatSkills(paths);
    rmSync(sourceOf("infra-review"), { recursive: true });
    const replay = seatSkillReplay({ paths, rehydration: rehydrateSeatSkills(paths), files: [],
      entries: [{ category: "skill", effectiveId: "infra-review", absolutePath: sourceOf("infra-review") }] });
    expect(replay.skipEntryIds.has("infra-review")).toBe(true);
    expect(replay.warnings).toEqual(["Restore: infra-review not projected again: its following copy is missing and could not be restored"]);
  });

  it.each(["loadout", "both"])("reconciles %s ownership through an unchanged restore, source move, file removal and deselection", ownership => {
    const { paths, sourceOf, launched, put, copy } = seat();
    launched("review", { "SKILL.md": "v1", "removed.txt": "old reference" });
    const original = sourceOf("review");
    const untouched = { id: "other", sourceDir: sourceOf("other"), target: join(paths.skillsRoot, "other"), files: {} };
    writeFileSync(paths.manifestPath, JSON.stringify({ topologySelections: { team: ["review"] }, skills: [untouched, {
      id: "review", sourceDir: original, target: join(paths.skillsRoot, "review"),
      files: Object.fromEntries([['SKILL.md', 'v1'], ['removed.txt', 'old reference']].map(([name, bytes]) =>
        [name, createHash("sha256").update(bytes!).digest("hex")])),
    }] }));
    if (ownership === "loadout") writeFileSync(paths.projectionsPath, JSON.stringify({ files: {}, following: { review: { source: original } } }));
    const selected = new Set(["review"]);
    expect(followSeatSkills(paths, { selected, following: [{ id: "review", source: original }] }))
      .toEqual({ refreshed: [], added: [], removed: [], warnings: [] });
    expect(JSON.parse(readFileSync(paths.manifestPath, "utf8")))
      .toEqual({ topologySelections: { team: ["review"] }, skills: [untouched] });
    const moved = join(home, "moved-review");
    put(join(moved, "SKILL.md"), "v2");
    put(join(moved, "new.txt"), "new reference");
    expect(followSeatSkills(paths, { selected, following: [{ id: "review", source: moved }] }).refreshed).toEqual(["review"]);
    cleanSeatSkills(paths);
    expect(rehydrateSeatSkills(paths).missing).toEqual([]);
    expect(copy("review", "SKILL.md")).toBe("v2");
    expect(copy("review", "new.txt")).toBe("new reference");
    expect(existsSync(join(paths.skillsRoot, "review", "removed.txt"))).toBe(false);
    expect(followSeatSkills(paths, { selected: new Set(), following: [] }).removed).toEqual(["review"]);
    expect(rehydrateSeatSkills(paths).restored).toEqual([]);
    expect(existsSync(join(paths.skillsRoot, "review"))).toBe(false);
    expect(readFileSync(join(original, "removed.txt"), "utf8")).toBe("old reference");
  });

  it("keeps a copy the seat edited, or added a file to, and names it", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    launched("aws", { "SKILL.md": "aws v1" });
    put(join(paths.skillsRoot, "infra-review", "SKILL.md"), "the seat's edit");
    put(join(paths.skillsRoot, "aws", "notes.md"), "the seat's notes");
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    put(join(sourceOf("aws"), "SKILL.md"), "aws v2");

    const out = followSeatSkills(paths, { selected: new Set(["infra-review", "aws"]),
      following: [{ id: "infra-review", source: sourceOf("infra-review") }, { id: "aws", source: sourceOf("aws") }] });

    expect(out.refreshed).toEqual([]);
    expect(out.warnings).toEqual([
      `Restore: kept ${join(paths.skillsRoot, "infra-review")}: ${join(paths.skillsRoot, "infra-review", "SKILL.md")} was edited; it follows its source (on_restore: follow_source), but an edit is never overwritten`,
      `Restore: kept ${join(paths.skillsRoot, "aws")}: ${join(paths.skillsRoot, "aws", "notes.md")} is not a file OpenRig wrote; it follows its source (on_restore: follow_source), but an edit is never overwritten`,
    ]);
    expect(copy("infra-review", "SKILL.md")).toBe("the seat's edit");
    expect(copy("aws", "SKILL.md")).toBe("aws v1");
  });

  it("copies in a following skill the profile newly selects, unless something not OpenRig's is already there", () => {
    const { paths, sourceOf, put, copy } = seat();
    put(join(sourceOf("aws"), "SKILL.md"), "aws");
    put(join(sourceOf("mine"), "SKILL.md"), "from the source");
    put(join(paths.skillsRoot, "mine", "SKILL.md"), "the person's own");

    const out = followSeatSkills(paths, { selected: new Set(["aws", "mine"]),
      following: [{ id: "aws", source: sourceOf("aws") }, { id: "mine", source: sourceOf("mine") }] });

    expect(out.added).toEqual(["aws"]);
    expect(out.warnings).toEqual([
      `Restore: kept ${join(paths.skillsRoot, "mine")}: ${join(paths.skillsRoot, "mine", "SKILL.md")} is not a file OpenRig wrote; it follows its source (on_restore: follow_source), but an edit is never overwritten`]);
    expect(copy("aws", "SKILL.md")).toBe("aws");
    expect(copy("mine", "SKILL.md")).toBe("the person's own");
    // Recorded as OpenRig's, so rig down removes it like any other.
    expect(cleanSeatSkills(paths).removed).toContain(join(paths.skillsRoot, "aws", "SKILL.md"));
  });

  it("removes a following skill the profile no longer selects while unchanged; an edited one is kept", () => {
    const { paths, sourceOf, put, launched } = seat();
    launched("aws-cdk", { "SKILL.md": "cdk", "scripts/synth.sh": "synth" });
    launched("github-oidc-aws", { "SKILL.md": "oidc" });
    put(join(paths.skillsRoot, "github-oidc-aws", "SKILL.md"), "the seat's edit");

    const out = followSeatSkills(paths, { selected: new Set(), following: [] });

    expect(out.removed).toEqual(["aws-cdk"]);
    expect(existsSync(join(paths.skillsRoot, "aws-cdk"))).toBe(false);
    expect(out.warnings).toEqual([
      `Restore: kept ${join(paths.skillsRoot, "github-oidc-aws")}: ${join(paths.skillsRoot, "github-oidc-aws", "SKILL.md")} was edited, and it is no longer selected; it follows its source (on_restore: follow_source), but an edit is never overwritten`]);
    // Nothing of the removed skill is left for a later restore to put back.
    cleanSeatSkills(paths);
    expect(rehydrateSeatSkills(paths).restored).toEqual([]);
    // No spec resolution is needed to keep a previously removed skill out of an older startup plan.
    expect(seatSkillReplay({ paths, entries: [{ category: "skill", effectiveId: "aws-cdk", absolutePath: sourceOf("aws-cdk") }],
      files: [], rehydration: { missing: [], refused: [] } }).skipEntryIds).toContain("aws-cdk");
    // A later fresh restore may still carry the old startup plan; keep suppressing its removed entry.
    expect(followSeatSkills(paths, { selected: new Set(), following: [] }).removed).toEqual([]);
  });

  it("leaves skills that keep their saved copy alone, selected or not, and stops following one switched to keep_saved", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("tdd", { "SKILL.md": "tdd v1" }, false);
    launched("old-pinned", { "SKILL.md": "old" }, false);
    launched("repo-docs", { "SKILL.md": "docs v1" });
    put(join(sourceOf("tdd"), "SKILL.md"), "tdd v2");
    put(join(sourceOf("repo-docs"), "SKILL.md"), "docs v2");

    expect(followSeatSkills(paths, { selected: new Set(["tdd", "repo-docs"]), following: [] }))
      .toEqual({ refreshed: [], added: [], removed: [], warnings: [] });
    expect(copy("tdd", "SKILL.md")).toBe("tdd v1");
    expect(copy("old-pinned", "SKILL.md")).toBe("old");
    expect(copy("repo-docs", "SKILL.md")).toBe("docs v1");
    // repo-docs no longer follows: deselecting it later keeps it, like any saved copy.
    expect(followSeatSkills(paths, { selected: new Set(), following: [] }).removed).toEqual([]);
    expect(copy("repo-docs", "SKILL.md")).toBe("docs v1");
  });

  it("keeps the saved copy when the source can't be read as a skill, and names it", () => {
    const { paths, sourceOf, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    rmSync(sourceOf("infra-review"), { recursive: true });

    const out = followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] });

    expect(out.warnings).toEqual([`Restore: infra-review follows its source, but ${sourceOf("infra-review")} can't be read as a skill; its saved copy is kept`]);
    expect(copy("infra-review", "SKILL.md")).toBe("v1");
  });
});

describe("a launch records which of a seat's skills follow their source", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-follow-launch-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const realFs = {
    readFile: (p: string) => readFileSync(p, "utf8"), writeFile: (p: string, c: string) => writeFileSync(p, c),
    exists: (p: string) => existsSync(p), mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); },
    copyFile: (a: string, b: string) => writeFileSync(b, readFileSync(a)),
    statMode: (p: string) => statSync(p).mode, chmod: chmodSync,
    listFiles: (p: string) => {
      const out: string[] = [];
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name), join(rel, e.name)); else out.push(join(rel, e.name));
        }
      };
      walk(p, "");
      return out;
    },
  };

  for (const runtime of ["claude-code", "codex"] as const) {
    it.each(["projection", "loadout", "unowned", "edited", "unreadable", "record-failure", ...(process.platform === "win32" ? [] : ["linked"])])(`${runtime}: records no-op policy only for unchanged owned files (%s)`, async ownership => {
      const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
      if (runtime === "claude-code") ensureSeatSkillPlugin(paths);
      const source = join(home, "review");
      const target = join(paths.skillsRoot, "review");
      for (const dir of [source, target]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), "review");
        writeFileSync(join(dir, "helper.txt"), "original");
      }
      if (ownership === "loadout") {
        writeFileSync(paths.manifestPath, JSON.stringify({ skills: [{ target, sourceDir: source, files: {
          "SKILL.md": createHash("sha256").update("review").digest("hex"),
          "helper.txt": createHash("sha256").update("original").digest("hex"),
        } }] }));
      } else if (ownership !== "unowned") {
        for (const file of ["SKILL.md", "helper.txt"]) recordSeatSkillWrite(paths.skillsRoot, join(target, file), join(source, file), readFileSync(join(source, file)));
      }
      if (ownership === "edited") writeFileSync(join(target, "helper.txt"), "seat edit");
      if (ownership === "linked") { rmSync(join(target, "helper.txt")); symlinkSync(join(source, "helper.txt"), join(target, "helper.txt")); }
      const adapter = runtime === "codex" ? new CodexRuntimeAdapter({ tmux: {} as never, fsOps: realFs as never })
        : new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
      const binding = { cwd: home, seatSkillsRoot: paths.skillsRoot } as NodeBinding;
      const following = () => existsSync(paths.projectionsPath) ? JSON.parse(readFileSync(paths.projectionsPath, "utf8")).following : undefined;
      for (const onRestore of ["follow_source", "keep_saved"] as const) {
        const result = planProjection({ config: { runtime, cwd: home, restorePolicy: "resume_if_possible", startup: { files: [], actions: [] },
          resolvedSpecName: "team", resolvedSpecVersion: "1", resolvedSpecHash: "fixture",
          selectedResources: { guidance: [], plugins: [], runtimeResources: [], subagents: [], skills: [
            { effectiveId: "review", sourceSpec: "team", sourcePath: home, resource: { id: "review", path: source, onRestore } },
          ] },
        }, collisions: [], fsOps: realFs, resolveTargetPath: () => join(target, "SKILL.md") });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.errors.join("; "));
        expect(result.plan.entries[0]?.classification).toBe("no_op");
        const writes = vi.spyOn(realFs, "writeFile");
        const storedRead = fs.readFileSync;
        const reads = vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
          if (ownership === "unreadable" && args[0] === join(target, "helper.txt")) {
            throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
          }
          return storedRead(...args);
        });
        const storedWrite = fs.writeFileSync;
        const recordWrites = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
          if (ownership === "record-failure" && String(args[0]).startsWith(`${paths.projectionsPath}.openrig-`)) throw new Error("Read-only filesystem");
          return storedWrite(...args);
        });
        try {
          expect(await adapter.project(result.plan, binding)).toMatchObject({ projected: [], skipped: ["review"], failed: [] });
          expect(writes).not.toHaveBeenCalled();
          if (onRestore === "follow_source" && ownership === "unreadable") {
            expect(reads.mock.calls.some(([file]) => file === join(target, "helper.txt"))).toBe(true);
          }
          if (onRestore === "keep_saved") {
            expect(reads.mock.calls.some(([file]) => String(file).startsWith(target))).toBe(false);
          }
        } finally { writes.mockRestore(); reads.mockRestore(); recordWrites.mockRestore(); }
        expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("review");
        expect(following()?.review).toEqual(onRestore === "follow_source" && ["projection", "loadout"].includes(ownership) ? { source } : undefined);
      }
    });

    it(`${runtime}: marks a follow_source skill as following, and unmarks it when it is launched as keep_saved`, async () => {
      const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
      if (runtime === "claude-code") ensureSeatSkillPlugin(paths);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      const source = (id: string) => {
        const dir = join(home, "skills", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\nbody\n`);
        if (process.platform !== "win32") {
          const shared = join(home, `${id}-shared-reference.md`);
          writeFileSync(shared, "shared v1");
          if (!existsSync(join(dir, "reference.md"))) symlinkSync(shared, join(dir, "reference.md"));
        }
        chmodSync(join(dir, "SKILL.md"), 0o640);
        return dir;
      };
      const adapter = runtime === "codex"
        ? new CodexRuntimeAdapter({ tmux: {} as never, fsOps: realFs as never })
        : new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
      const binding = { id: "b", nodeId: "n", tmuxSession: null, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        updatedAt: "", cwd: project, seatSkillsRoot: paths.skillsRoot } as NodeBinding;
      const launch = (entries: Array<{ id: string; onRestore?: "follow_source" }>) => adapter.project({ runtime, cwd: project,
        entries: entries.map(({ id, onRestore }) => ({ effectiveId: id, category: "skill", absolutePath: source(id), classification: "safe_projection", ...(onRestore ? { onRestore } : {}) })),
        startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never, binding);
      const following = () => (JSON.parse(readFileSync(paths.projectionsPath, "utf8")) as { following?: Record<string, { source: string }> }).following;

      expect((await launch([{ id: "infra-review", onRestore: "follow_source" }, { id: "tdd" }])).failed).toEqual([]);
      expect(following()).toEqual({ "infra-review": { source: join(home, "skills", "infra-review") } });
      const projected = join(paths.skillsRoot, "infra-review", "SKILL.md");
      if (process.platform !== "win32") expect(JSON.parse(readFileSync(paths.projectionsPath, "utf8")).files[projected].mode).toBe(0o640);

      if (process.platform !== "win32") {
        const reference = join(paths.skillsRoot, "infra-review", "reference.md");
        expect(readFileSync(reference, "utf8")).toBe("shared v1");
        expect(fs.lstatSync(reference).isSymbolicLink()).toBe(false);
        writeFileSync(join(home, "infra-review-shared-reference.md"), "shared v2");
        followSeatSkills(paths, { selected: new Set(["infra-review", "tdd"]),
          following: [{ id: "infra-review", source: join(home, "skills", "infra-review") }] });
        expect(readFileSync(reference, "utf8")).toBe("shared v2");
      }
      await launch([{ id: "infra-review" }, { id: "tdd" }]);
      expect(following()).toBeUndefined();
    });
  }
});

describe("a restore reads a seat's skill selection from its spec as it is now, through its launch recipe", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-follow-select-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  /** Create a persisted seat recipe whose source agent spec can change independently. */
  function seatWithRecipe(agentYaml: string | undefined, opts: { recipe?: boolean } = {}) {
    const db = createFullTestDb();
    const rigRoot = mkdtempSync(join(home, "rig-"));
    if (agentYaml !== undefined) { mkdirSync(join(rigRoot, "agents", "impl"), { recursive: true }); writeFileSync(join(rigRoot, "agents", "impl", "agent.yaml"), agentYaml); }
    const setup = createTestApp(db, { podInstantiatorFsOps: { exists: (p) => existsSync(p), readFile: (p) => readFileSync(p, "utf8") } });
    const rig = setup.rigRepo.createRig("follow-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-follow", rig.id, "dev", "Development");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-follow", cwd: rigRoot,
      ...(opts.recipe === false ? {} : { launchRecipe: { version: 1 as const, rigRoot, rigSpec: { version: "0.2", name: "follow-rig",
        pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
        edges: [] } } }) });
    return { db, setup, rigId: rig.id, nodeId: node.id, rigRoot };
  }

  it("lists every skill the profile selects today, and which follow their source, with the source's full path", async () => {
    const { db, setup, rigId, nodeId, rigRoot } = seatWithRecipe(`name: impl
version: "1.0"
resources:
  skills:
    - id: infra-review
      path: skills/infra-review
      on_restore: follow_source
    - id: tdd
      path: skills/tdd
    - id: unused
      path: skills/unused
      on_restore: follow_source
profiles:
  default:
    uses:
      skills: [infra-review, tdd]
`);
    for (const id of ["infra-review", "tdd", "unused"]) {
      mkdirSync(join(rigRoot, "agents", "impl", "skills", id), { recursive: true });
      writeFileSync(join(rigRoot, "agents", "impl", "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\n`);
    }
    try {
      const out = await setup.podInstantiator.seatSkillSelection(rigId, nodeId);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect([...out.selection.selected].sort()).toEqual(["infra-review", "tdd"]);
      expect(out.selection.following).toEqual([{ id: "infra-review", source: join(rigRoot, "agents", "impl", "skills", "infra-review") }]);
    } finally { db.close(); }
  });

  it("resolves local:. against the saved launch directory, not a same-name spec in the seat's cwd", async () => {
    const { db, setup, rigId, nodeId, rigRoot } = seatWithRecipe(undefined);
    const spec = (id: string) => `name: impl\nversion: "1.0"\nresources:\n  skills:\n    - id: ${id}\n      path: skills/${id}\n      on_restore: follow_source\nprofiles:\n  default:\n    uses:\n      skills: [${id}]\n`;
    const cwd = join(rigRoot, "other");
    for (const [folder, id] of [[rigRoot, "correct"], [cwd, "wrong"]]) {
      mkdirSync(join(folder!, "skills", id!), { recursive: true });
      writeFileSync(join(folder!, "agent.yaml"), spec(id!));
      writeFileSync(join(folder!, "skills", id!, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\n`);
    }
    const recipe = setup.rigRepo.getNodeLaunchRecipe(nodeId)!;
    recipe.rigSpec.pods[0]!.members[0]!.agentRef = "local:.";
    db.prepare("UPDATE nodes SET cwd = ?, launch_recipe_json = ? WHERE id = ?").run(cwd, JSON.stringify(recipe), nodeId);
    try {
      const result = await setup.podInstantiator.seatSkillSelection(rigId, nodeId);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.selection.following).toEqual([{ id: "correct", source: join(rigRoot, "skills", "correct") }]);
    } finally { db.close(); }
  });

  it("finds a following skill declared in an imported spec and selected by its qualified name", async () => {
    const { db, setup, rigId, nodeId, rigRoot } = seatWithRecipe(`name: impl
version: "1.0"
imports:
  - ref: local:../../shared
profiles:
  default:
    uses:
      skills: [team-skills:infra-review, team-skills:tdd]
`);
    const shared = join(rigRoot, "shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "agent.yaml"), `name: team-skills
version: "1.0"
resources:
  skills:
    - id: infra-review
      path: vendor/infra-review
      on_restore: follow_source
    - id: tdd
      path: vendor/tdd
`);
    for (const id of ["infra-review", "tdd"]) {
      mkdirSync(join(shared, "vendor", id), { recursive: true });
      writeFileSync(join(shared, "vendor", id, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\n`);
    }
    try {
      const out = await setup.podInstantiator.seatSkillSelection(rigId, nodeId);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return;
      // An imported skill keeps its qualified name, which is also its folder in the seat's storage.
      expect([...out.selection.selected].sort()).toEqual(["team-skills:infra-review", "team-skills:tdd"]);
      expect(out.selection.following).toEqual([{ id: "team-skills:infra-review", source: join(shared, "vendor", "infra-review") }]);
    } finally { db.close(); }
  });

  it("says why when it can't: no launch recipe, or an agent spec that is gone or invalid", async () => {
    const cases = [
      seatWithRecipe(undefined, { recipe: false }),
      seatWithRecipe(undefined),
      seatWithRecipe(`name: impl\nversion: "1.0"\nresources:\n  skills:\n    - id: x\n      on_restore: follow_source\nprofiles:\n  default: {}\n`),
    ];
    try {
      const reasons = [];
      for (const c of cases) {
        const out = await c.setup.podInstantiator.seatSkillSelection(c.rigId, c.nodeId);
        expect(out.ok).toBe(false);
        if (!out.ok) reasons.push(out.reason);
      }
      expect(reasons[0]).toContain("no launch recipe");
      expect(reasons[1]).toContain("agent.yaml");
      expect(reasons[2]).toContain("path");
    } finally { for (const c of cases) c.db.close(); }
  });
});
