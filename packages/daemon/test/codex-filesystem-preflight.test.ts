import { describe, expect, it, vi } from "vitest";
import type { CodexFilesystemPermissions } from "../src/domain/codex-member-permissions.js";
import { decideCodexFilesystemPolicy, verifyCodexFilesystemPolicy } from "../src/domain/codex-filesystem-preflight.js";
import { readCodexConfiguration } from "../src/domain/codex-network-default.js";

vi.mock("../src/domain/codex-network-default.js", () => ({ readCodexConfiguration: vi.fn() }));

const permissions: CodexFilesystemPermissions = {
  approval: "never", filesystem: { ":minimal": "read", "/work": "write", "/work/hidden": "deny" }, network_access: false,
};
function config() {
  return { config: { approval_policy: "never", default_permissions: "openrig-seat", sandbox_mode: null,
    sandbox_workspace_write: null, profile: null, permissions: { "openrig-seat": {
      description: null, extends: null, workspace_roots: null,
      filesystem: { "/work/hidden": "deny", "/work": "write", ":minimal": "read", glob_scan_max_depth: null },
      network: { enabled: false, allow_local_binding: null, allow_upstream_proxy: null,
        dangerously_allow_all_unix_sockets: null, dangerously_allow_non_loopback_proxy: null, domains: null,
        enable_socks5: null, enable_socks5_udp: null, mitm: null, mode: null, proxy_url: null, socks_url: null, unix_sockets: null },
    } } }, origins: {}, layers: [] };
}
function decide(configRead: unknown = config(), requirementsRead: unknown = { requirements: null }) {
  return decideCodexFilesystemPolicy({ permissions, configRead, requirementsRead });
}

describe("Codex seat filesystem configuration preflight", () => {
  it("accepts the exact authored policy regardless of mapping key order", () => {
    expect(decide()).toEqual({ ok: true });
  });

  it("accepts the native nullable managed-policy response without overriding requirements", () => {
    expect(decide(config(), { requirements: { allowedApprovalPolicies: null, allowedApprovalsReviewers: null,
      allowedSandboxModes: null, allowedPermissionProfiles: null, defaultPermissions: null,
      featureRequirements: null, application: null, autoReview: null, network: null,
      futureFilesystemPolicy: null } })).toEqual({ ok: true });
  });

  it("allows other permission profiles in the shared home without selecting them", () => {
    const read = config();
    Object.assign(read.config.permissions, { "other-seat": { filesystem: { ":root": "write" } } });
    expect(decide(read)).toEqual({ ok: true });
  });

  it.each([
    ["lower-layer extra write", { filesystem: { ...permissions.filesystem, "/poison": "write" }, network: { enabled: false } }],
    ["changed deny", { filesystem: { ...permissions.filesystem, "/work/hidden": "read" }, network: { enabled: false } }],
    ["missing deny", { filesystem: { ":minimal": "read", "/work": "write" }, network: { enabled: false } }],
    ["inherited parent", { filesystem: permissions.filesystem, network: { enabled: false }, extends: ":workspace" }],
    ["extra roots", { filesystem: permissions.filesystem, network: { enabled: false }, workspace_roots: { "/extra": true } }],
    ["unknown selected profile field", { filesystem: permissions.filesystem, network: { enabled: false }, futurePolicy: true }],
    ["unknown null selected profile field", { filesystem: permissions.filesystem, network: { enabled: false }, futurePolicy: null }],
    ["unknown network grant", { filesystem: permissions.filesystem, network: { enabled: false, allow_local_binding: true } }],
    ["network changed", { filesystem: permissions.filesystem, network: { enabled: true } }],
    ["empty filesystem", { filesystem: {}, network: { enabled: false } }],
    ["nested filesystem rule", { filesystem: { ":workspace_roots": { ".": "write" } }, network: { enabled: false } }],
    ["unknown access", { filesystem: { "/work": "allow" }, network: { enabled: false } }],
  ])("refuses %s without disclosing its values", (_label, profile) => {
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": profile });
    expect(decide(read)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it.each([
    ["legacy read-only", { sandbox_mode: "read-only" }],
    ["legacy workspace settings", { sandbox_workspace_write: {} }],
    ["wrong profile selection", { default_permissions: "other" }],
    ["wrong approval", { approval_policy: "on-request" }],
    ["missing approval", { approval_policy: undefined }],
    ["named configuration profile", { profile: "work" }],
    ["missing profile map", { permissions: null }],
  ])("refuses %s", (_label, patch) => {
    const read = config();
    Object.assign(read.config, patch);
    expect(decide(read)).toMatchObject({ ok: false });
  });

  it.each([undefined, null, {}, { config: [] }, { config: { permissions: [] } }])("refuses missing or malformed configuration %#", read => {
    expect(decideCodexFilesystemPolicy({ permissions, configRead: read, requirementsRead: { requirements: null } })).toMatchObject({ ok: false });
  });

  it("accepts unrelated managed model settings and an approval allowlist that includes the choice", () => {
    expect(decide(config(), { requirements: { modelProvider: "openai", allowedApprovalPolicies: ["on-request", "never"],
      allowedPermissionProfiles: null, defaultPermissions: null, network: null, featureRequirements: null } })).toEqual({ ok: true });
  });

  it.each([
    { allowedApprovalPolicies: ["on-request"] },
    { allowedApprovalPolicies: "never" },
    { allowedPermissionProfiles: { "openrig-seat": true } },
    { defaultPermissions: "openrig-seat" },
    { allowedSandboxModes: ["read-only", "workspace-write"] },
    { featureRequirements: { use_linux_sandbox_bwrap: false } },
    { network: {} },
    { futureFilesystemPolicy: true },
  ])("does not bypass managed policy %#", requirements => {
    expect(decide(config(), { requirements })).toMatchObject({ ok: false });
  });

  it.each([undefined, null, {}, { requirements: [] }, { requirements: null, futurePolicy: true }])("refuses unreadable requirements %#", read => {
    expect(decideCodexFilesystemPolicy({ permissions, configRead: config(), requirementsRead: read })).toMatchObject({ ok: false });
  });
});

describe("Codex seat filesystem verifier reader boundary", () => {
  it.each([["env", "CODEX_HOME=/other"], ["custom-wrapper"]])("refuses a launch wrapper before reading %#", async launchWrapper => {
    vi.mocked(readCodexConfiguration).mockClear();
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account", launchWrapper }))
      .toMatchObject({ ok: false, error: expect.stringContaining("launch_wrapper") });
    expect(readCodexConfiguration).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "relative/home", "/absolute\nother"])("refuses an unestablished account home %# before reading", async codexHome => {
    vi.mocked(readCodexConfiguration).mockClear();
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome })).toMatchObject({ ok: false });
    expect(readCodexConfiguration).not.toHaveBeenCalled();
  });

  it("uses the seat home and candidate invocation policy, never sandbox or per-command selection overrides", async () => {
    vi.mocked(readCodexConfiguration).mockResolvedValueOnce({ ok: true, configRead: config(), requirementsRead: { requirements: null } });
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account", launchPath: "/bin" })).toEqual({ ok: true });
    expect(readCodexConfiguration).toHaveBeenLastCalledWith({ cwd: "/work", codexHome: "/account", launchPath: "/bin", args: [
      "-c", 'approval_policy="never"', "-c", 'default_permissions="openrig-seat"', "-c",
      'permissions={"openrig-seat"={filesystem={":minimal"="read","/work"="write","/work/hidden"="deny"},network={enabled=false}}}',
    ] });
  });

  it("returns an unavailable read as a refusal", async () => {
    vi.mocked(readCodexConfiguration).mockResolvedValueOnce({ ok: false, reason: "native read timed out" });
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account" })).toMatchObject({ ok: false });
  });

  it("returns a thrown reader failure without exposing arbitrary error contents", async () => {
    vi.mocked(readCodexConfiguration).mockRejectedValueOnce(new Error("do not print this"));
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account" })).toEqual({
      ok: false, error: "Native Codex configuration reader failed; seat filesystem policy was not verified",
    });
  });
});

