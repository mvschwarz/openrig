import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import type { CodexFilesystemPermissions } from "../src/domain/codex-member-permissions.js";
import { decideCodexFilesystemPolicy, verifyCodexFilesystemPolicy } from "../src/domain/codex-filesystem-preflight.js";
import { readCodexConfiguration } from "../src/domain/codex-network-default.js";

vi.mock("../src/domain/codex-network-default.js", () => ({ readCodexConfiguration: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());

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
    expect(decide()).toEqual({ ok: true, verified: true });
  });

  it("accepts the native nullable managed-policy response without overriding requirements", () => {
    expect(decide(config(), { requirements: { allowedApprovalPolicies: null, allowedApprovalsReviewers: null,
      allowedSandboxModes: null, allowedPermissionProfiles: null, defaultPermissions: null,
      featureRequirements: null, application: null, autoReview: null, network: null,
      futureFilesystemPolicy: null } })).toEqual({ ok: true, verified: true });
  });

  it("allows other permission profiles in the shared home without selecting them", () => {
    const read = config();
    Object.assign(read.config.permissions, { "other-seat": { filesystem: { ":root": "write" } } });
    expect(decide(read)).toEqual({ ok: true, verified: true });
  });

  it.each([
    ["lower-layer extra write", { filesystem: { ...permissions.filesystem, "/poison": "write" }, network: { enabled: false } }],
    ["changed deny", { filesystem: { ...permissions.filesystem, "/work/hidden": "read" }, network: { enabled: false } }],
    ["missing deny", { filesystem: { ":minimal": "read", "/work": "write" }, network: { enabled: false } }],
    ["network changed", { filesystem: permissions.filesystem, network: { enabled: true } }],
    ["empty filesystem", { filesystem: {}, network: { enabled: false } }],
  ])("refuses %s without disclosing its values", (_label, profile) => {
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": profile });
    expect(decide(read)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it.each([
    ["wrong profile selection", { default_permissions: "other" }],
    ["wrong approval", { approval_policy: "on-request" }],
    ["missing profile map", { permissions: null }],
  ])("refuses %s", (_label, patch) => {
    const read = config();
    Object.assign(read.config, patch);
    expect(decide(read)).toMatchObject({ ok: false });
  });

  it.each([undefined, null, {}, { config: [] }])("reports missing or malformed configuration %#", read => {
    expect(decideCodexFilesystemPolicy({ permissions, configRead: read, requirementsRead: { requirements: null } })).toMatchObject({ ok: true, verified: false });
  });

  it("accepts unrelated managed model settings and an approval allowlist that includes the choice", () => {
    expect(decide(config(), { requirements: { modelProvider: "openai", allowedApprovalPolicies: ["on-request", "never"],
      allowedPermissionProfiles: null, defaultPermissions: null, network: null, featureRequirements: null } })).toEqual({ ok: true, verified: true });
  });

  it.each([
    { allowedApprovalPolicies: ["on-request"] },
    { allowedPermissionProfiles: { "other": true } },
    { allowedPermissionProfiles: { "openrig-seat": false } },
  ])("does not bypass managed policy %#", requirements => {
    expect(decide(config(), { requirements })).toMatchObject({ ok: false });
  });

  it.each([undefined, null, {}, { requirements: [] }, { requirements: null, futurePolicy: true }])("reports unreadable requirements %#", read => {
    expect(decideCodexFilesystemPolicy({ permissions, configRead: config(), requirementsRead: read })).toMatchObject({ ok: true, verified: false });
  });
});

describe("authored ancestor and selector coverage matrix", () => {
  const ancestors = {
    "root read": { "/": "read" },
    "root write": { "/": "write" },
    "root deny": { "/": "deny" },
    "native root deny": { ":root": "deny" },
    "literal read": { ":root": "read", "/work/hidden": "read" },
    "literal write": { ":root": "read", "/work/hidden": "write" },
    "literal deny": { ":root": "read", "/work": "write", "/work/hidden": "deny" },
  } satisfies Record<string, CodexFilesystemPermissions["filesystem"]>;
  type Outcome = "accept" | "not-verified" | "refuse";
  // Expected outcomes are authored from the rule, not computed by another
  // coverage comparator. Columns: read, write, read+aliases, write+aliases.
  // Authored uncertainty warns; lower-layer aliases cannot hide a known
  // widening. A non-root deny wins; a root deny is a refinable default.
  const matrix = [
    ["root read", "none",  "accept", "refuse",       "not-verified", "refuse"],
    ["root read", "read",  "accept", "refuse",       "not-verified", "refuse"],
    ["root read", "write", "accept", "not-verified", "not-verified", "not-verified"],
    ["root write", "none",  "accept", "accept", "not-verified", "not-verified"],
    ["root write", "read",  "accept", "accept", "not-verified", "not-verified"],
    ["root write", "write", "accept", "accept", "not-verified", "not-verified"],
    ["root deny", "none",  "refuse", "refuse", "refuse", "refuse"],
    ["root deny", "read",  "not-verified", "refuse", "not-verified", "refuse"],
    ["root deny", "write", "not-verified", "not-verified", "not-verified", "not-verified"],
    ["native root deny", "none",  "refuse", "refuse", "refuse", "refuse"],
    ["native root deny", "read",  "not-verified", "refuse", "not-verified", "refuse"],
    ["native root deny", "write", "not-verified", "not-verified", "not-verified", "not-verified"],
    ["literal read", "none",  "accept", "refuse",       "not-verified", "refuse"],
    ["literal read", "read",  "accept", "refuse",       "not-verified", "refuse"],
    ["literal read", "write", "accept", "not-verified", "not-verified", "not-verified"],
    ["literal write", "none",  "accept", "accept", "not-verified", "not-verified"],
    ["literal write", "read",  "accept", "accept", "not-verified", "not-verified"],
    ["literal write", "write", "accept", "accept", "not-verified", "not-verified"],
    ["literal deny", "none",  "refuse", "refuse", "refuse", "refuse"],
    ["literal deny", "read",  "refuse", "refuse", "refuse", "refuse"],
    ["literal deny", "write", "refuse", "refuse", "refuse", "refuse"],
  ] satisfies [keyof typeof ancestors, "none" | "read" | "write", Outcome, Outcome, Outcome, Outcome][];
  const cases = matrix.flatMap(([ancestor, selector, read, write, readAliases, writeAliases]) => [
    { ancestor, selector, grant: "read", aliases: false, outcome: read },
    { ancestor, selector, grant: "write", aliases: false, outcome: write },
    { ancestor, selector, grant: "read", aliases: true, outcome: readAliases },
    { ancestor, selector, grant: "write", aliases: true, outcome: writeAliases },
  ]);
  it.each(cases)("$ancestor; selector=$selector; grant=$grant; aliases=$aliases => $outcome", ({ ancestor, selector, grant, aliases, outcome }) => {
    const own: CodexFilesystemPermissions = { ...permissions, filesystem: {
      ...ancestors[ancestor], ...(selector === "none" ? {} : { ":workspace_roots": selector }),
    } };
    const aliasAccess = selector === "none" ? "read" : selector;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: {
      ...own.filesystem, ...(aliases ? { ":workspace_roots": aliasAccess, ":project_roots": aliasAccess } : {}),
      "/work/hidden/secret": grant,
    }, network: { enabled: false } } });
    const result = decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } });
    if (outcome === "refuse") expect(result).toMatchObject({ ok: false, error: expect.stringContaining('"/work/hidden/secret"') });
    else if (outcome === "not-verified") expect(result).toMatchObject({ ok: true, verified: false });
    else expect(result).toEqual({ ok: true, verified: true });
  });
});

