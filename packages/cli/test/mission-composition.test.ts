import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMissionCompositionEdits,
  planMissionMembershipAdd,
} from "../src/lib/scope/mission-composition.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-composition-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function mission(name: string): string {
  const dir = path.join(root, name);
  for (const slice of ["01-first", "02-second"]) {
    const at = path.join(dir, "slices", slice);
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, "slice.yaml"), "kind: slice\n");
  }
  fs.writeFileSync(path.join(dir, "mission.yaml"), "kind: mission\ncomposition:\n  slices: []\n");
  return dir;
}

const read = (dir: string) => fs.readFileSync(path.join(dir, "mission.yaml"), "utf8");

describe("mission composition planning snapshots", () => {
  it("refuses a stale plan without dropping another writer's member; a fresh retry preserves both", () => {
    const dir = mission("single");
    const stale = planMissionMembershipAdd(dir, "slices/01-first/slice.yaml", 10)!;
    const concurrent = planMissionMembershipAdd(dir, "slices/02-second/slice.yaml", 20)!;
    applyMissionCompositionEdits([concurrent]);
    const newer = read(dir);

    expect(() => applyMissionCompositionEdits([stale])).toThrow("changed since this edit was planned");
    expect(read(dir)).toBe(newer);
    expect(fs.readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);

    applyMissionCompositionEdits([planMissionMembershipAdd(dir, "slices/01-first/slice.yaml", 10)!]);
    expect(read(dir)).toContain("slices/01-first/slice.yaml");
    expect(read(dir)).toContain("slices/02-second/slice.yaml");
  });

  it("checks all originals before publishing any member of a multi-mission batch", () => {
    const first = mission("first");
    const second = mission("second");
    const edits = [first, second].map((dir) => planMissionMembershipAdd(dir, "slices/01-first/slice.yaml", 10)!);
    applyMissionCompositionEdits([planMissionMembershipAdd(second, "slices/02-second/slice.yaml", 20)!]);
    const firstBefore = read(first);
    const secondBefore = read(second);

    expect(() => applyMissionCompositionEdits(edits)).toThrow("changed since this edit was planned");
    expect(read(first)).toBe(firstBefore);
    expect(read(second)).toBe(secondBefore);
    for (const dir of [first, second]) expect(fs.readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
