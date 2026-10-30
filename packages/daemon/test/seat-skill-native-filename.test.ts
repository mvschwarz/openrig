import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { seatSkillPaths, writeInsideSeatStorage } from "../src/domain/seat-skill-storage.js";

it.runIf(process.platform === "win32")("creates and replaces an owned skill file with a valid 248-character native filename", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-skill-name-"));
  try {
    const paths = seatSkillPaths({ rigId: "owned-rig", logicalId: "owned-seat", runtime: "claude-code" }, home);
    const directory = path.join(paths.skillsRoot, "owned");
    const name = "s".repeat(245) + ".md", file = path.join(directory, name);
    writeInsideSeatStorage(paths.root, file, "owned first version\n");
    expect(fs.readFileSync(file, "utf8")).toBe("owned first version\n");
    writeInsideSeatStorage(paths.root, file, "owned second version\n");
    expect(fs.readFileSync(file, "utf8")).toBe("owned second version\n");
    expect(fs.readdirSync(directory)).toEqual([name]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("keeps a file that appears before first publication and removes only its own staging", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-skill-race-"));
  const originalLink = fs.linkSync;
  const paths = seatSkillPaths({ rigId: "owned-rig", logicalId: "owned-seat", runtime: "claude-code" }, home);
  const directory = path.join(paths.skillsRoot, "owned"), file = path.join(directory, "s".repeat(245) + ".md");
  const link = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
    fs.writeFileSync(target, "owned competing writer\n", { flag: "wx" });
    return originalLink(source, target);
  });
  try {
    expect(() => writeInsideSeatStorage(paths.root, file, "must not replace\n")).toThrow();
    expect(link).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, "utf8")).toBe("owned competing writer\n");
    expect(fs.readdirSync(directory)).toEqual([path.basename(file)]);
  } finally { link.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});
