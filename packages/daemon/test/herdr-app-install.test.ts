import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeModInstall, installRigMods, RIG_MODS, SHIPPED_MODS_DIR } from "../src/domain/terminal/herdr-app-install.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "herdr-app-install-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("installRigMods", () => {
  it("installs the shipped mods, then leaves them alone when current", async () => {
    const first = await installRigMods(home);
    expect(first).toMatchObject({ ok: true, installed: [...RIG_MODS], refused: [] });
    for (const name of RIG_MODS) {
      expect(readFileSync(join(home, "mods", name, "main.js"), "utf8")).toBe(readFileSync(join(SHIPPED_MODS_DIR, name, "main.js"), "utf8"));
    }
    expect(await installRigMods(home)).toMatchObject({ ok: true, installed: [], updated: [], unchanged: [...RIG_MODS] });
    expect(readdirSync(join(home, "mods")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  function shipped(version: string, extra: Record<string, string> = {}) {
    const dir = join(home, `shipped-${version}`);
    for (const name of RIG_MODS) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "main.js"), `// ${version} ${name}`);
      writeFileSync(join(dir, name, "mod.json"), "{}");
      for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, name, file), text);
    }
    return dir;
  }

  it("updates only OpenRig's own files; a personal subfolder, dotfile, symlink and herdr-app's jsconfig keep their bytes (QA)", async () => {
    await installRigMods(home, { shippedDir: shipped("v1") });
    const strip = join(home, "mods", "rig-strip");
    mkdirSync(join(strip, "personal"));
    writeFileSync(join(strip, "personal", "keep.txt"), "personal data");
    writeFileSync(join(strip, ".notes"), "dot");
    writeFileSync(join(strip, "jsconfig.json"), "{}");
    symlinkSync("/etc/hostname", join(strip, "link"));
    const result = await installRigMods(home, { shippedDir: shipped("v2") });
    expect(result).toMatchObject({ ok: true, updated: [...RIG_MODS] });
    expect(readFileSync(join(strip, "main.js"), "utf8")).toBe("// v2 rig-strip");
    expect(readFileSync(join(strip, "personal", "keep.txt"), "utf8")).toBe("personal data");
    expect(readFileSync(join(strip, ".notes"), "utf8")).toBe("dot");
    expect(readFileSync(join(strip, "jsconfig.json"), "utf8")).toBe("{}");
    expect(readlinkSync(join(strip, "link"))).toBe("/etc/hostname");
    expect(readdirSync(strip).filter((n) => n.includes(".openrig-"))).toEqual([]);
  });

  it("removes a file OpenRig shipped before and no longer ships, and nothing else", async () => {
    await installRigMods(home, { shippedDir: shipped("v1", { "old.js": "// ours" }) });
    writeFileSync(join(home, "mods", "rig-pad", "mine.js"), "// the person's");
    await installRigMods(home, { shippedDir: shipped("v2") });
    expect(existsSync(join(home, "mods", "rig-pad", "old.js"))).toBe(false);
    expect(readFileSync(join(home, "mods", "rig-pad", "mine.js"), "utf8")).toBe("// the person's");
  });

  it("leaves a mod whose file is now a link or a folder, or was changed, as it is, and still updates the others", async () => {
    await installRigMods(home, { shippedDir: shipped("v1") });
    rmSync(join(home, "mods", "rig-strip", "main.js"));
    symlinkSync("/etc/hostname", join(home, "mods", "rig-strip", "main.js"));
    writeFileSync(join(home, "mods", "rig-ended", "mod.json"), "{\"place\":\"left\"}");
    const result = await installRigMods(home, { shippedDir: shipped("v2") });
    expect(result).toMatchObject({ ok: true, missing: [], updated: ["rig-cell-header", "rig-pad"] });
    expect(result.refused.map((r) => r.name).sort()).toEqual(["rig-ended", "rig-strip"]);
    expect(readlinkSync(join(home, "mods", "rig-strip", "main.js"))).toBe("/etc/hostname");
    expect(readFileSync(join(home, "mods", "rig-ended", "mod.json"), "utf8")).toBe("{\"place\":\"left\"}");
    expect(readFileSync(join(home, "mods", "rig-pad", "main.js"), "utf8")).toBe("// v2 rig-pad");
  });

  it("never writes through a mod folder that is a link, even to an unchanged copy of OpenRig's files", async () => {
    await installRigMods(home, { shippedDir: shipped("v1") });
    const dotfiles = join(home, "dotfiles-rig-strip");
    renameSync(join(home, "mods", "rig-strip"), dotfiles);
    symlinkSync(dotfiles, join(home, "mods", "rig-strip"));
    const result = await installRigMods(home, { shippedDir: shipped("v2") });
    expect(result).toMatchObject({ ok: true, missing: [] });
    expect(result.refused).toEqual([expect.objectContaining({ name: "rig-strip", reason: expect.stringContaining("is a link") })]);
    expect(readFileSync(join(dotfiles, "main.js"), "utf8")).toBe("// v1 rig-strip");
  });

  it("never replaces a mod folder someone made or changed, and installs the others", async () => {
    mkdirSync(join(home, "mods", "rig-pad"), { recursive: true });
    writeFileSync(join(home, "mods", "rig-pad", "main.js"), "// the person's own rig-pad");
    const result = await installRigMods(home);
    expect(result).toMatchObject({ ok: true, missing: [], installed: ["rig-strip", "rig-cell-header", "rig-ended"] });
    expect(result.refused).toEqual([expect.objectContaining({ name: "rig-pad", reason: expect.stringContaining("left as it is") })]);
    expect(readFileSync(join(home, "mods", "rig-pad", "main.js"), "utf8")).toBe("// the person's own rig-pad");
    expect(readdirSync(join(home, "mods")).sort()).toEqual([...RIG_MODS].sort());
    expect(describeModInstall(result)).toMatch(/^OpenRig's herdr-app mods: installed rig-strip, rig-cell-header, rig-ended; kept rig-pad unchanged\. .*rig-pad isn't the copy OpenRig installed/);
  });

  it("reports a needed mod that is missing and could not be installed (not shipped, or a link to nothing)", async () => {
    const v1 = shipped("v1");
    rmSync(join(v1, "rig-pad"), { recursive: true });
    mkdirSync(join(home, "mods"), { recursive: true });
    symlinkSync(join(home, "nowhere"), join(home, "mods", "rig-ended"));
    const result = await installRigMods(home, { shippedDir: v1 });
    expect(result.ok).toBe(false);
    expect(result.missing.sort()).toEqual(["rig-ended", "rig-pad"]);
    expect(result.installed).toEqual(["rig-strip", "rig-cell-header"]);
    expect(describeModInstall(result)).toMatch(/^OpenRig's herdr-app mods rig-(pad|ended), rig-(pad|ended) are missing and could not be installed\. .*rig-pad mod is missing from .*is a link/);
  });

  it("opens with a mod the person already has even when OpenRig's own copy of it is missing", async () => {
    await installRigMods(home, { shippedDir: shipped("v1") });
    const v2 = shipped("v2");
    rmSync(join(v2, "rig-pad"), { recursive: true });
    const result = await installRigMods(home, { shippedDir: v2 });
    expect(result).toMatchObject({ ok: true, missing: [], error: expect.stringContaining("rig-pad mod is missing") });
    expect(readFileSync(join(home, "mods", "rig-pad", "main.js"), "utf8")).toBe("// v1 rig-pad");
  });

  it("check mode reports what would change without writing", async () => {
    expect((await installRigMods(home, { check: true })).ok).toBe(false);
    expect(() => readdirSync(join(home, "mods"))).toThrow();
  });

  describe("a release that ships a new file name", () => {
    it("refuses to overwrite a person's existing file when a new release ships the same file name with different content", async () => {
      await installRigMods(home, { shippedDir: shipped("v1") });
      const manifestBefore = readFileSync(join(home, "openrig", "mods.json"), "utf8");
      writeFileSync(join(home, "mods", "rig-strip", "extra.js"), "// the person's extra.js");
      const v2 = shipped("v2", { "extra.js": "// openrig's extra.js" });
      const result = await installRigMods(home, { shippedDir: v2 });
      expect(result).toMatchObject({ ok: true, missing: [], updated: ["rig-cell-header", "rig-pad", "rig-ended"] });
      expect(result.refused).toEqual([
        expect.objectContaining({
          name: "rig-strip",
          reason: expect.stringContaining("extra.js"),
        }),
      ]);
      expect(readFileSync(join(home, "mods", "rig-strip", "extra.js"), "utf8")).toBe("// the person's extra.js");
      expect(readFileSync(join(home, "mods", "rig-strip", "main.js"), "utf8")).toBe("// v1 rig-strip");
      expect(readFileSync(join(home, "mods", "rig-pad", "main.js"), "utf8")).toBe("// v2 rig-pad");
      // rig-strip's record still describes the copy OpenRig installed there (v1).
      const before = JSON.parse(manifestBefore) as Record<string, unknown>;
      const after = JSON.parse(readFileSync(join(home, "openrig", "mods.json"), "utf8")) as Record<string, unknown>;
      expect(after["rig-strip"]).toEqual(before["rig-strip"]);
    });

    it("adopts a newly shipped file name when the existing file on disk has identical bytes, or when nobody has that name", async () => {
      await installRigMods(home, { shippedDir: shipped("v1") });
      for (const name of RIG_MODS) {
        writeFileSync(join(home, "mods", name, "extra.js"), "// identical extra.js");
      }
      const sameBytes = await installRigMods(home, { shippedDir: shipped("v2", { "extra.js": "// identical extra.js" }) });
      expect(sameBytes).toMatchObject({ ok: true, updated: [...RIG_MODS], refused: [] });
      const manifest = JSON.parse(readFileSync(join(home, "openrig", "mods.json"), "utf8")) as Record<string, { files: string[] }>;
      expect(manifest["rig-strip"]!.files).toContain("extra.js");

      const freshName = await installRigMods(home, { shippedDir: shipped("v3", { "extra.js": "// identical extra.js", "fresh.js": "// brand new" }) });
      expect(freshName).toMatchObject({ ok: true, updated: [...RIG_MODS], refused: [] });
      expect(readFileSync(join(home, "mods", "rig-strip", "fresh.js"), "utf8")).toBe("// brand new");
    });
  });
});

