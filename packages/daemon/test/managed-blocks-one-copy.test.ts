// A guidance file keeps exactly one copy of each OpenRig-managed block, however often OpenRig writes it: after an editor
// or formatter touched its markers, after copies collected, and when a marker lost its pair. A person's edit is kept.
import { describe, expect, it } from "vitest";
import {
  managedBlockStanding,
  managedBlockText,
  mergeManagedBlock,
  type ManagedBlockMergeFsOps,
} from "../src/domain/managed-blocks.js";
import { managedBlockBodyHash, writeManagedGuidanceBlock, type ManagedBlockRecords } from "../src/domain/managed-block-records.js";
import { restoreMissingGuidance } from "../src/domain/restore-guidance.js";

const FILE = "/repo/AGENTS.md";
const SOURCE = "/specs/culture.md";

/** An in-memory guidance file and source, so nothing here touches a real instruction file. */
function memory(files: Record<string, string>): ManagedBlockMergeFsOps & { files: Record<string, string> } {
  return {
    files,
    exists: (p) => p in files,
    readFile: (p) => files[p]!,
    writeFile: (p, content) => { files[p] = content; },
  };
}

function recordsOf(entries: Record<string, string> = {}): ManagedBlockRecords & { entries: Record<string, string> } {
  return {
    entries,
    get: (file, id) => entries[`${file}#${id}`],
    set: (file, id, body) => { entries[`${file}#${id}`] = managedBlockBodyHash(body); },
  };
}

const count = (text: string, id = "CULTURE.md") => text.split(`<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->`).length - 1;

describe("the writer keeps one copy", () => {
  it("reads markers a formatter rewrapped as the block, and replaces it in place at every launch", () => {
    const touched = "# Notes\n\n<!--\n  BEGIN OpenRig MANAGED BLOCK: CULTURE.md\n-->\nold culture\n<!--   END OpenRig  MANAGED BLOCK:  CULTURE.md -->\n\nafter\n";
    const fs = memory({ [FILE]: touched });
    const sizes: number[] = [];
    const written: unknown[] = [];
    for (let launch = 0; launch < 4; launch++) {
      written.push(mergeManagedBlock(fs, FILE, "CULTURE.md", "new culture"));
      sizes.push(fs.files[FILE]!.length);
    }
    expect(fs.files[FILE]).toBe(`# Notes\n\n${managedBlockText("CULTURE.md", "new culture")}\n\nafter\n`);
    expect(new Set(sizes).size).toBe(1);
    expect(written).toEqual([true, true, true, true]);
  });

  it("collapses copies that collected to the first, and keeps a person's text before, between and after them", () => {
    const block = managedBlockText("CULTURE.md", "culture");
    const fs = memory({ [FILE]: `# Notes\n\n${block}\n\nperson text\n\n${block}\n\n${block}\n\nthe end\n` });
    mergeManagedBlock(fs, FILE, "CULTURE.md", "culture");
    expect(fs.files[FILE]).toBe(`# Notes\n\n${block}\n\nperson text\n\nthe end\n`);
  });

  it.each([
    ["a BEGIN whose END was lost", "# Notes\n\n<!-- BEGIN OpenRig MANAGED BLOCK: CULTURE.md -->\nculture\n<!-- END OpenRig MANAGED BLOCK -->\n"],
    ["an END whose BEGIN was lost", "# Notes\n\n<!-- BEGIN MANAGED BLOCK: CULTURE.md -->\nculture\n<!-- END OpenRig MANAGED BLOCK: CULTURE.md -->\n"],
  ])("adds no copy beside %s, at any launch, and names it", (_name, text) => {
    const fs = memory({ [FILE]: text });
    const warnings: string[] = [];
    const written: unknown[] = [];
    for (let launch = 0; launch < 3; launch++) written.push(mergeManagedBlock(fs, FILE, "CULTURE.md", "culture", { warnings }));
    expect(fs.files[FILE]).toBe(text);
    expect(warnings).toHaveLength(3);
    expect(written).toEqual([false, false, false]);
    expect(warnings[0]).toMatch(/^guidance_block_markers_damaged: \/repo\/AGENTS\.md: CULTURE\.md has a BEGIN or END marker without its pair/);
  });

  it("still replaces a complete copy when a lost marker sits beside it, leaves that marker, and names it", () => {
    const lone = "<!-- BEGIN OpenRig MANAGED BLOCK: CULTURE.md -->\nstray\n";
    const fs = memory({ [FILE]: `${lone}\n${managedBlockText("CULTURE.md", "old")}\n` });
    const warnings: string[] = [];
    const written = mergeManagedBlock(fs, FILE, "CULTURE.md", "new", { warnings });
    expect(fs.files[FILE]).toBe(`${lone}\n${managedBlockText("CULTURE.md", "new")}\n`);
    expect(written).toBe(true);
    expect(warnings).toEqual([expect.stringMatching(/^guidance_block_marker_unpaired: \/repo\/AGENTS\.md: CULTURE\.md was written/)]);
  });

  it("appends to a file with no marker at all, as before", () => {
    const fs = memory({ [FILE]: "# Notes\n" });
    mergeManagedBlock(fs, FILE, "CULTURE.md", "culture");
    expect(fs.files[FILE]).toBe(`# Notes\n\n\n${managedBlockText("CULTURE.md", "culture")}`);
  });

  it("reads a lost marker as damaged, not absent", () => {
    expect(managedBlockStanding("<!-- BEGIN OpenRig MANAGED BLOCK: CULTURE.md -->\nculture\n", "CULTURE.md", "culture", undefined, managedBlockBodyHash))
      .toBe("damaged");
    expect(managedBlockStanding("# no block\n", "CULTURE.md", "culture", undefined, managedBlockBodyHash)).toBe("absent");
  });
});

