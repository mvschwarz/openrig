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

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a custom startup file named %s is returned unchanged (no inherited-key match)", (name) => {
    const custom = { path: name, absolutePath: `/home/u/rig/${name}`, ownerRoot: "/home/u/rig", ...meta };
    expect(reanchorBuiltinStartupFile(custom, RUNNING)).toBe(custom);
    const underAssets = { path: name, absolutePath: `${OLD}/${name}`, ownerRoot: OLD, ...meta };
    expect(reanchorBuiltinStartupFile(underAssets, RUNNING)).toBe(underAssets);
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

describe("reanchorBuiltinStartupFile — shipped-spec startup files", () => {
  const RUN_SPECS = "/new/lib/node_modules/@openrig/cli/daemon/specs";
  const OLD_SPECS = "/mise/installs/npm-openrig-cli/0.6.2/node_modules/@openrig/cli/daemon/specs";
  const KERNEL = "rigs/launch/kernel";

  it("re-anchors the kernel rig culture (pre-launch guidance_merge), preserving metadata", () => {
    const stored = { path: "culture/CULTURE.md", absolutePath: `${OLD_SPECS}/${KERNEL}/culture/CULTURE.md`, ownerRoot: `${OLD_SPECS}/${KERNEL}`, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS)).toEqual({
      ...stored, absolutePath: `${RUN_SPECS}/${KERNEL}/culture/CULTURE.md`, ownerRoot: `${RUN_SPECS}/${KERNEL}`,
    });
  });

  it("re-anchors agent role and startup context (post-launch send_text)", () => {
    const agent = `${OLD_SPECS}/${KERNEL}/agents/advisor/lead`;
    for (const rel of ["guidance/role.md", "startup/context.md"]) {
      const stored = { path: rel, absolutePath: `${agent}/${rel}`, ownerRoot: agent, deliveryHint: "send_text" as const, required: true, appliesOn: ["fresh_start" as const, "restore" as const] };
      expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS)).toMatchObject({
        absolutePath: `${RUN_SPECS}/${KERNEL}/agents/advisor/lead/${rel}`, ownerRoot: `${RUN_SPECS}/${KERNEL}/agents/advisor/lead`, deliveryHint: "send_text",
      });
    }
  });

  it("leaves a file outside the shipped specs root unchanged even when its ownerRoot is shipped", () => {
    const stored = { path: "notes.md", absolutePath: "/home/u/notes.md", ownerRoot: `${OLD_SPECS}/${KERNEL}`, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS)).toBe(stored);
  });

  it("leaves user rig culture and look-alike daemon/specs folders unchanged", () => {
    const user = { path: "culture/CULTURE.md", absolutePath: "/home/u/rigs/acme/culture/CULTURE.md", ownerRoot: "/home/u/rigs/acme", ...meta };
    const lookalike = { path: "culture/CULTURE.md", absolutePath: "/home/u/daemon/specs/r/culture/CULTURE.md", ownerRoot: "/home/u/daemon/specs/r", ...meta };
    expect(reanchorBuiltinStartupFile(user, RUNNING, RUN_SPECS)).toBe(user);
    expect(reanchorBuiltinStartupFile(lookalike, RUNNING, RUN_SPECS)).toBe(lookalike);
  });
});

describe("dev-checkout layouts re-anchor only when the stored file is missing", () => {
  const RUN_SPECS = "/new/lib/node_modules/@openrig/cli/daemon/specs";
  const DEV = "/src/openrig/packages/daemon";
  const present = () => true;
  const missing = () => false;

  it("built-in from a present dev checkout stays as stored; a missing one re-anchors", () => {
    const stored = { path: "openrig-start.md", absolutePath: `${DEV}/assets/guidance/openrig-start.md`, ownerRoot: `${DEV}/assets`, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS, present)).toBe(stored);
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS, missing).absolutePath).toBe(`${RUNNING}/guidance/openrig-start.md`);
  });

  it("shipped-spec startup file from a present dev checkout stays as stored; a missing one re-anchors", () => {
    const stored = { path: "culture/CULTURE.md", absolutePath: `${DEV}/specs/rigs/launch/kernel/culture/CULTURE.md`, ownerRoot: `${DEV}/specs/rigs/launch/kernel`, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS, present)).toBe(stored);
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS, missing).absolutePath).toBe(`${RUN_SPECS}/rigs/launch/kernel/culture/CULTURE.md`);
  });

  it("projection resource from a present dev checkout stays as stored; a missing one re-anchors", () => {
    const entry = { sourcePath: `${DEV}/specs/agents/shared`, absolutePath: `${DEV}/specs/agents/shared/runtime/claude-mcp.fragment.json`, effectiveId: "shared:claude-default-mcp" };
    expect(reanchorShippedProjectionEntry(entry, RUN_SPECS, present)).toBe(entry);
    expect(reanchorShippedProjectionEntry(entry, RUN_SPECS, missing).absolutePath).toBe(`${RUN_SPECS}/agents/shared/runtime/claude-mcp.fragment.json`);
  });

  it("packaged installs re-anchor even while the stored file is present", () => {
    const stored = { path: "CULTURE-default.md", absolutePath: `${OLD}/guidance/CULTURE-default.md`, ownerRoot: OLD, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS, present).absolutePath).toBe(`${RUNNING}/guidance/CULTURE-default.md`);
  });

  it("an unrecognized daemon/assets layout is not treated as an OpenRig install", () => {
    const other = "/opt/something/daemon/assets";
    const stored = { path: "CULTURE-default.md", absolutePath: `${other}/guidance/CULTURE-default.md`, ownerRoot: other, ...meta };
    expect(reanchorBuiltinStartupFile(stored, RUNNING, RUN_SPECS, missing)).toBe(stored);
  });
});

describe("legacy persisted shapes are returned exactly as stored", () => {
  it("startup file without ownerRoot (or path) does not throw and is unchanged", () => {
    const noOwner = { path: "required-onboarding.md", absolutePath: "/tmp/never-read/required-onboarding.md", required: true } as unknown as { path: string; absolutePath: string; ownerRoot: string };
    expect(reanchorBuiltinStartupFile(noOwner, RUNNING)).toBe(noOwner);
    const noPath = { absolutePath: `${OLD}/guidance/CULTURE-default.md`, ownerRoot: OLD } as unknown as { path: string; absolutePath: string; ownerRoot: string };
    expect(() => reanchorBuiltinStartupFile(noPath, RUNNING)).not.toThrow();
  });

  it("projection entry without sourcePath does not throw and is unchanged", () => {
    const legacy = { absolutePath: "/tmp/never-read/CLAUDE.md", category: "memory" } as unknown as { sourcePath: string; absolutePath: string };
    expect(reanchorShippedProjectionEntry(legacy)).toBe(legacy);
  });
});
