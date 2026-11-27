// An upgrade changes OpenRig's own packaged skills (the vendored openrig-core plugin). After `rig down` and
// `rig up --existing`, a seat that held OpenRig's unedited copies gets the current packaged bytes back, under the
// loadout's own record, instead of having the changed skills named missing. An edit, an unrecorded file, a skill the
// profile selects itself and another plugin's skill stay exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanSeatSkills, ensureSeatSkillPlugin, followSeatSkills, packagedSeatSkills, rehydrateSeatSkills, seatSkillLocation, seatSkillPaths,
} from "../src/domain/seat-skill-storage.js";
import { reconcileSkillLoadout, resolvePluginSkills, type SkillLoadout } from "../src/domain/skill-catalog.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const runtimes = ["claude-code", "codex"] as const;

describe.each(runtimes)("an upgrade keeps OpenRig's packaged skills on a %s seat", (runtime) => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-packaged-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  /** A plugin as OpenRig vendors it, with each skill's files. */
  function plugin(root: string, skills: Record<string, Record<string, string>>) {
    for (const dir of [".claude-plugin", ".codex-plugin"]) put(join(root, dir, "plugin.json"), JSON.stringify({ name: root.split("/").at(-1), version: "1.0.0" }));
    for (const [id, files] of Object.entries(skills)) {
      for (const [rel, text] of Object.entries(files)) put(join(root, "skills", id, rel), rel === "SKILL.md" ? `---\nname: ${id}\ndescription: ${id}\n---\n${text}` : text);
    }
  }
  const loadoutOf = (pluginId: string, root: string): SkillLoadout => ({
    catalogRoot: root, catalogRevision: null, catalogDigest: null, projectSelectionDeclared: false, projectSelection: [],
    entries: resolvePluginSkills({ pluginId, pluginRoot: root, runtime }).entries,
  });

  function seatWithLaunch(opts: { otherSkills?: Record<string, Record<string, string>>; launchFrom?: (core: SkillLoadout["entries"], other: SkillLoadout["entries"]) => SkillLoadout["entries"]; launchThroughAlias?: boolean; beforeLaunch?: (core: string) => void } = {}) {
    const pluginsDir = join(home, "plugins");
    const core = join(pluginsDir, "openrig-core");
    const other = join(home, "shared", "other-plugin");
    plugin(core, {
      "claude-compaction-restore": { "SKILL.md": "restore v1", "scripts/precompact-hook.mjs": "hook v1" },
      "seat-continuity-and-handover": { "SKILL.md": "handover v1" },
      "queue-handoff": { "SKILL.md": "queue v1" },
    });
    plugin(other, opts.otherSkills ?? { "third-party": { "SKILL.md": "third v1" } });
    opts.beforeLaunch?.(core);
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
    if (runtime === "claude-code") ensureSeatSkillPlugin(paths);
    // The launch: one loadout of both plugins' skills, written into the seat's storage and recorded.
    // A launch can record the vendored plugin through another spelling of the same folder (a linked alias).
    const launchRoot = opts.launchThroughAlias ? join(home, "core-alias") : core;
    if (opts.launchThroughAlias) symlinkSync(core, launchRoot);
    const coreEntries = loadoutOf("openrig-core", launchRoot).entries;
    const otherEntries = loadoutOf("other-plugin", other).entries;
    const launch = { ...loadoutOf("openrig-core", core), entries: opts.launchFrom ? opts.launchFrom(coreEntries, otherEntries) : [...coreEntries, ...otherEntries] };
    const applied = reconcileSkillLoadout({ loadout: launch, runtime, cwd: home, apply: true, location: seatSkillLocation(paths, runtime) });
    expect(applied.ok).toBe(true);
    const copy = (id: string, rel = "SKILL.md") => readFileSync(join(paths.skillsRoot, id, rel), "utf8");
    /** The upgrade: OpenRig's packaged copies of the two recovery skills change; the other plugin's skill changes too. */
    const upgrade = () => {
      put(join(core, "skills", "claude-compaction-restore", "SKILL.md"), "---\nname: claude-compaction-restore\ndescription: x\n---\nrestore v2");
      put(join(core, "skills", "seat-continuity-and-handover", "SKILL.md"), "---\nname: seat-continuity-and-handover\ndescription: x\n---\nhandover v2");
      put(join(other, "skills", "third-party", "SKILL.md"), "---\nname: third-party\ndescription: x\n---\nthird v2");
    };
    /** `rig up --existing`: today's selection, the follow, then the saved selection put back. */
    const restore = (ownIds: ReadonlySet<string> = new Set()) => {
      const today = [...loadoutOf("openrig-core", core).entries, ...loadoutOf("other-plugin", other).entries];
      const followed = followSeatSkills(paths, { selected: ownIds, following: [], packaged: packagedSeatSkills(today, ownIds, pluginsDir) });
      return { followed, rehydrated: rehydrateSeatSkills(paths) };
    };
    return { paths, core, other, copy, upgrade, restore, pluginsDir, loadout: () => loadoutOf("openrig-core", core) };
  }

  it("brings both changed recovery skills back with today's packaged bytes, and leaves the unchanged ones byte-identical", () => {
    const s = seatWithLaunch();
    cleanSeatSkills(s.paths); // rig down on the old version removes OpenRig's unchanged copies
    expect(existsSync(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"))).toBe(false);
    s.upgrade();
    const { followed, rehydrated } = s.restore();
    expect(followed.warnings).toContain("Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore, seat-continuity-and-handover");
    expect(s.copy("claude-compaction-restore")).toContain("restore v2");
    expect(s.copy("claude-compaction-restore", "scripts/precompact-hook.mjs")).toBe("hook v1");
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v2");
    expect(s.copy("queue-handoff")).toContain("queue v1");
    // Only the other plugin's changed skill is named missing, as before: OpenRig doesn't rewrite a third-party skill.
    expect(rehydrated.missing).toEqual([join(s.paths.skillsRoot, "third-party", "SKILL.md")]);
    // The loadout still owns the copies, at today's bytes, so a later launch reads them as current.
    const later = reconcileSkillLoadout({ loadout: s.loadout(), runtime, cwd: home, apply: false, location: seatSkillLocation(s.paths, runtime) });
    expect(later.receipts.filter(r => r.id !== "third-party").map(r => [r.id, r.status])).toEqual([
      ["claude-compaction-restore", "current"], ["queue-handoff", "current"], ["seat-continuity-and-handover", "current"]]);
  });

  it("brings an old copy up to today's bytes when the upgrade came before rig down", () => {
    const s = seatWithLaunch();
    s.upgrade();
    cleanSeatSkills(s.paths); // the source moved on, so rig down keeps the saved copy
    expect(s.copy("claude-compaction-restore")).toContain("restore v1");
    const { followed, rehydrated } = s.restore();
    expect(followed.warnings).toContain("Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore, seat-continuity-and-handover");
    expect(s.copy("claude-compaction-restore")).toContain("restore v2");
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v2");
    expect(rehydrated.kept).toEqual([]);
  });

  it("keeps a person's edit to a packaged skill, and names it", () => {
    const s = seatWithLaunch();
    put(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"), "my own notes");
    cleanSeatSkills(s.paths); // rig down keeps the edited copy
    s.upgrade();
    const { followed, rehydrated } = s.restore();
    expect(s.copy("claude-compaction-restore")).toBe("my own notes");
    expect(followed.warnings.join("\n")).toContain(`${join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md")} was edited`);
    expect(rehydrated.kept).toContain(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"));
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v2");
  });

  it("keeps a packaged skill's folder that holds a file OpenRig didn't write, and names it", () => {
    const s = seatWithLaunch();
    put(join(s.paths.skillsRoot, "seat-continuity-and-handover", "my-notes.md"), "mine");
    cleanSeatSkills(s.paths);
    s.upgrade();
    const { followed, rehydrated } = s.restore();
    expect(followed.warnings.join("\n")).toContain("my-notes.md is not a file OpenRig wrote");
    expect(s.copy("seat-continuity-and-handover", "my-notes.md")).toBe("mine");
    // Nothing is written into that folder: its SKILL.md is named missing, as before.
    expect(rehydrated.missing).toContain(join(s.paths.skillsRoot, "seat-continuity-and-handover", "SKILL.md"));
    expect(s.copy("claude-compaction-restore")).toContain("restore v2");
  });

  it("leaves a skill the profile selects itself to its own restore policy", () => {
    const s = seatWithLaunch();
    cleanSeatSkills(s.paths);
    s.upgrade();
    const own = new Set(["claude-compaction-restore"]);
    expect(packagedSeatSkills(s.loadout().entries, own, s.pluginsDir).map(p => p.id)).toEqual(["queue-handoff", "seat-continuity-and-handover"]);
    const { rehydrated } = s.restore(own);
    expect(rehydrated.missing).toContain(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"));
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v2");
  });

  it("keeps the saved copy and today's behaviour when the packaged source can't be read", () => {
    const s = seatWithLaunch();
    cleanSeatSkills(s.paths);
    s.upgrade();
    const today = packagedSeatSkills(s.loadout().entries, new Set(), s.pluginsDir);
    rmSync(join(s.core, "skills", "claude-compaction-restore"), { recursive: true });
    const followed = followSeatSkills(s.paths, { selected: new Set(), following: [], packaged: today });
    expect(followed.warnings.join("\n")).toContain("claude-compaction-restore follows OpenRig's packaged source, but");
    expect(rehydrateSeatSkills(s.paths).missing).toContain(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"));
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v2");
  });
  it("keeps a same-name copy the loadout recorded from another source, and names where it came from", () => {
    const s = seatWithLaunch({ otherSkills: { "queue-handoff": { "SKILL.md": "someone else's queue" } },
      launchFrom: (core, other) => [...core.filter((e) => e.id !== "queue-handoff"), ...other] });
    cleanSeatSkills(s.paths);
    s.upgrade();
    const { followed } = s.restore();
    expect(followed.warnings).toContain(`Restore: kept ${join(s.paths.skillsRoot, "queue-handoff")} as it is: it was recorded from ${s.other}, not OpenRig's packaged source`);
    expect(s.copy("queue-handoff")).toContain("someone else's queue");
    // The loadout's record is still one the reconciler reads: nothing rewrote it under the wrong source.
    const record = JSON.parse(readFileSync(s.paths.manifestPath, "utf8")).skills.find((e: Record<string, unknown>) => e.id === "queue-handoff");
    expect([record.sourceRoot, record.sourceDir]).toEqual([s.other, join(s.other, "skills", "queue-handoff")]);
    expect(() => reconcileSkillLoadout({ loadout: s.loadout(), runtime, cwd: home, apply: false, location: seatSkillLocation(s.paths, runtime) })).not.toThrow();
    expect(s.copy("claude-compaction-restore")).toContain("restore v2");
  });

  it("keeps a copy the seat's projection record also names, and names that record", () => {
    const s = seatWithLaunch();
    const file = join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md");
    put(s.paths.projectionsPath, JSON.stringify({ files: { [file]: { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), source: join(s.core, "skills", "claude-compaction-restore", "SKILL.md") } } }));
    cleanSeatSkills(s.paths);
    s.upgrade();
    const { followed } = s.restore();
    expect(followed.warnings).toContain(`Restore: kept ${join(s.paths.skillsRoot, "claude-compaction-restore")} as it is: it's also recorded as a projection in ${s.paths.projectionsPath}`);
    expect(existsSync(file)).toBe(false);
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v2");
  });

  it("records the new copy before writing it, so a write that fails part way is put back in the same restore", () => {
    const s = seatWithLaunch();
    cleanSeatSkills(s.paths);
    s.upgrade();
    const write = fs.writeFileSync;
    // The second file of claude-compaction-restore fails, after its SKILL.md is in.
    const failing = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes(join("claude-compaction-restore", "scripts", "precompact-hook.mjs"))) throw new Error("ENOSPC: no space left on device");
      return (write as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    let followed: ReturnType<typeof followSeatSkills>;
    const today = [...loadoutOf("openrig-core", s.core).entries, ...loadoutOf("other-plugin", s.other).entries];
    try { followed = followSeatSkills(s.paths, { selected: new Set(), following: [], packaged: packagedSeatSkills(today, new Set(), s.pluginsDir) }); }
    finally { failing.mockRestore(); }
    expect(followed.warnings).toContain("Restore: brought OpenRig's packaged skills up to the current packaged source: seat-continuity-and-handover");
    expect(followed.warnings).toContain("Restore: claude-compaction-restore stopped part way to OpenRig's packaged source (ENOSPC: no space left on device): 1 of 2 files written; the new copy is recorded, and rehydration tries the rest from the packaged source and reports any it can't restore");
    expect(followed.warnings.join("\n")).not.toContain("kept");
    expect(existsSync(join(s.paths.skillsRoot, "claude-compaction-restore", "scripts", "precompact-hook.mjs"))).toBe(false);
    // The rehydration that follows in the same restore tries the gap from the recorded packaged source; here it can write.
    const rehydrated = rehydrateSeatSkills(s.paths);
    expect(rehydrated.restored).toContain(join(s.paths.skillsRoot, "claude-compaction-restore", "scripts", "precompact-hook.mjs"));
    expect(rehydrated.kept).toEqual([]);
    expect(s.copy("claude-compaction-restore")).toContain("restore v2");
    expect(s.copy("claude-compaction-restore", "scripts/precompact-hook.mjs")).toBe("hook v1");
    // A later restore finds nothing left to do, and a later launch reads every packaged copy as current.
    expect(s.restore().followed.warnings).toEqual([]);
    const later = reconcileSkillLoadout({ loadout: s.loadout(), runtime, cwd: home, apply: false, location: seatSkillLocation(s.paths, runtime) });
    expect(later.receipts.filter((r) => r.id !== "third-party").map((r) => r.status)).toEqual(["current", "current", "current"]);
  });

  it.skipIf(process.platform === "win32")("keeps a copy whose file mode the seat changed, and names it", () => {
    const s = seatWithLaunch();
    chmodSync(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"), 0o755); // part of a copy rig down leaves in part
    chmodSync(join(s.paths.skillsRoot, "seat-continuity-and-handover", "SKILL.md"), 0o755); // a copy rig down leaves whole
    s.upgrade();
    cleanSeatSkills(s.paths); // the sources moved on, so both changed SKILL.md files stay
    const { followed } = s.restore();
    expect(followed.warnings).toContain(`Restore: kept ${join(s.paths.skillsRoot, "claude-compaction-restore")} as it is: ${join(s.paths.skillsRoot, "claude-compaction-restore")} has file modes OpenRig didn't write`);
    expect(followed.warnings).toContain(`Restore: kept ${join(s.paths.skillsRoot, "seat-continuity-and-handover")} as it is: ${join(s.paths.skillsRoot, "seat-continuity-and-handover")} has file modes OpenRig didn't write`);
    expect(statSync(join(s.paths.skillsRoot, "seat-continuity-and-handover", "SKILL.md")).mode & 0o777).toBe(0o755);
    expect(s.copy("seat-continuity-and-handover")).toContain("handover v1");
  });

  it.skipIf(process.platform === "win32")("keeps a seat's mode change on a helper the upgrade removed, and names it", () => {
    const s = seatWithLaunch();
    const helper = join(s.paths.skillsRoot, "claude-compaction-restore", "scripts", "precompact-hook.mjs");
    chmodSync(helper, 0o751);
    rmSync(join(s.core, "skills", "claude-compaction-restore", "scripts"), { recursive: true }); // the upgrade drops the helper
    cleanSeatSkills(s.paths); // SKILL.md is unchanged, so it goes; the helper's source is gone, so it stays
    expect(existsSync(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"))).toBe(false);
    const { followed } = s.restore();
    expect(followed.warnings).toContain(`Restore: kept ${join(s.paths.skillsRoot, "claude-compaction-restore")} as it is: ${join(s.paths.skillsRoot, "claude-compaction-restore")} has file modes OpenRig didn't write`);
    expect(statSync(helper).mode & 0o777).toBe(0o751);
  });

  it.skipIf(process.platform === "win32")("follows an upgrade that changed one file's bytes and mode, when it came before rig down", () => {
    const s = seatWithLaunch();
    const source = join(s.core, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs");
    put(source, "hook v2");
    chmodSync(source, 0o755);
    cleanSeatSkills(s.paths); // the helper's source moved on, so it stays as OpenRig wrote it; SKILL.md goes
    const { followed } = s.restore();
    expect(followed.warnings).toContain("Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore");
    const helper = join(s.paths.skillsRoot, "claude-compaction-restore", "scripts", "precompact-hook.mjs");
    expect([readFileSync(helper, "utf8"), statSync(helper).mode & 0o777]).toEqual(["hook v2", 0o755]);
  });

  it.skipIf(process.platform === "win32")("records a copy launched through a linked alias of the packaged folder under today's spelling", () => {
    const s = seatWithLaunch({ launchThroughAlias: true });
    const before = JSON.parse(readFileSync(s.paths.manifestPath, "utf8")).skills.find((e: Record<string, unknown>) => e.id === "claude-compaction-restore");
    expect(before.sourceRoot).toBe(join(home, "core-alias"));
    cleanSeatSkills(s.paths);
    s.upgrade();
    const { followed } = s.restore();
    expect(followed.warnings).toContain("Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore, seat-continuity-and-handover");
    const after = JSON.parse(readFileSync(s.paths.manifestPath, "utf8")).skills.find((e: Record<string, unknown>) => e.id === "claude-compaction-restore");
    expect([after.sourceRoot, after.sourceDir]).toEqual([s.core, join(s.core, "skills", "claude-compaction-restore")]);
    // The reconciler parses the record (its folder is inside its root) and reads the followed copies as current.
    const later = reconcileSkillLoadout({ loadout: s.loadout(), runtime, cwd: home, apply: false, location: seatSkillLocation(s.paths, runtime) });
    expect(later.receipts.filter((r) => r.id !== "third-party").map((r) => [r.id, r.status])).toEqual([
      ["claude-compaction-restore", "current"], ["queue-handoff", "current"], ["seat-continuity-and-handover", "current"]]);
  });

  it.skipIf(process.platform === "win32")("follows a packaged change to a file's mode alone", () => {
    const s = seatWithLaunch();
    chmodSync(join(s.core, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs"), 0o755);
    const { followed } = s.restore(); // the copy is whole: no rig down came first
    expect(followed.warnings).toContain("Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore");
    expect(statSync(join(s.paths.skillsRoot, "claude-compaction-restore", "scripts", "precompact-hook.mjs")).mode & 0o777).toBe(0o755);
    const later = reconcileSkillLoadout({ loadout: s.loadout(), runtime, cwd: home, apply: false, location: seatSkillLocation(s.paths, runtime) });
    expect(later.receipts.find((r) => r.id === "claude-compaction-restore")?.status).toBe("current");
  });

  // npm applies the installing shell's umask to a package's files: the vendored plugin's 0644 files and its 0755 helper
  // read 0600 and 0700 after an install under 077. An upgrade installed under another umask changes every packaged mode.
  const installUnder = (core: string, umask: number) => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    for (const file of walk(join(core, "skills"))) chmodSync(file, (file.endsWith(".mjs") ? 0o755 : 0o644) & ~umask);
  };
  const helperIn = (skillsRoot: string) => join(skillsRoot, "claude-compaction-restore", "scripts", "precompact-hook.mjs");
  const modeOf = (file: string) => statSync(file).mode & 0o777;
  /** The launch under one umask; the upgrade under another, changing the helper's bytes; then rig down by the upgraded
   *  daemon, which removes the copies whose bytes the source still has and keeps the helper, whose source moved on. */
  function upgradedUnder(before: number, after: number) {
    const s = seatWithLaunch({ beforeLaunch: (core) => installUnder(core, before) });
    put(helperIn(join(s.core, "skills")), "hook v2");
    installUnder(s.core, after);
    cleanSeatSkills(s.paths);
    expect([existsSync(helperIn(s.paths.skillsRoot)), existsSync(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"))]).toEqual([true, false]);
    return s;
  }
  const BROUGHT_ALL = "Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore, queue-handoff, seat-continuity-and-handover";

  it.each([["077", "022", 0o077, 0o022], ["022", "077", 0o022, 0o077], ["077", "077", 0o077, 0o077]] as const)(
    "follows an upgrade whose install's umask was %s, then %s, when rig down came after it", (_before, _after, before, after) => {
      if (process.platform === "win32") return;
      const s = upgradedUnder(before, after);
      const { followed } = s.restore();
      expect(followed.warnings.filter((warning) => warning.includes("file modes OpenRig didn't write"))).toEqual([]);
      // Under one umask, only the skill whose bytes changed moves; under another, every packaged mode moved too.
      expect(followed.warnings).toContain(before === after
        ? "Restore: brought OpenRig's packaged skills up to the current packaged source: claude-compaction-restore" : BROUGHT_ALL);
      // Today's packaged bytes, at today's packaged modes: what the follow writes.
      expect([readFileSync(helperIn(s.paths.skillsRoot), "utf8"), modeOf(helperIn(s.paths.skillsRoot))]).toEqual(["hook v2", 0o755 & ~after]);
      expect(modeOf(join(s.paths.skillsRoot, "claude-compaction-restore", "SKILL.md"))).toBe(0o644 & ~after);
      const later = reconcileSkillLoadout({ loadout: s.loadout(), runtime, cwd: home, apply: false, location: seatSkillLocation(s.paths, runtime) });
      expect(later.receipts.find((r) => r.id === "claude-compaction-restore")?.status).toBe("current");
    });

  it.each([
    ["its mode", (file: string) => chmodSync(file, 0o750), "has file modes OpenRig didn't write", ["hook v1", 0o750]],
    ["its bytes", (file: string) => writeFileSync(file, "hook (my edit)"), "was edited", ["hook (my edit)", 0o700]],
  ] as const)("still keeps a seat's own change to %s on a present file across an upgrade installed under another umask", (_what, change, why, kept) => {
    if (process.platform === "win32") return;
    const s = upgradedUnder(0o077, 0o022);
    change(helperIn(s.paths.skillsRoot));
    const { followed } = s.restore();
    const dir = join(s.paths.skillsRoot, "claude-compaction-restore");
    const reason = why === "was edited" ? `${helperIn(s.paths.skillsRoot)} was edited` : `${dir} has file modes OpenRig didn't write`;
    expect(followed.warnings).toContain(`Restore: kept ${dir} as it is: ${reason}`);
    expect([readFileSync(helperIn(s.paths.skillsRoot), "utf8"), modeOf(helperIn(s.paths.skillsRoot))]).toEqual(kept);
  });
});

describe("a restore says what resolving the seat's skills today left out", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-packaged-select-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it.skipIf(process.platform === "win32")("carries the resolver's skill warnings from the seat's selection into the restore's warnings", async () => {
    const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
    const pluginRoot = join(home, "plugins", "openrig-core");
    for (const dir of [".claude-plugin", ".codex-plugin"]) put(join(pluginRoot, dir, "plugin.json"), JSON.stringify({ name: "openrig-core", version: "1.0.0" }));
    for (const id of ["claude-compaction-restore", "queue-handoff"]) put(join(pluginRoot, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: ${id}\n---\n${id}`);
    // A link inside a packaged skill: today's resolution leaves that skill out, with a warning.
    symlinkSync(join(pluginRoot, "skills", "queue-handoff", "SKILL.md"), join(pluginRoot, "skills", "claude-compaction-restore", "linked.md"));
    const rigRoot = mkdtempSync(join(home, "rig-"));
    put(join(rigRoot, "agents", "impl", "agent.yaml"), `name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: openrig-core\n      source: { kind: local, path: ${pluginRoot} }\nprofiles:\n  default:\n    uses:\n      plugins: [openrig-core]\n`);
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: { exists: (p) => existsSync(p), readFile: (p) => readFileSync(p, "utf8") } });
      const rig = setup.rigRepo.createRig("packaged-rig");
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-packaged", rig.id, "dev", "Development");
      const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", podId: "pod-packaged", cwd: rigRoot,
        launchRecipe: { version: 1 as const, rigRoot, rigSpec: { version: "0.2", name: "packaged-rig",
          pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
          edges: [] } } });
      const out = await setup.podInstantiator.seatSkillSelection(rig.id, node.id);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return;
      const skipped = (out.selection.warnings ?? []).find((w) => w.startsWith(`plugin_skill_skipped: plugin openrig-core skill at ${join(pluginRoot, "skills", "claude-compaction-restore")}`));
      expect(skipped, JSON.stringify(out.selection.warnings)).toBeDefined();
      const paths = seatSkillPaths({ rigId: rig.id, logicalId: "dev.impl", runtime: "codex" }, home);
      expect(followSeatSkills(paths, out.selection).warnings).toContain(`Restore: ${skipped}`);
    } finally { db.close(); }
  });
});
