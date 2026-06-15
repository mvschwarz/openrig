// OPR.0.3.4.7 — Codex profile-v2 preflight probe tests.
// Exec-injected: no real Codex needed.

import { describe, it, expect, vi } from "vitest";
import { verifyCodexProfileLoads } from "../src/domain/codex-profile-preflight.js";
import { verifyCodexProfiles } from "../src/domain/rigspec-preflight.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

describe("verifyCodexProfileLoads", () => {
  it("PASS: valid profile loads successfully", async () => {
    const exec = vi.fn(async () => "");
    const result = await verifyCodexProfileLoads("openrig_pm", exec);
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("openrig_pm");
    expect(exec).toHaveBeenCalledWith("codex -p openrig_pm mcp list");
  });

  it("FAIL: missing profile file", async () => {
    const exec = vi.fn(async () => { throw new Error("Error: config file not found: /Users/x/.codex/missing.config.toml"); });
    const result = await verifyCodexProfileLoads("missing", exec);
    expect(result.ok).toBe(false);
    expect(result.profile).toBe("missing");
    expect(result.error).toContain("missing");
    expect(result.error).toContain("failed to load");
    expect(result.migrationHint).toContain("missing.config.toml");
  });

  it("FAIL: legacy [profiles.<name>] table blocks loading (the headline discriminator)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("Error: failed to load configuration: --profile openrig_pm cannot be used while config.toml contains legacy [profiles.openrig_pm] config; move those settings into ~/.codex/openrig_pm.config.toml and remove the legacy selector/table.");
    });
    const result = await verifyCodexProfileLoads("openrig_pm", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to load");
    expect(result.migrationHint).toContain("Move the profile settings");
    expect(result.migrationHint).toContain("openrig_pm.config.toml");
    expect(result.migrationHint).toContain("[profiles.openrig_pm]");
  });

  it("FAIL: captures stderr from execSync-style errors (err.stderr)", async () => {
    const exec = vi.fn(async () => {
      const err = new Error("Command failed") as Error & { stderr: string };
      err.stderr = "Error: failed to load configuration: --profile test cannot be used while config.toml contains legacy [profiles.test] config";
      throw err;
    });
    const result = await verifyCodexProfileLoads("test", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to load");
    expect(result.migrationHint).toContain("Move the profile settings");
  });

  it("honest failure: unknown error carries generic hint", async () => {
    const exec = vi.fn(async () => { throw new Error("permission denied"); });
    const result = await verifyCodexProfileLoads("test", exec);
    expect(result.ok).toBe(false);
    expect(result.migrationHint).toContain("manually to diagnose");
  });

  it("profile name with special characters is shell-quoted", async () => {
    const exec = vi.fn(async () => "");
    await verifyCodexProfileLoads("my profile", exec);
    expect(exec).toHaveBeenCalledWith("codex -p 'my profile' mcp list");
  });
});

describe("verifyCodexProfiles (rigspec integration)", () => {
  function makeSpec(members: Array<{ id: string; runtime: string; codexConfigProfile?: string }>): PodRigSpec {
    return {
      name: "test-rig",
      version: "0.2",
      pods: [{
        id: "dev",
        label: "Dev",
        members: members.map((m) => ({
          id: m.id,
          runtime: m.runtime,
          agentRef: "local:agents/test",
          cwd: ".",
          codexConfigProfile: m.codexConfigProfile,
        })),
        edges: [],
      }],
      edges: [],
    } as unknown as PodRigSpec;
  }

  it("skips non-codex members", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "claude-code" }]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("skips codex members without a profile", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "codex" }]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("probes codex member with a profile", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "codex", codexConfigProfile: "openrig_pm" }]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).toHaveBeenCalledWith("codex -p openrig_pm mcp list");
  });

  it("dedupes same profile across multiple members", async () => {
    const exec = vi.fn(async () => "");
    const errors = await verifyCodexProfiles(
      makeSpec([
        { id: "qa", runtime: "codex", codexConfigProfile: "shared" },
        { id: "ops", runtime: "codex", codexConfigProfile: "shared" },
      ]),
      exec,
    );
    expect(errors).toHaveLength(0);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns error for a failing profile", async () => {
    const exec = vi.fn(async () => { throw new Error("failed to load configuration"); });
    const errors = await verifyCodexProfiles(
      makeSpec([{ id: "impl", runtime: "codex", codexConfigProfile: "broken" }]),
      exec,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("dev.impl");
    expect(errors[0]).toContain("broken");
  });
});
