import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProofPreparations } from "../src/routes/proof-preparations.js";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proof-preparation-")));
  fixtures.push(root);
  const missions = path.join(root, "missions");
  fs.mkdirSync(missions);
  return { session: "judge@rig", scope: "mission/slices/01-task", project: "alpha", root, missions };
}

describe("prepared proof capability", () => {
  it("binds the root, missions, project, scope and sender to the original read", () => {
    const value = fixture(), other = fixture(), store = new ProofPreparations();
    const receipt = store.issue(value);
    expect(store.verify(receipt, value)).toEqual({ root: value.root, missions: value.missions });
    expect(store.verify("forged", value)).toBeNull();
    expect(store.verify(receipt, { ...value, root: other.root, missions: other.missions })).toBeNull();
    expect(store.verify(receipt, { ...value, session: "other@rig" })).toBeNull();
    expect(store.verify(receipt, { ...value, scope: "other" })).toBeNull();
    expect(store.verify(receipt, { ...value, project: "beta" })).toBeNull();
    expect(new ProofPreparations().verify(receipt, value)).toBeNull();
  });

  it("rejects a symlink retargeted outside the prepared root", () => {
    const value = fixture(), other = fixture(), store = new ProofPreparations();
    const receipt = store.issue(value);
    fs.renameSync(value.missions, `${value.missions}-old`);
    fs.symlinkSync(other.missions, value.missions, process.platform === "win32" ? "junction" : "dir");
    expect(store.verify(receipt, value)).toBeNull();
  });
});
