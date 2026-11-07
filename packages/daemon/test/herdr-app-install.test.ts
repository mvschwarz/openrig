import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRigKeys, installRigMods, RIG_MODS, SHIPPED_MODS_DIR } from "../src/domain/terminal/herdr-app-install.js";

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

  it("refuses when one of OpenRig's file names is now a link or a folder, or one of its files was changed", async () => {
    await installRigMods(home, { shippedDir: shipped("v1") });
    rmSync(join(home, "mods", "rig-strip", "main.js"));
    symlinkSync("/etc/hostname", join(home, "mods", "rig-strip", "main.js"));
    writeFileSync(join(home, "mods", "rig-ended", "mod.json"), "{\"place\":\"left\"}");
    const result = await installRigMods(home, { shippedDir: shipped("v2") });
    expect(result.ok).toBe(false);
    expect(result.refused.map((r) => r.name).sort()).toEqual(["rig-ended", "rig-strip"]);
    expect(readlinkSync(join(home, "mods", "rig-strip", "main.js"))).toBe("/etc/hostname");
    expect(readFileSync(join(home, "mods", "rig-pad", "main.js"), "utf8")).toBe("// v1 rig-pad"); // nothing installed that run
  });

  it("never writes through a mod folder that is a link, even to an unchanged copy of OpenRig's files", async () => {
    await installRigMods(home, { shippedDir: shipped("v1") });
    const dotfiles = join(home, "dotfiles-rig-strip");
    renameSync(join(home, "mods", "rig-strip"), dotfiles);
    symlinkSync(dotfiles, join(home, "mods", "rig-strip"));
    const result = await installRigMods(home, { shippedDir: shipped("v2") });
    expect(result.ok).toBe(false);
    expect(result.refused).toEqual([expect.objectContaining({ name: "rig-strip", reason: expect.stringContaining("is a link") })]);
    expect(readFileSync(join(dotfiles, "main.js"), "utf8")).toBe("// v1 rig-strip");
  });

  it("never replaces a mod folder someone made or changed, and installs nothing else that run", async () => {
    mkdirSync(join(home, "mods", "rig-pad"), { recursive: true });
    writeFileSync(join(home, "mods", "rig-pad", "main.js"), "// the person's own rig-pad");
    const result = await installRigMods(home);
    expect(result.ok).toBe(false);
    expect(result.refused).toEqual([expect.objectContaining({ name: "rig-pad", reason: expect.stringContaining("left as it is") })]);
    expect(readFileSync(join(home, "mods", "rig-pad", "main.js"), "utf8")).toBe("// the person's own rig-pad");
    expect(readdirSync(join(home, "mods"))).toEqual(["rig-pad"]);
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
      expect(result.ok).toBe(false);
      expect(result.refused).toEqual([
        expect.objectContaining({
          name: "rig-strip",
          reason: expect.stringContaining("extra.js"),
        }),
      ]);
      expect(readFileSync(join(home, "mods", "rig-strip", "extra.js"), "utf8")).toBe("// the person's extra.js");
      for (const name of RIG_MODS) {
        expect(readFileSync(join(home, "mods", name, "main.js"), "utf8")).toBe(`// v1 ${name}`);
      }
      expect(readFileSync(join(home, "openrig", "mods.json"), "utf8")).toBe(manifestBefore);
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

describe("installRigKeys (opt-in, reversible)", () => {
  const keys = (value: unknown) => writeFileSync(join(home, "keys.json"), `${JSON.stringify(value, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(join(home, "keys.json"), "utf8")) as Record<string, Record<string, unknown>>;

  it("needs herdr-app's own keys.json and never creates one (that would drop the person's defaults)", async () => {
    const result = await installRigKeys(home);
    expect(result).toMatchObject({ ok: false, changed: [] });
    expect(result.message).toContain("Start herdr-app once");
    expect(() => readFileSync(join(home, "keys.json"))).toThrow();
  });

  it("binds alt-arrows in layout:rig, keeps every other binding, backs up the file, and says what it costs", async () => {
    keys({ global: { "ctrl-shift-t": "tab.new" }, terminal: { "ctrl-shift-c": "terminal.copy" } });
    const original = readFileSync(join(home, "keys.json"), "utf8");
    const result = await installRigKeys(home);
    expect(result).toMatchObject({ ok: true, changed: ["alt-left", "alt-right", "alt-up", "alt-down"], conflicts: [] });
    expect(read()).toEqual({
      global: { "ctrl-shift-t": "tab.new" }, terminal: { "ctrl-shift-c": "terminal.copy" },
      "layout:rig": { "alt-left": "rig-strip.left", "alt-right": "rig-strip.right", "alt-up": "rig-strip.up", "alt-down": "rig-strip.down" },
    });
    expect(readFileSync(result.backup!, "utf8")).toBe(original);
    expect(result.message).toContain("treats keys.json as yours");
  });

  it("binds over herdr-app's own shipped global defaults for these keys, and says what the Rig layout replaces (QA A4)", async () => {
    // herdr-app 0.1.13 defaults/keys.json, as a fresh home has it.
    keys({ global: { "alt-left": "pane.go:left", "alt-right": "pane.go:right", "alt-up": "agent.prev", "alt-down": "agent.next", "ctrl-shift-t": "tab.new" } });
    const result = await installRigKeys(home);
    expect(result).toMatchObject({ ok: true, changed: ["alt-left", "alt-right", "alt-up", "alt-down"], conflicts: [] });
    expect(read().global).toMatchObject({ "alt-up": "agent.prev", "alt-down": "agent.next" }); // kept for every other layout
    expect(result.message).toContain("replace herdr-app's defaults alt-left (pane.go:left)");
    // A person's own global binding on one of them still wins.
    keys({ global: { "alt-left": "pane.go:left", "alt-up": "space.prev" } });
    const mine = await installRigKeys(home);
    expect(mine.conflicts.map((c) => c.key)).toEqual(["alt-up"]);
  });

  it("leaves conflicting keys alone and names why: a binding in layout:rig, in terminal (wins over a cell), or in global", async () => {
    keys({ terminal: { "alt-left": "send:\u001bb" }, global: { "alt-up": "space.prev" }, "layout:rig": { "alt-down": "layout.reset" } });
    const result = await installRigKeys(home);
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual(["alt-right"]);
    expect(result.conflicts.map((c) => c.key)).toEqual(["alt-left", "alt-up", "alt-down"]);
    expect(read()["layout:rig"]).toEqual({ "alt-down": "layout.reset", "alt-right": "rig-strip.right" });
  });

  it("--remove takes away only OpenRig's bindings, and removes the section when nothing else is in it", async () => {
    keys({ global: { "ctrl-shift-t": "tab.new" }, "layout:rig": { "ctrl-x": "layout.reset" } });
    await installRigKeys(home);
    const removed = await installRigKeys(home, { remove: true });
    expect(removed).toMatchObject({ ok: true, changed: ["alt-left", "alt-right", "alt-up", "alt-down"] });
    expect(read()).toEqual({ global: { "ctrl-shift-t": "tab.new" }, "layout:rig": { "ctrl-x": "layout.reset" } });
    keys({ global: {} });
    await installRigKeys(home);
    await installRigKeys(home, { remove: true });
    expect(read()).toEqual({ global: {} });
  });

  it("leaves an unreadable keys.json untouched", async () => {
    writeFileSync(join(home, "keys.json"), "{ not json");
    expect((await installRigKeys(home)).ok).toBe(false);
    expect(readFileSync(join(home, "keys.json"), "utf8")).toBe("{ not json");
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

  it("returns ok:false with an error (without throwing or writing) when a shipped mod folder is missing", async () => {
    const incomplete = join(home, "incomplete-shipped");
    for (const name of RIG_MODS.filter((n) => n !== "rig-pad")) {
      mkdirSync(join(incomplete, name), { recursive: true });
      writeFileSync(join(incomplete, name, "main.js"), "// ok");
      writeFileSync(join(incomplete, name, "mod.json"), "{}");
    }
    const res = await installRigMods(home, { shippedDir: incomplete });
    expect(res).toEqual({
      ok: false,
      error: `OpenRig's rig-pad mod is missing from ${incomplete}; reinstall OpenRig.`,
      installed: [],
      updated: [],
      unchanged: [],
      refused: [],
    });
    expect(existsSync(join(home, "mods"))).toBe(false);
  });

  it("treats a malformed manifest entry for one of OpenRig's mods as unrecorded (refusing without throwing) and preserves unrelated manifest keys", async () => {
    mkdirSync(join(home, "mods", "rig-strip"), { recursive: true });
    writeFileSync(join(home, "mods", "rig-strip", "main.js"), "// unrecorded rig-strip");
    mkdirSync(join(home, "openrig"), { recursive: true });
    writeFileSync(join(home, "openrig", "mods.json"), JSON.stringify({
      "rig-strip": { installedAt: 1 },
      mods: ["my-mod", "custom-panel"],
    }));

    const refused = await installRigMods(home);
    expect(refused.ok).toBe(false);
    expect(refused.refused).toEqual([
      expect.objectContaining({
        name: "rig-strip",
        reason: expect.stringContaining("left as it is"),
      }),
    ]);

    // After the person removes their conflicting folder, a later install succeeds and keeps the unrelated top-level key
    rmSync(join(home, "mods", "rig-strip"), { recursive: true, force: true });
    const installed = await installRigMods(home);
    expect(installed).toMatchObject({ ok: true, installed: [...RIG_MODS] });
    const manifestAfter = JSON.parse(readFileSync(join(home, "openrig", "mods.json"), "utf8")) as Record<string, unknown>;
    expect(manifestAfter.mods).toEqual(["my-mod", "custom-panel"]);
  });
});
