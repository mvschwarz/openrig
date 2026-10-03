import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import {
  decideCodexNetworkDefault, codexNetworkDefaultArg,
  type CodexNetworkDefault, type CodexNetworkDefaultReader,
} from "../src/domain/codex-network-default.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #275 — network inside OpenRig's workspace-write floor by default, unless Codex itself reports an
// opt-out or a policy. Fixtures follow the app-server 0.160.0 answers recorded by the architecture
// review (config/read with includeLayers, configRequirements/read). No real Codex runs here.

const SESSION_FLAG = { name: { type: "sessionFlags" }, version: "sha256:session" };
const USER_FILE = { name: { type: "user", file: "/home/u/.codex/config.toml", profile: null }, version: "sha256:user" };

function configRead(over: { config?: Record<string, unknown>; origins?: Record<string, unknown> } = {}) {
  return {
    config: { sandbox_mode: "workspace-write", sandbox_workspace_write: null, default_permissions: null, profile: null, approval_policy: null, ...over.config },
    origins: { sandbox_mode: SESSION_FLAG, ...over.origins },
    layers: [SESSION_FLAG, USER_FILE],
  };
}
const NO_REQUIREMENTS = { requirements: null };
const DEFAULT_FALSE = { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false };

describe("#275 decideCodexNetworkDefault", () => {
  it("applies on the origin-free floor with no requirements", () => {
    expect(decideCodexNetworkDefault(configRead(), NO_REQUIREMENTS)).toEqual({ apply: true });
  });

  it("applies when only another sandbox_workspace_write field is set and network_access is Codex's default", () => {
    const read = configRead({
      config: { sandbox_workspace_write: { ...DEFAULT_FALSE, writable_roots: ["/data"] } },
      origins: { "sandbox_workspace_write.writable_roots": USER_FILE },
    });
    expect(decideCodexNetworkDefault(read, NO_REQUIREMENTS)).toEqual({ apply: true });
  });

  it("applies when an untrusted project's layer is disabled: Codex reports no origin and no value", () => {
    const read = configRead();
    read.layers.push({ name: { type: "project", dotCodexFolder: "/repo/.codex" }, version: "sha256:p", disabledReason: "/repo is marked as untrusted" } as never);
    expect(decideCodexNetworkDefault(read, NO_REQUIREMENTS)).toEqual({ apply: true });
  });

  it.each([
    ["user false", false, USER_FILE],
    ["user true", true, USER_FILE],
    ["trusted project false", false, { name: { type: "project", dotCodexFolder: "/repo/.codex" }, version: "sha256:p" }],
    ["cloud-managed false", false, { name: { type: "enterpriseManaged" }, version: "sha256:c" }],
    ["managed file false", false, { name: { type: "legacyManagedConfigTomlFromFile", file: "/etc/codex/managed_config.toml" }, version: "sha256:m" }],
  ])("preserves an explicit choice at any layer: %s", (_label, value, origin) => {
    const read = configRead({
      config: { sandbox_workspace_write: { ...DEFAULT_FALSE, network_access: value } },
      origins: { "sandbox_workspace_write.network_access": origin },
    });
    expect(decideCodexNetworkDefault(read, NO_REQUIREMENTS)).toMatchObject({ apply: false });
  });

  it("does not take a missing origin as proof: an effective true with no origin is left alone", () => {
    const read = configRead({ config: { sandbox_workspace_write: { ...DEFAULT_FALSE, network_access: true } } });
    expect(decideCodexNetworkDefault(read, NO_REQUIREMENTS)).toEqual({ apply: false, reason: "network access is already on" });
  });

  it.each([
    ["a higher layer replaced the sandbox", { config: { sandbox_mode: "read-only" }, origins: { sandbox_mode: { name: { type: "legacyManagedConfigTomlFromMdm" } } } }],
    ["the sandbox came from a file, not the launch flag", { origins: { sandbox_mode: USER_FILE } }],
    ["a configuration profile is selected", { config: { profile: "work" } }],
    ["a permission profile is selected", { config: { default_permissions: "locked" } }],
    ["the whole sandbox_workspace_write table has an origin", { origins: { sandbox_workspace_write: USER_FILE } }],
  ])("adds nothing when %s", (_label, over) => {
    expect(decideCodexNetworkDefault(configRead(over), NO_REQUIREMENTS)).toMatchObject({ apply: false });
  });

  it.each([
    ["network requirements", { network: { allowed: false } }],
    ["sandbox modes without workspace-write", { allowedSandboxModes: ["read-only"] }],
    ["permission profiles", { allowedPermissionProfiles: { locked: true } }],
    ["a default permission profile", { defaultPermissions: "locked" }],
    ["feature requirements", { featureRequirements: { anything: false } }],
    ["a requirement this version does not know", { somethingNew: true }],
  ])("adds nothing under managed %s", (_label, requirements) => {
    expect(decideCodexNetworkDefault(configRead(), { requirements })).toMatchObject({ apply: false });
  });

  it("applies under requirements that cannot restrict network inside workspace-write", () => {
    const requirements = {
      modelProvider: "openai", allowedApprovalPolicies: ["on-request"], allowedSandboxModes: ["read-only", "workspace-write"],
      network: null, defaultPermissions: null, allowedPermissionProfiles: null,
    };
    expect(decideCodexNetworkDefault(configRead(), { requirements })).toEqual({ apply: true });
  });

  it.each([
    ["no config/read result", undefined, NO_REQUIREMENTS],
    ["config/read without origins", { config: configRead().config }, NO_REQUIREMENTS],
    ["a non-object sandbox_workspace_write", configRead({ config: { sandbox_workspace_write: "on" } }), NO_REQUIREMENTS],
    ["a non-boolean network_access", configRead({ config: { sandbox_workspace_write: { network_access: "yes" } } }), NO_REQUIREMENTS],
    ["no requirements field", configRead(), {}],
    ["requirements of the wrong type", configRead(), { requirements: [] }],
  ])("adds nothing for an unrecognized shape: %s", (_label, config, requirements) => {
    expect(decideCodexNetworkDefault(config, requirements)).toMatchObject({ apply: false });
  });
});