describe("a launch's guidance write keeps a person's edit and drops only repeats", () => {
  const launch = (fs: ManagedBlockMergeFsOps, records: ManagedBlockRecords, source: string, warnings: string[]) =>
    writeManagedGuidanceBlock(fs, FILE, "CULTURE.md", source, { records, sourcePath: SOURCE, warnings });

  it("refreshes OpenRig's own copies to one", () => {
    const old = managedBlockText("CULTURE.md", "old culture");
    const fs = memory({ [FILE]: `# Notes\n\n${old}\n\n${old}\n` });
    const records = recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("old culture") });
    expect(launch(fs, records, "new culture", [])).toBe(true);
    expect(fs.files[FILE]).toBe(`# Notes\n\n${managedBlockText("CULTURE.md", "new culture")}\n`);
  });

  it("keeps copies a formatter changed as edits, and leaves one of them", () => {
    const formatted = managedBlockText("CULTURE.md", "- culture, reformatted");
    const fs = memory({ [FILE]: `# Notes\n\n${formatted}\n\n${formatted}\n\n${formatted}\n` });
    const records = recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("* culture") });
    const warnings: string[] = [];
    expect(launch(fs, records, "* culture", warnings)).toBe(false);
    expect(fs.files[FILE]).toBe(`# Notes\n\n${formatted}\n`);
    expect(warnings.map((w) => w.split(":")[0])).toEqual(["guidance_block_edited", "guidance_block_copies_removed"]);
  });

  it("keeps a person's edited copy and drops OpenRig's unedited copy beside it", () => {
    const edited = managedBlockText("CULTURE.md", "culture, with my change");
    const fs = memory({ [FILE]: `${managedBlockText("CULTURE.md", "culture")}\n\n${edited}\n` });
    const records = recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("culture") });
    expect(launch(fs, records, "culture", [])).toBe(false);
    expect(fs.files[FILE]).toBe(`${edited}\n`);
  });

  it("keeps two different edited copies: it can't tell which one is meant", () => {
    const text = `${managedBlockText("CULTURE.md", "edit one")}\n\n${managedBlockText("CULTURE.md", "edit two")}\n`;
    const fs = memory({ [FILE]: text });
    expect(launch(fs, recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("culture") }), "culture", [])).toBe(false);
    expect(fs.files[FILE]).toBe(text);
  });

  it("records nothing and adds no copy beside a lost marker", () => {
    const text = "<!-- BEGIN OpenRig MANAGED BLOCK: CULTURE.md -->\nculture\n";
    const fs = memory({ [FILE]: text });
    const records = recordsOf();
    const warnings: string[] = [];
    const written: unknown[] = [];
    for (let i = 0; i < 3; i++) written.push(launch(fs, records, "culture", warnings));
    expect(fs.files[FILE]).toBe(text);
    expect(written).toEqual([false, false, false]);
    expect(records.entries).toEqual({});
    expect(warnings.every((w) => w.startsWith("guidance_block_markers_damaged: "))).toBe(true);
  });

  it("keeps going when the file can't be written: the edited block is kept as decided, and the tidy is named", () => {
    const formatted = managedBlockText("CULTURE.md", "- culture, reformatted");
    const text = `${formatted}\n\n${formatted}\n`;
    const fs = memory({ [FILE]: text });
    fs.writeFile = () => { throw new Error("EACCES: permission denied"); };
    const warnings: string[] = [];
    expect(launch(fs, recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("* culture") }), "* culture", warnings)).toBe(false);
    expect(fs.files[FILE]).toBe(text);
    expect(warnings.map((w) => w.split(":")[0])).toEqual(["guidance_block_edited", "guidance_block_copies_not_removed"]);
  });
});

