import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectBundleBehaviour } from "../src/domain/bundle-behaviour-inspect.js";

const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("private archive text reader", () => {
  it("does not follow outside links and makes unscanned members explicit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-view-reader-"));
    owned.push(root);
    const archive = path.join(root, "archive");
    fs.mkdirSync(archive);
    fs.writeFileSync(path.join(archive, "rig.yaml"), "name: demo\nversion: '1'\npods:\n- id: team\n  members:\n  - {id: shell, agent_ref: 'builtin:terminal', profile: none, runtime: terminal, cwd: .}\n");
    fs.writeFileSync(path.join(root, "outside.txt"), "https://outside-link.invalid/private");
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(archive, "linked.txt"));
    fs.writeFileSync(path.join(archive, "binary.bin"), Buffer.from([0, 65, 66]));
    fs.writeFileSync(path.join(archive, "large.txt"), "x".repeat(1024 * 1024 + 1));
    const view = inspectBundleBehaviour(archive, { manifest: { schema_version: 2, rig_spec: "rig.yaml" }, generator: { openrigVersion: "0.6.6" }, digestValid: true, filesVerified: true });
    expect(view.state).toBe("generated");
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.outsideAddresses).toEqual([]);
    expect(view.unknownBeforeLaunch.find(item => item.subject === "unread text")?.sourceRefs).toEqual([
      { path: "binary.bin" }, { path: "large.txt" }, { path: "linked.txt" },
    ]);
    expect(fs.readFileSync(path.join(root, "outside.txt"), "utf8")).toBe("https://outside-link.invalid/private");
  });

  it("keeps an unreadable rig diagnostic rather than manufacturing an empty team", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-view-missing-"));
    owned.push(root);
    const view = inspectBundleBehaviour(root, { manifest: { schema_version: 2, rig_spec: "absent.yaml" }, generator: { openrigVersion: "0.6.6" }, digestValid: false, filesVerified: false });
    expect(view).toMatchObject({ state: "not_generated", reason: expect.stringContaining("not readable") });
    expect(view).not.toHaveProperty("team");
  });
});