describe("root deny refinements", () => {
  it.each(["/", ":root"])('keeps selector overlap unverified beneath %s deny', root => {
    const own: CodexFilesystemPermissions = { ...permissions, filesystem: { [root]: "deny", ":slash_tmp": "write" } };
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, "/tmp/child": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: true, verified: false });
  });

  it.each([
    ["/", "/Users/x/.ssh/key"], [":root", "/Users/x/.ssh/key"],
    ["/", "/home/x/.ssh/key"], [":root", "/home/x/.ssh/key"],
  ])('refuses a user-data read outside minimal defaults beneath %s deny at %s', (root, key) => {
    const own: CodexFilesystemPermissions = { ...permissions, filesystem: { [root]: "deny", ":minimal": "read", "/work": "write" } };
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, [key]: "read" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: false, error: expect.stringContaining(JSON.stringify(key)) });
  });

  it.each(["/", ":root"])('does not claim to expand minimal system reads beneath %s deny', root => {
    const own: CodexFilesystemPermissions = { ...permissions, filesystem: { [root]: "deny", ":minimal": "read" } };
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, "/usr/bin/tool": "read" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: true, verified: false });
  });

  it.each(["/", ":root"])('retains other authored coverage for user data beneath %s deny', root => {
    const key = "/Users/x/.ssh/key";
    for (const [rule, expected] of [[":workspace_roots", "not-verified"], ["/Users/x", "accept"]] as const) {
      const own: CodexFilesystemPermissions = { ...permissions, filesystem: { [root]: "deny", ":minimal": "read", [rule]: "read" } };
      const read = config();
      Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, [key]: "read" }, network: { enabled: false } } });
      const result = decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } });
      if (expected === "accept") expect(result).toEqual({ ok: true, verified: true });
      else expect(result).toMatchObject({ ok: true, verified: false });
    }
  });
});

