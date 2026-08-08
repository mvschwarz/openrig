import { describe, expect, it } from "vitest";
import {
  diagnoseRuntimePosture,
  observeClaudePermission,
  observeCodexSandbox,
  observePiResourceTrust,
  parseClaudePermissionModes,
  renderPermissionDriftSummary,
  type PermissionDriftFs,
} from "../src/domain/permission-drift.js";

function fsFixture(files: Record<string, string | Error>, cwdReadable: boolean | null = true): PermissionDriftFs {
  return {
    readFile(path) {
      const value = files[path];
      if (value === undefined) {
        const err = new Error(`missing: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (value instanceof Error) throw value;
      return value;
    },
    cwdReadable: () => cwdReadable,
    commandAvailable: () => true,
    claudePermissionModes: () => ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
  };
}

const cwd = "/tmp/w3-project";
const settingsPath = `${cwd}/.claude/settings.local.json`;

describe("applied launch observations use the exact enforcing value", () => {
  it("preserves Claude permission vocabulary", () => {
    expect(observeClaudePermission("--permission-mode acceptEdits")).toEqual({
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "acceptEdits",
    });
    expect(observeClaudePermission("--dangerously-skip-permissions").value).toBe("bypassPermissions");
  });

  it("preserves Codex sandbox vocabulary and refuses to guess named-profile semantics", () => {
    expect(observeCodexSandbox(" -s workspace-write")).toMatchObject({ axis: "sandbox", state: "observed", value: "workspace-write" });
    expect(observeCodexSandbox(" -s danger-full-access")).toMatchObject({ axis: "sandbox", state: "observed", value: "danger-full-access" });
    expect(observeCodexSandbox(" -p cautious")).toMatchObject({ axis: "sandbox", state: "unknown", value: null, reason: "named_profile_unresolved" });
  });

  it("preserves Pi resource-trust vocabulary and never calls it permission", () => {
    const observation = observePiResourceTrust("approve");
    expect(observation).toEqual({ runtime: "pi", axis: "resource_trust", state: "observed", value: "approve" });
    expect(JSON.stringify(observation)).not.toMatch(/permission/i);
  });
});

describe("strict read-only effective observer", () => {
  it("derives Claude permission vocabulary from the live help shape", () => {
    expect(parseClaudePermissionModes([
      "--permission-mode <mode>  Permission mode to use",
      "  (choices: \"acceptEdits\", \"auto\", \"bypassPermissions\",",
      "  \"manual\", \"dontAsk\", \"plan\")",
    ].join("\n"))).toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
    expect(parseClaudePermissionModes("no permission surface")).toBeNull();
  });

  it("reports a narrowed Claude project policy as drift with the exact file and independent axes", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({
        [settingsPath]: JSON.stringify({ permissions: { defaultMode: "manual", allow: ["Read(.)"], deny: ["Read(/tmp/**)"] } }),
      }),
    });

    expect(diagnostic.transport.state).toBe("healthy");
    expect(diagnostic.cwdRead.state).toBe("visible");
    expect(diagnostic.commandPath.state).toBe("available");
    expect(diagnostic.enforcement).toMatchObject({
      axis: "permission",
      state: "drift",
      expected: "acceptEdits",
      sourcePath: settingsPath,
    });
    expect(diagnostic.enforcement.effective).toEqual({
      defaultMode: "manual",
      allow: ["Read(.)"],
      ask: [],
      deny: ["Read(/tmp/**)"],
    });
  });

  it("reports a matching Claude defaultMode as aligned", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }),
    });
    expect(diagnostic.enforcement).toMatchObject({ axis: "permission", state: "aligned", expected: "acceptEdits" });
  });

  it("reports UNKNOWN-EFFECTIVE when live harness semantics cannot be resolved", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }) }),
        claudePermissionModes: () => null,
      },
    });
    expect(diagnostic.enforcement).toMatchObject({ state: "unknown", reason: "harness_semantics_unknown" });
  });

  it.each([
    ["missing", {}, "settings_missing"],
    ["malformed", { [settingsPath]: "{" }, "settings_unparseable"],
    ["top-level array", { [settingsPath]: "[]" }, "settings_invalid_shape"],
    ["scalar permissions", { [settingsPath]: JSON.stringify({ permissions: "denyAll" }) }, "permissions_invalid_shape"],
    ["unsupported mode", { [settingsPath]: JSON.stringify({ permissions: { defaultMode: "futureMode" } }) }, "unsupported_default_mode"],
    ["conflicting rule", { [settingsPath]: JSON.stringify({ permissions: { defaultMode: "acceptEdits", allow: ["Read(/**)"], deny: ["Read(/**)"] } }) }, "conflicting_rules"],
  ])("keeps %s UNKNOWN-EFFECTIVE", (_name, files, reason) => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: fsFixture(files as Record<string, string>),
    });
    expect(diagnostic.enforcement).toMatchObject({ axis: "permission", state: "unknown", reason, sourcePath: settingsPath });
  });

  it("keeps unreadable cwd/file and missing command separate from permission truth", () => {
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const diagnostic = diagnoseRuntimePosture({
      runtime: "claude-code",
      cwd,
      applied: observeClaudePermission("--permission-mode acceptEdits"),
      fs: {
        ...fsFixture({ [settingsPath]: denied }, false),
        commandAvailable: () => false,
      },
    });
    expect(diagnostic.cwdRead.state).toBe("denied");
    expect(diagnostic.commandPath.state).toBe("missing");
    expect(diagnostic.enforcement).toMatchObject({ state: "unknown", reason: "settings_unreadable" });
  });

  it("does not render Pi resource trust in a permissions column", () => {
    const diagnostic = diagnoseRuntimePosture({
      runtime: "pi",
      cwd,
      applied: observePiResourceTrust("no-approve"),
      fs: fsFixture({}),
    });
    const text = renderPermissionDriftSummary(diagnostic);
    expect(text).toContain("resource trust");
    expect(text).not.toMatch(/permission(?:s)?\s*:/i);
  });
});
