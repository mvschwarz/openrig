// #261: recognized built-in startup files re-anchor to the running install; nothing else moves.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { reanchorBuiltinStartupFile, runningBuiltinAssetsRoot } from "../src/domain/builtin-startup-files.js";

const RUNNING = "/new/lib/node_modules/@openrig/cli/daemon/assets";
const OLD = "/mise/installs/npm-openrig-cli/0.6.2/node_modules/@openrig/cli/daemon/assets";
const meta = { deliveryHint: "guidance_merge" as const, required: true, appliesOn: ["fresh_start" as const, "restore" as const] };

describe("reanchorBuiltinStartupFile", () => {
  it.each([
    ["CULTURE-default.md", "guidance/CULTURE-default.md"],
    ["openrig-start.md", "guidance/openrig-start.md"],
    ["openrig-onboarding-01.md", "onboarding/01-world-and-purpose.md"],
    ["openrig-onboarding-02.md", "onboarding/02-self-and-competent-action.md"],
  ])("re-anchors %s from an old packaged install, preserving metadata", (name, rel) => {
    const stored = { path: name, absolutePath: `${OLD}/${rel}`, ownerRoot: OLD, ...meta, kind: "file" as const };
    expect(reanchorBuiltinStartupFile(stored, RUNNING)).toEqual({ ...stored, absolutePath: `${RUNNING}/${rel}`, ownerRoot: RUNNING });
  });

  it("re-anchors a built-in stored from a dev checkout (packages/daemon/assets)", () => {
    const dev = "/src/openrig/packages/daemon/assets";
    const stored = { path: "openrig-start.md", absolutePath: `${dev}/guidance/openrig-start.md`, ownerRoot: dev, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING).absolutePath).toBe(`${RUNNING}/guidance/openrig-start.md`);
  });

  it("leaves a custom rig file with the same basename unchanged", () => {
    const custom = { path: "CULTURE-default.md", absolutePath: "/home/u/rig/CULTURE-default.md", ownerRoot: "/home/u/rig", ...meta };
    expect(reanchorBuiltinStartupFile(custom, RUNNING)).toBe(custom);
  });

  it("leaves a built-in name whose stored path is not the known relative path unchanged", () => {
    const odd = { path: "CULTURE-default.md", absolutePath: `${OLD}/custom/CULTURE-default.md`, ownerRoot: OLD, ...meta };
    expect(reanchorBuiltinStartupFile(odd, RUNNING)).toBe(odd);
  });

  it("leaves a known relative path under a non daemon/assets root unchanged", () => {
    const root = "/home/u/my-assets";
    const user = { path: "CULTURE-default.md", absolutePath: `${root}/guidance/CULTURE-default.md`, ownerRoot: root, ...meta };
    expect(reanchorBuiltinStartupFile(user, RUNNING)).toBe(user);
  });

  it("leaves non-built-in names unchanged even under daemon/assets", () => {
    const other = { path: "guidance/CULTURE-default.md", absolutePath: `${OLD}/guidance/CULTURE-default.md`, ownerRoot: OLD, ...meta };
    expect(reanchorBuiltinStartupFile(other, RUNNING)).toBe(other);
  });

  it("defaults to this daemon's assets root, which holds all four built-ins", () => {
    expect(runningBuiltinAssetsRoot()).toBe(path.resolve(import.meta.dirname, "../assets"));
  });
});