describe("minimal coverage without an authored root rule", () => {
  it.each(["/Users/x/.ssh/key", "/users/x/.ssh/key", "/HOME/x/.ssh/key"])("refuses an uncovered user-data read at %s", key => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { [key]: "read" });
    const result = decide(read);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(JSON.stringify(key)) });
    if (!result.ok) expect(result.error).toContain("Fix:");
  });

  it("keeps an unexpanded system read unverified and names its key", () => {
    const key = "/opt/x";
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { [key]: "read" });
    expect(decide(read)).toMatchObject({ ok: true, verified: false, reason: expect.stringContaining(JSON.stringify(key)) });
  });
});

describe("Codex seat filesystem verifier reader boundary", () => {
  it.each([["env", "CODEX_HOME=/other"], ["custom-wrapper"]])("reports a launch wrapper without certifying a different configuration %#", async launchWrapper => {
    vi.mocked(readCodexConfiguration).mockClear();
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account", launchWrapper }))
      .toMatchObject({ ok: true, verified: false, reason: expect.stringContaining("launch_wrapper") });
    expect(readCodexConfiguration).not.toHaveBeenCalled();
  });

  it.each(["", "relative/home", "/absolute\nother"])("reports an unestablished account home %# before reading", async codexHome => {
    vi.mocked(readCodexConfiguration).mockClear();
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome })).toMatchObject({ ok: true, verified: false });
    expect(readCodexConfiguration).not.toHaveBeenCalled();
  });

  it("uses the seat home and candidate invocation policy, never sandbox or per-command selection overrides", async () => {
    vi.mocked(readCodexConfiguration).mockResolvedValueOnce({ ok: true, configRead: config(), requirementsRead: { requirements: null } });
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account", launchPath: "/bin" })).toEqual({ ok: true, verified: true });
    expect(readCodexConfiguration).toHaveBeenLastCalledWith({ cwd: "/work", codexHome: "/account", launchPath: "/bin", args: [
      "-c", 'approval_policy="never"', "-c", 'default_permissions="openrig-seat"', "-c",
      'permissions={"openrig-seat"={filesystem={":minimal"="read","/work"="write","/work/hidden"="deny"},network={enabled=false}}}',
      "-c", "features.plugins=false", "-c", "features.apps=false",
    ] });
  });

  it("returns an unavailable read as unverified", async () => {
    vi.mocked(readCodexConfiguration).mockResolvedValueOnce({ ok: false, reason: "native read timed out" });
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account" })).toMatchObject({ ok: true, verified: false });
  });

  it("names the filesystem rule, access on each side and a remedy without dumping configuration", () => {
    const read = config();
    read.config.permissions["openrig-seat"].filesystem["/work/hidden"] = "read";
    Object.assign(read.config, { privateSetting: "do-not-print-this-value" });
    expect(decide(read)).toMatchObject({ ok: false, error: expect.stringMatching(/\/work\/hidden.*agent.*deny.*(?:Codex|layer).*read/i) });
    const decision = decide(read);
    if (decision.ok) throw new Error("fixture must conflict");
    expect(decision.error).toContain("\nFix:");
    expect(decision.error).not.toContain("do-not-print-this-value");
    read.config.default_permissions = "private-profile-selection";
    const selection = decide(read);
    if (selection.ok) throw new Error("fixture must conflict");
    expect(selection.error).toContain("default_permissions");
    expect(selection.error).toContain("\nFix:");
    expect(selection.error).not.toContain("private-profile-selection");
  });

  it("returns a thrown reader failure without exposing arbitrary error contents", async () => {
    vi.mocked(readCodexConfiguration).mockRejectedValueOnce(new Error("do not print this"));
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account" })).toEqual({
      ok: true, verified: false, reason: "Native Codex configuration reader failed",
    });
  });

  it("resolves the normal account home without an explicit CODEX_HOME", async () => {
    vi.stubEnv("CODEX_HOME", undefined);
    vi.mocked(readCodexConfiguration).mockResolvedValueOnce({ ok: true, configRead: config(), requirementsRead: { requirements: null } });
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work" })).toEqual({ ok: true, verified: true });
    expect(readCodexConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({ codexHome: `${os.homedir()}/.codex` }));
  });

  it("keeps a named profile unverified instead of certifying the base configuration", async () => {
    vi.mocked(readCodexConfiguration).mockClear();
    expect(await verifyCodexFilesystemPolicy({ permissions, cwd: "/work", codexHome: "/account", codexConfigProfile: "model-only" }))
      .toMatchObject({ ok: true, verified: false, reason: expect.stringContaining("codex_config_profile") });
    expect(readCodexConfiguration).not.toHaveBeenCalled();
  });
});