describe("#275 codexNetworkDefaultArg", () => {
  const applied: CodexNetworkDefault = { apply: true, elapsedMs: 12 };
  const OVERRIDE = " -c 'sandbox_workspace_write.network_access=true'";

  it("reads only the plain floor and returns the quoted override when Codex allows it", async () => {
    const read = vi.fn<CodexNetworkDefaultReader>(async () => applied);
    expect(await codexNetworkDefaultArg(read, observeCodexSandbox(" -s workspace-write"), "/seat", "dev-qa@rig")).toBe(OVERRIDE);
    expect(read).toHaveBeenCalledWith("/seat");
    for (const posture of [" -s danger-full-access", " -s danger-full-access -a never", " -p 'work'"]) {
      expect(await codexNetworkDefaultArg(read, observeCodexSandbox(posture), "/seat", "dev-qa@rig")).toBe("");
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns nothing without a reader, when Codex declines, or when the reader throws", async () => {
    const floor = observeCodexSandbox(" -s workspace-write");
    expect(await codexNetworkDefaultArg(undefined, floor, "/seat", "s")).toBe("");
    expect(await codexNetworkDefaultArg(async () => ({ apply: false, reason: "network access is set explicitly", elapsedMs: 3 }), floor, "/seat", "s")).toBe("");
    expect(await codexNetworkDefaultArg(async () => { throw new Error("boom"); }, floor, "/seat", "s")).toBe("");
  });
});

// Launch sites. Every process seam is fake: tmux, profile preflight, git dirs and the reader.
function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter);
}
const mockFs = (): CodexAdapterFsOps => ({
  readFile: () => { throw new Error("not found"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [],
});
const sentCommands = (tmux: TmuxAdapter) => (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]));