describe("compatible policies and inconclusive reads", () => {
  it("accepts inert legacy settings, a model-only profile and harmless descriptions", () => {
    const read = config();
    Object.assign(read.config, { sandbox_mode: "read-only", sandbox_workspace_write: { network_access: true }, profile: "model-only" });
    read.config.permissions["openrig-seat"].description = "description only";
    expect(decide(read)).toEqual({ ok: true, verified: true });
  });

  it("treats every null profile field as absent, including future fields", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"], { futureProfile: null });
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { futureFilesystem: null });
    Object.assign(read.config.permissions["openrig-seat"].network, { futureNetwork: null });
    expect(decide(read)).toEqual({ ok: true, verified: true });
  });

  it("accepts a narrower filesystem policy and redundant subpath grants", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { "/work": "read", "/work/child": "read" });
    expect(decide(read)).toEqual({ ok: true, verified: true });
  });

  it("accepts matching managed selection and allowlists", () => {
    expect(decide(config(), { requirements: { defaultPermissions: "openrig-seat",
      allowedPermissionProfiles: { "openrig-seat": true }, allowedApprovalPolicies: ["on-request", "never"],
      allowedSandboxModes: ["read-only"] } })).toEqual({ ok: true, verified: true });
  });

  it.each([
    { configRead: null, requirementsRead: { requirements: null } },
    { configRead: config(), requirementsRead: { requirements: [] } },
    { configRead: config(), requirementsRead: { requirements: { futureManagedPolicy: true } } },
  ])("reports an unreadable shape or unknown requirement without refusing %#", request => {
    expect(decideCodexFilesystemPolicy({ permissions, ...request })).toMatchObject({ ok: true, verified: false, reason: expect.any(String) });
  });

  it.each(["future-access", { read: ["/nested"] }])("reports unfamiliar filesystem representation without refusing %j", access => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { "/work/hidden": access });
    expect(decide(read)).toMatchObject({ ok: true, verified: false });
  });

  it("still refuses a concrete extra write grant alongside an unfamiliar representation", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { "/poison": "write", "/future": { read: ["/nested"] } });
    expect(decide(read)).toMatchObject({ ok: false });
  });

  it("reports a reader timeout without dropping or replacing the invocation policy", async () => {
    vi.mocked(readCodexConfiguration).mockResolvedValueOnce({ ok: false, reason: "native read timed out" });
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account" }))
      .toMatchObject({ ok: true, verified: false, reason: expect.stringContaining("timed out") });
  });
});