describe("compatible policies and inconclusive reads", () => {
  it.each([":root", ":minimal"])(
    "refuses a known extra write grant at %s, including beside an unfamiliar representation", key => {
      const read = config();
      Object.assign(read.config.permissions["openrig-seat"].filesystem, { [key]: "write", future: { access: "future" } });
      expect(decide(read)).toMatchObject({ ok: false });
    });

  it("refuses full-root read beyond minimal read", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { ":root": "read" });
    expect(decide(read)).toMatchObject({ ok: false });
  });

  it.each([":workspace_roots", ":project_roots", ":tmpdir", ":slash_tmp", "~/x"])(
    "leaves extra %s coverage unverified when an authored path may already cover it", key => {
      const read = config();
      Object.assign(read.config.permissions["openrig-seat"].filesystem, { [key]: "write" });
      expect(decide(read)).toMatchObject({ ok: true, verified: false });
    });

  it("does not refuse a potentially redundant slash_tmp grant beside an authored /tmp grant", () => {
    const own = { ...permissions, filesystem: { ":root": "read", "/tmp": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, ":slash_tmp": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: true, verified: false });
  });

  it("still refuses a selector write when no authored rule could cover write access", () => {
    const own = { ...permissions, filesystem: { ":root": "read" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, ":slash_tmp": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: false });
  });

  it("does not invent a selector conflict by collapsing ambiguous coverage aliases", () => {
    const own = { ...permissions, filesystem: { ":root": "read", ":project_roots": "write", ":workspace_roots": "deny" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, ":tmpdir": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: true, verified: false, reason: expect.stringContaining("effective configuration grants") });
  });

  it.each([
    { ":workspace_roots": "read", ":project_roots": "read" },
    { ":project_roots": "read", ":workspace_roots": "read" },
  ])("refuses an outside write despite lower-layer duplicate aliases %#", aliases => {
    const own = { ...permissions, filesystem: { ":root": "read", "/work": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, ...aliases, "/outside": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('"/outside"') });
  });

  it("leaves only the lower-layer duplicate aliases unverified when there is no separate conflict", () => {
    const own = { ...permissions, filesystem: { ":root": "read", "/work": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem,
      ":workspace_roots": "read", ":project_roots": "read" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: true, verified: false });
  });

  it("leaves an extra absolute rule unverified when a native selector may cover it", () => {
    const own = { ...permissions, filesystem: { ":root": "read", ":tmpdir": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, "/tmp/child": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: true, verified: false });
    const literal = { ...permissions, filesystem: { ":root": "read", "/work": "write" } } satisfies CodexFilesystemPermissions;
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...literal.filesystem, "/outside": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: literal, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: false });
  });

  it("checks authored selectors before refusing a write beneath a read-only literal ancestor", () => {
    const own = { ...permissions, filesystem: { "/": "read", ":slash_tmp": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, "/tmp/child": "write" }, network: { enabled: false } } });
    const result = decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } });
    expect(result).toMatchObject({ ok: true, verified: false, reason: expect.stringContaining('"/tmp/child"') });
    expect(result).toMatchObject({ reason: expect.stringContaining("write") });
  });

  it("still refuses a direct literal-root widening beside an authored selector", () => {
    const own = { ...permissions, filesystem: { "/": "read", ":slash_tmp": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, "/": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('"/"') });
  });

  it("refuses a read beneath the fixture's authored deny despite minimal read coverage", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { "/work/hidden/secret": "read" });
    expect(decide(read)).toMatchObject({ ok: false, error: expect.stringContaining('"/work/hidden/secret"') });
  });

  it("refuses a write beneath an authored deny despite an authored write selector", () => {
    const own = { ...permissions, filesystem: { ...permissions.filesystem, ":workspace_roots": "write" } } satisfies CodexFilesystemPermissions;
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ...own.filesystem, "/work/hidden/secret": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: own, configRead: read, requirementsRead: { requirements: null } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('"/work/hidden/secret"') });
  });

  it("names the extra selector and access in an inconclusive coverage warning", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { ":slash_tmp": "write" });
    const result = decide(read);
    expect(result).toMatchObject({ ok: true, verified: false, reason: expect.stringContaining('":slash_tmp"') });
    expect(result).toMatchObject({ reason: expect.stringContaining("write") });
  });

  it.each(["never", "on-request"] satisfies CodexFilesystemPermissions["approval"][])(
    "reports an unfamiliar approval string as unverified for authored %s", approval => {
      const read = config();
      read.config.approval_policy = "future-native-approval";
      expect(decideCodexFilesystemPolicy({ permissions: { ...permissions, approval }, configRead: read, requirementsRead: { requirements: null } }))
        .toMatchObject({ ok: true, verified: false, reason: expect.stringContaining("approval") });
    });

  it("still refuses a recognized untrusted approval instead of treating it as a future spelling", () => {
    const read = config();
    read.config.approval_policy = "untrusted";
    expect(decide(read)).toMatchObject({ ok: false, error: expect.stringContaining("approval_policy") });
  });

  it("does not let an unfamiliar approval hide a known filesystem or network conflict", () => {
    const read = config();
    read.config.approval_policy = "future-native-approval";
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { "/outside": "write" });
    expect(decide(read)).toMatchObject({ ok: false, error: expect.stringContaining('"/outside"') });
    Object.assign(read.config.permissions["openrig-seat"], { filesystem: permissions.filesystem, network: { enabled: true } });
    expect(decide(read)).toMatchObject({ ok: false, error: expect.stringContaining("network.enabled") });
  });

  it.each([
    { allowedApprovalPolicies: ["on-request"] },
    { allowedPermissionProfiles: { "openrig-seat": false } },
  ])("reports an excluding managed allowlist ahead of effective selection or approval mismatches %#", requirements => {
    const read = config();
    Object.assign(read.config, { default_permissions: "other", approval_policy: "on-request" });
    expect(decide(read, { requirements })).toMatchObject({ ok: false, error: expect.stringContaining("managed allowlist") });
    read.config.default_permissions = "openrig-seat";
    expect(decide(read, { requirements })).toMatchObject({ ok: false, error: expect.stringContaining("managed allowlist") });
  });

  it.each(["default_permissions", "approval_policy"])("reports absent or null %s without inventing a conflict", key => {
    for (const value of [undefined, null]) {
      const read = config();
      Object.assign(read.config, { [key]: value });
      expect(decide(read)).toMatchObject({ ok: true, verified: false });
    }
  });

  it("reports a new profile representation without a filesystem field but keeps independent conflicts", () => {
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { futureFilesystem: { access: "new-format" }, network: { enabled: false } } });
    expect(decide(read)).toMatchObject({ ok: true, verified: false });
    read.config.permissions["openrig-seat"].network.enabled = true;
    expect(decide(read)).toMatchObject({ ok: false });
  });

  it("accepts an allowed effective selection even when the managed fallback selects another profile", () => {
    expect(decide(config(), { requirements: { defaultPermissions: "private-fallback-value",
      allowedPermissionProfiles: { "openrig-seat": true } } })).toEqual({ ok: true, verified: true });
  });

  it("accepts a known selector grant already covered by an authored full-root grant", () => {
    const read = config();
    Object.assign(read.config.permissions["openrig-seat"].filesystem, { ":root": "write", ":workspace_roots": "write", "~/x": "read" });
    expect(decideCodexFilesystemPolicy({ permissions: { ...permissions, filesystem: { ...permissions.filesystem, ":root": "write" } },
      configRead: read, requirementsRead: { requirements: null } })).toEqual({ ok: true, verified: true });
  });

  it.each(["default_permissions", "approval_policy"])("reports a future %s representation without inventing a conflict", key => {
    const read = config();
    Object.assign(read.config, { [key]: { selection: "future-native-format" } });
    expect(decide(read)).toMatchObject({ ok: true, verified: false });
  });

  it("refuses an explicitly excluded profile even beside unknown allowlist entries", () => {
    expect(decide(config(), { requirements: { allowedPermissionProfiles: { "openrig-seat": false, future: { allowed: true } } } }))
      .toMatchObject({ ok: false });
  });

  it.each([
    { filesystem: permissions.filesystem, network: { enabled: false }, extends: ":workspace" },
    { filesystem: permissions.filesystem, network: { enabled: false }, workspace_roots: { "/extra": true } },
    { filesystem: permissions.filesystem, network: { enabled: false }, futurePolicy: true },
    { filesystem: permissions.filesystem, network: { enabled: false, allow_local_binding: true } },
    { filesystem: { ":workspace_roots": { ".": "write" } }, network: { enabled: false } },
    { filesystem: { "/work": "allow" }, network: { enabled: false } },
  ])("reports unfamiliar selected policy options %#", profile => {
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": profile });
    expect(decide(read)).toMatchObject({ ok: true, verified: false });
  });

  it.each([
    { allowedApprovalPolicies: "never" }, { featureRequirements: { use_linux_sandbox_bwrap: false } },
    { network: {} }, { futureFilesystemPolicy: true },
  ])("reports unsupported requirements without refusing %#", requirements => {
    expect(decide(config(), { requirements })).toMatchObject({ ok: true, verified: false });
  });

  it("keeps positive configuration and managed conflicts visible alongside unknowns", () => {
    const read = config();
    read.config.default_permissions = "other";
    expect(decide(read, { requirements: { futureManagedPolicy: true } })).toMatchObject({ ok: false });
    expect(decide(config(), { requirements: { futureManagedPolicy: true, allowedApprovalPolicies: ["on-request"] } }))
      .toMatchObject({ ok: false });
    expect(decideCodexFilesystemPolicy({ permissions, configRead: null, requirementsRead: { requirements: { allowedPermissionProfiles: { "openrig-seat": false } } } }))
      .toMatchObject({ ok: false });
  });

  it("accepts inert legacy settings, a model-only profile and harmless descriptions", () => {
    const read = config();
    Object.assign(read.config, { sandbox_mode: "read-only", sandbox_workspace_write: { network_access: true }, profile: "model-only" });
    Object.assign(read.config.permissions["openrig-seat"], { description: "description only" });
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

  it("compares the project_roots alias without silently collapsing conflicting spellings", () => {
    const withAlias: CodexFilesystemPermissions = { approval: "never", filesystem: { ":project_roots": "write" } };
    const read = config();
    Object.assign(read.config.permissions, { "openrig-seat": { filesystem: { ":workspace_roots": "write" }, network: { enabled: false } } });
    expect(decideCodexFilesystemPolicy({ permissions: withAlias, configRead: read, requirementsRead: { requirements: null } }))
      .toEqual({ ok: true, verified: true });
    expect(decideCodexFilesystemPolicy({ permissions: { ...withAlias, filesystem: { ":workspace_roots": "deny", ":project_roots": "write" } },
      configRead: read, requirementsRead: { requirements: null } })).toMatchObject({ ok: true, verified: false });
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