describe("#275 every Codex launch site adds the override only when the reader applies it", () => {
  const cwd = "/seat dir";
  const kinds = ["fresh", "fork", "resume", "restore", "last"] as const;

  function fixture(kind: typeof kinds[number], read: CodexNetworkDefaultReader | undefined,
    posture: "floor" | "full_bypass" = "floor", profile?: string) {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
      verifyProfilePreflight: async (name) => ({ ok: true, profile: name }), resolveGitAddDirs: async () => [],
      ...(read ? { readNetworkDefault: read } : {}),
    });
    const restore = new CodexResumeAdapter(tmux, {
      sleep: async () => {}, maxWaitMs: 0, exec: async () => "", ...(read ? { readNetworkDefault: read } : {}),
    });
    const binding: NodeBinding = {
      id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
      updatedAt: "", cwd, model: "gpt-5.5", launchPosture: posture, codexConfigProfile: profile,
    };
    const run = () => kind === "restore" || kind === "last"
      ? restore.resume("r01-qa", kind === "last" ? "codex_last" : "codex_id", "thread id", cwd, profile, posture, "gpt-5.5")
      : adapter.launchHarness(binding, {
          name: "dev-qa@test-rig",
          ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent id" } }
            : kind === "resume" ? { resumeToken: "thread id" } : {}),
        });
    return { run, commands: () => sentCommands(tmux) };
  }

  for (const kind of kinds) {
    it(`${kind}: the override follows the floor flag when applied; a declined read leaves the command unchanged`, async () => {
      const baseline = fixture(kind, undefined);
      await baseline.run();
      const appliedRead = vi.fn<CodexNetworkDefaultReader>(async () => ({ apply: true, elapsedMs: 5 }));
      const applied = fixture(kind, appliedRead);
      await applied.run();
      const declined = fixture(kind, async () => ({ apply: false, reason: "network access is set explicitly in Codex configuration", elapsedMs: 5 }));
      await declined.run();

      expect(baseline.commands()).toHaveLength(1);
      expect(baseline.commands()[0]).toContain(" -s workspace-write");
      expect(applied.commands()).toEqual([
        baseline.commands()[0]!.replace(" -s workspace-write", " -s workspace-write -c 'sandbox_workspace_write.network_access=true'"),
      ]);
      expect(appliedRead).toHaveBeenCalledTimes(1);
      expect(appliedRead).toHaveBeenCalledWith(cwd);
      expect(declined.commands()).toEqual(baseline.commands());
    });

    it(`${kind}: a named profile and full bypass are never read and stay byte-identical`, async () => {
      for (const [posture, profile] of [["floor", "work profile"], ["full_bypass", undefined]] as const) {
        const read = vi.fn<CodexNetworkDefaultReader>(async () => ({ apply: true, elapsedMs: 5 }));
        const baseline = fixture(kind, undefined, posture, profile);
        await baseline.run();
        const withReader = fixture(kind, read, posture, profile);
        await withReader.run();
        expect(read).not.toHaveBeenCalled();
        expect(withReader.commands()).toEqual(baseline.commands());
        expect(withReader.commands()[0]).not.toContain("network_access");
      }
    });
  }
});

describe("#275 production wiring", () => {
  it("startup wires one network reader into both Codex launch adapters", () => {
    const source = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    const lines = source.split("\n");
    expect(lines.find((line) => line.includes("new CodexResumeAdapter("))).toContain("readNetworkDefault: readCodexNetworkDefault");
    expect(lines.find((line) => line.includes("new CodexRuntimeAdapter("))).toContain("readNetworkDefault: readCodexNetworkDefault");
    expect(lines.find((line) => line.includes("const readCodexNetworkDefault ="))).toContain("codexNetworkDefaultReader({ launchPath: process.env.PATH, home: daemonHome, codexHome })");
  });
});