describe("restore keeps one copy", () => {
  it("removes repeats of a current block, and a second restore changes nothing", () => {
    const current = managedBlockText("CULTURE.md", "* culture");
    const fs = memory({ [FILE]: `# Notes\n\n${current}\n\nmine\n\n${current}\n`, [SOURCE]: "* culture" });
    const records = recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("* culture") });
    const guidance = { targetPath: FILE, items: [{ blockId: "CULTURE.md", sourcePath: SOURCE }] };
    restoreMissingGuidance(guidance, fs, records);
    const once = fs.files[FILE];
    restoreMissingGuidance(guidance, fs, records);
    expect(once).toBe(`# Notes\n\n${current}\n\nmine\n`);
    expect(fs.files[FILE]).toBe(once);
  });

  it("without write records keeps the block's text, and still removes its exact repeats and puts rewrapped markers back", () => {
    const rewrapped = "<!--\n BEGIN OpenRig MANAGED BLOCK: CULTURE.md -->\nmy edit\n<!-- END OpenRig MANAGED BLOCK: CULTURE.md -->";
    const fs = memory({ [FILE]: `${rewrapped}\n\n${managedBlockText("CULTURE.md", "my edit")}\n`, [SOURCE]: "* culture" });
    restoreMissingGuidance({ targetPath: FILE, items: [{ blockId: "CULTURE.md", sourcePath: SOURCE }] }, fs);
    expect(fs.files[FILE]).toBe(`${managedBlockText("CULTURE.md", "my edit")}\n`);
  });

  it("removes a kept block's repeats, and puts back nothing beside a lost marker", () => {
    const formatted = managedBlockText("CULTURE.md", "- culture, reformatted");
    const fs = memory({
      [FILE]: `# Notes\n\n${formatted}\n\n${formatted}\n\n<!-- BEGIN OpenRig MANAGED BLOCK: ROLE.md -->\nrole\n`,
      [SOURCE]: "* culture",
      "/specs/role.md": "role",
    });
    const records = recordsOf({ [`${FILE}#CULTURE.md`]: managedBlockBodyHash("* culture") });
    const repair = restoreMissingGuidance({ targetPath: FILE, items: [
      { blockId: "CULTURE.md", sourcePath: SOURCE },
      { blockId: "ROLE.md", sourcePath: "/specs/role.md" },
    ] }, fs, records);
    expect(fs.files[FILE]).toBe(`# Notes\n\n${formatted}\n\n<!-- BEGIN OpenRig MANAGED BLOCK: ROLE.md -->\nrole\n`);
    expect(count(fs.files[FILE]!)).toBe(1);
    expect(repair.restored).toEqual([]);
    expect(repair.gaps.join("\n")).toContain("ROLE.md: /repo/AGENTS.md holds only part of this block");
    expect(repair.kept.map((k) => k.split(":")[0])).toEqual(["guidance_block_edited", "guidance_block_copies_removed"]);
  });
});
