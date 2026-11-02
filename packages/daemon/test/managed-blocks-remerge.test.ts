// #2372: every launch re-merges OpenRig's managed blocks into a CLAUDE.md or AGENTS.md that seats share. A re-merge must
// leave the file the same size, and every byte a person wrote outside the blocks where it was.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { managedBlockText, mergeManagedBlock } from "../src/domain/managed-blocks.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A guidance file in a fresh temporary folder, never a live instruction file. */
function scratchGuidance(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-remerge-"));
  dirs.push(dir);
  const file = path.join(dir, "AGENTS.md");
  fs.writeFileSync(file, text);
  return file;
}
const writer = { exists: (p: string) => fs.existsSync(p), readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  writeFile: (p: string, c: string) => fs.writeFileSync(p, c) };

it("keeps a guidance file the same size from the second launch on, however many launches re-merge its blocks", () => {
  const file = scratchGuidance("# Notes\nkeep these\n");
  const sizes: number[] = [];
  for (let launch = 0; launch < 5; launch++) {
    mergeManagedBlock(writer, file, "CULTURE.md", "culture text");
    mergeManagedBlock(writer, file, "openrig-seat-skills.md", "skills text");
    sizes.push(fs.statSync(file).size);
  }
  expect(sizes.slice(1)).toEqual(Array(4).fill(sizes[1]));
});

it("re-merges blocks in place and keeps every byte a person wrote before, between and after them", () => {
  const before = "# Notes\nkeep these\n\n";
  const between = "\n\nperson text between the blocks\n\n";
  // Blank lines a person left after the last block stay too.
  const after = "\n\nperson notes at the end\n\n\n";
  const file = scratchGuidance(`${before}${managedBlockText("CULTURE.md", "old culture")}${between}${managedBlockText("openrig-seat-skills.md", "skills text")}${after}`);
  for (let launch = 0; launch < 3; launch++) {
    mergeManagedBlock(writer, file, "CULTURE.md", "new culture");
    mergeManagedBlock(writer, file, "openrig-seat-skills.md", "skills text");
  }
  expect(fs.readFileSync(file, "utf-8")).toBe(
    `${before}${managedBlockText("CULTURE.md", "new culture")}${between}${managedBlockText("openrig-seat-skills.md", "skills text")}${after}`);
});