describe("shipped rig-strip mod: strip.json root validation", () => {
  function loadRigStripClass(readTextFile: (path: string) => Promise<string>) {
    const src = readFileSync(join(SHIPPED_MODS_DIR, "rig-strip", "main.js"), "utf8")
      .replace(/^import\s+.*$/gm, "")
      .replace(/export\s+default\s+class\s+RigStrip\s+extends\s+View/, "return class RigStrip extends View");
    class View {}
    const factory = new Function(
      "View",
      "appHome",
      "readTextFile",
      "nextCommand",
      src,
    ) as (
      V: typeof View,
      appHome: () => string,
      readText: (path: string) => Promise<string>,
      nextCmd: () => Promise<string>,
    ) => new () => {
      saved: string | null;
      state: Record<string, unknown>;
      loaded?: boolean;
      init(_p: unknown, cx: { notify(): void; spawn(fn: (cx: unknown) => Promise<void>): void }): void;
    };
    return factory(View, () => home, readTextFile, () => new Promise<string>(() => {}));
  }

  it("rejects non-object strip.json roots (null, array, scalar) and still finishes init with a plain state object", async () => {
    for (const raw of ["null", "[]", "42", "\"text\""]) {
      const RigStrip = loadRigStripClass(async () => raw);
      const strip = new RigStrip();
      let notified = 0;
      strip.init({}, { notify: () => { notified++; }, spawn: () => {} });
      await new Promise((r) => setTimeout(r, 10));
      expect(strip.loaded).toBe(true);
      expect(strip.saved).toBeNull();
      expect(Array.isArray(strip.state)).toBe(false);
      expect(strip.state).toEqual({ cells: {} });
      expect(notified).toBe(1);
    }

    const validJson = JSON.stringify({ cells: { "rv-1": "t1" }, shown: "rv-1" });
    const RigStrip = loadRigStripClass(async () => validJson);
    const strip = new RigStrip();
    strip.init({}, { notify: () => {}, spawn: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(strip.loaded).toBe(true);
    expect(strip.saved).toBe(validJson);
    expect(strip.state).toEqual({ cells: { "rv-1": "t1" }, shown: "rv-1" });
  });
});

describe("installRigMods: scope and coexistence", () => {
  it("leaves non-OpenRig mods (such as my-mod or custom-panel) and openrig/config.json completely untouched", async () => {
    for (const userMod of ["my-mod", "custom-panel"]) {
      mkdirSync(join(home, "mods", userMod), { recursive: true });
      writeFileSync(join(home, "mods", userMod, "main.js"), `// user's own ${userMod}`);
    }
    mkdirSync(join(home, "openrig"), { recursive: true });
    const legacyConfig = `${JSON.stringify({ customKey: "/old/custom/dir", extra: 42 }, null, 2)}\n`;
    writeFileSync(join(home, "openrig", "config.json"), legacyConfig);

    const res = await installRigMods(home);
    expect(res).toMatchObject({ ok: true, from: SHIPPED_MODS_DIR, installed: [...RIG_MODS], refused: [] });
    expect(readFileSync(join(home, "mods", "my-mod", "main.js"), "utf8")).toBe("// user's own my-mod");
    expect(readFileSync(join(home, "mods", "custom-panel", "main.js"), "utf8")).toBe("// user's own custom-panel");
    const manifest = JSON.parse(readFileSync(join(home, "openrig", "mods.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual([...RIG_MODS].sort());
    expect(readFileSync(join(home, "openrig", "config.json"), "utf8")).toBe(legacyConfig);
  });

  it("returns ok:false with the missing mod and an error (without throwing) when a shipped mod folder is missing", async () => {
    const incomplete = join(home, "incomplete-shipped");
    for (const name of RIG_MODS.filter((n) => n !== "rig-pad")) {
      mkdirSync(join(incomplete, name), { recursive: true });
      writeFileSync(join(incomplete, name, "main.js"), "// ok");
      writeFileSync(join(incomplete, name, "mod.json"), "{}");
    }
    const res = await installRigMods(home, { shippedDir: incomplete });
    expect(res).toEqual({
      ok: false,
      from: incomplete,
      error: `OpenRig's rig-pad mod is missing from ${incomplete}; reinstall OpenRig.`,
      missing: ["rig-pad"],
      installed: ["rig-strip", "rig-cell-header", "rig-ended"],
      updated: [],
      unchanged: [],
      refused: [],
    });
    expect(existsSync(join(home, "mods", "rig-pad"))).toBe(false);
  });

  it("treats a malformed manifest entry for one of OpenRig's mods as unrecorded (keeping that folder without throwing) and preserves unrelated manifest keys", async () => {
    mkdirSync(join(home, "mods", "rig-strip"), { recursive: true });
    writeFileSync(join(home, "mods", "rig-strip", "main.js"), "// unrecorded rig-strip");
    mkdirSync(join(home, "openrig"), { recursive: true });
    writeFileSync(join(home, "openrig", "mods.json"), JSON.stringify({
      "rig-strip": { installedAt: 1 },
      mods: ["my-mod", "custom-panel"],
    }));

    const refused = await installRigMods(home);
    expect(refused).toMatchObject({ ok: true, missing: [], installed: ["rig-cell-header", "rig-pad", "rig-ended"] });
    expect(refused.refused).toEqual([
      expect.objectContaining({
        name: "rig-strip",
        reason: expect.stringContaining("left as it is"),
      }),
    ]);

    // After the person removes their conflicting folder, a later install succeeds and keeps the unrelated top-level key
    rmSync(join(home, "mods", "rig-strip"), { recursive: true, force: true });
    const installed = await installRigMods(home);
    expect(installed).toMatchObject({ ok: true, installed: ["rig-strip"], unchanged: ["rig-cell-header", "rig-pad", "rig-ended"] });
    const manifestAfter = JSON.parse(readFileSync(join(home, "openrig", "mods.json"), "utf8")) as Record<string, unknown>;
    expect(manifestAfter.mods).toEqual(["my-mod", "custom-panel"]);
  });
});
