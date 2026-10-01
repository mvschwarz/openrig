// #261: recognized built-in startup files re-anchor to the running install; nothing else moves.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry, runningBuiltinAssetsRoot, runningShippedSpecsRoot } from "../src/domain/builtin-startup-files.js";

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

describe("reanchorShippedProjectionEntry", () => {
  const RUN_SPECS = "/new/lib/node_modules/@openrig/cli/daemon/specs";
  const OLD_SPECS = "/mise/installs/npm-openrig-cli/0.6.2/node_modules/@openrig/cli/daemon/specs";
  const base = { category: "runtime_resource", effectiveId: "shared:claude-default-settings", sourceSpec: "shared",
    resourcePath: "runtime/claude-settings.fragment.json", resourceType: "claude_settings_fragment", mergeStrategy: "managed_block", target: ".claude/settings.local.json" };

  it("re-anchors a shipped resource (source and resource under an old install's daemon/specs), preserving every other field", () => {
    const stored = { ...base, sourcePath: `${OLD_SPECS}/agents/shared`, absolutePath: `${OLD_SPECS}/agents/shared/runtime/claude-settings.fragment.json` };
    expect(reanchorShippedProjectionEntry(stored, RUN_SPECS)).toEqual({
      ...base, sourcePath: `${RUN_SPECS}/agents/shared`, absolutePath: `${RUN_SPECS}/agents/shared/runtime/claude-settings.fragment.json`,
    });
  });

  it("re-anchors kernel agent guidance stored under the rig's own shipped spec directory", () => {
    const dir = `${OLD_SPECS}/rigs/launch/kernel/agents/advisor/lead`;
    const stored = { ...base, category: "guidance", effectiveId: "role", sourceSpec: "advisor.lead", sourcePath: dir, absolutePath: `${dir}/guidance/role.md` };
    expect(reanchorShippedProjectionEntry(stored, RUN_SPECS).absolutePath).toBe(`${RUN_SPECS}/rigs/launch/kernel/agents/advisor/lead/guidance/role.md`);
  });

  it("re-anchors from a dev checkout (packages/daemon/specs)", () => {
    const dev = "/src/openrig/packages/daemon/specs";
    const stored = { ...base, sourcePath: `${dev}/agents/shared`, absolutePath: `${dev}/agents/shared/runtime/claude-mcp.fragment.json` };
    expect(reanchorShippedProjectionEntry(stored, RUN_SPECS).absolutePath).toBe(`${RUN_SPECS}/agents/shared/runtime/claude-mcp.fragment.json`);
  });

  it("leaves a plugin projected from ~/.openrig/plugins unchanged even though its sourcePath is a shipped spec", () => {
    const plugin = { ...base, category: "plugin", effectiveId: "shared:openrig-core", sourcePath: `${OLD_SPECS}/agents/shared`, absolutePath: "/home/u/.openrig/plugins/openrig-core" };
    expect(reanchorShippedProjectionEntry(plugin, RUN_SPECS)).toBe(plugin);
  });

  it("leaves user spec resources unchanged", () => {
    const user = { ...base, sourcePath: "/home/u/rigs/acme/agents/dev", absolutePath: "/home/u/rigs/acme/agents/dev/guidance/role.md" };
    expect(reanchorShippedProjectionEntry(user, RUN_SPECS)).toBe(user);
  });

  it("does not treat a user folder merely named daemon/specs as an OpenRig install", () => {
    const lookalike = { ...base, sourcePath: "/home/u/daemon/specs/agents/x", absolutePath: "/home/u/daemon/specs/agents/x/role.md" };
    expect(reanchorShippedProjectionEntry(lookalike, RUN_SPECS)).toBe(lookalike);
  });

  it("defaults to this daemon's shipped specs root", () => {
    expect(runningShippedSpecsRoot()).toBe(path.resolve(import.meta.dirname, "../specs"));
  });
});
