// A walk to the nearest existing ancestor must end at the root. Without the root check, a path whose root is missing
// (an absent drive or share) loops forever on the event loop: dirname of a root is the root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nearestExistingAncestor } from "../src/domain/proof/judgments.js";

describe("nearestExistingAncestor", () => {
  it("returns null, instead of looping, when not even the root exists", () => {
    const seen: string[] = [];
    const missing = path.join(path.parse(process.cwd()).root, "no", "such", "place");
    expect(nearestExistingAncestor(missing, (p) => { seen.push(p); return false; })).toBeNull();
    expect(seen.at(-1)).toBe(path.parse(missing).root);
    expect(seen).toHaveLength(4);
  });

  it("returns the path itself when it exists, else its nearest existing ancestor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nearest-ancestor-"));
    try {
      expect(nearestExistingAncestor(dir)).toBe(dir);
      expect(nearestExistingAncestor(path.join(dir, "a", "b", "c.md"))).toBe(dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
