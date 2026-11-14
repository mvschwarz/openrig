// An upgrade changes OpenRig's own packaged skills (the vendored openrig-core plugin). After `rig down` and
// `rig up --existing`, a seat that held OpenRig's unedited copies gets the current packaged bytes back, under the
// loadout's own record, instead of having the changed skills named missing. An edit, an unrecorded file, a skill the
// profile selects itself and another plugin's skill stay exactly as before.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanSeatSkills, ensureSeatSkillPlugin, followSeatSkills, packagedSeatSkills, rehydrateSeatSkills, seatSkillLocation, seatSkillPaths,
} from "../src/domain/seat-skill-storage.js";
import { reconcileSkillLoadout, resolvePluginSkills, type SkillLoadout } from "../src/domain/skill-catalog.js";

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

  function seatWithLaunch() {
    const pluginsDir = join(home, "plugins");
    const core = join(pluginsDir, "openrig-core");
    const other = join(home, "shared", "other-plugin");
    plugin(core, {
      "claude-compaction-restore": { "SKILL.md": "restore v1", "scripts/precompact-hook.mjs": "hook v1" },
      "seat-continuity-and-handover": { "SKILL.md": "handover v1" },
      "queue-handoff": { "SKILL.md": "queue v1" },
    });
    plugin(other, { "third-party": { "SKILL.md": "third v1" } });
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
    if (runtime === "claude-code") ensureSeatSkillPlugin(paths);
    // The launch: one loadout of both plugins' skills, written into the seat's storage and recorded.
    const launch = { ...loadoutOf("openrig-core", core), entries: [...loadoutOf("openrig-core", core).entries, ...loadoutOf("other-plugin", other).entries] };
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
    return { paths, core, copy, upgrade, restore, pluginsDir, loadout: () => loadoutOf("openrig-core", core) };
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
});
