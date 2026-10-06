// OPR.0.3.4.7 — Codex profile-v2 preflight probe tests.
// Exec-injected: no real Codex needed.

import { describe, it, expect, vi } from "vitest";
import { verifyCodexProfileLoads } from "../src/domain/codex-profile-preflight.js";
import { verifyCodexProfiles } from "../src/domain/rigspec-preflight.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

describe("verifyCodexProfileLoads", () => {
  it.each([true, false])("releases the deadline after the command settles (success=%s)", async (success) => {
    vi.useFakeTimers();
    try {
      const result = await verifyCodexProfileLoads("owned", async () => {
        if (!success) throw new Error("invalid profile");
        return "";
      });
      expect(result.ok).toBe(success);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PASS: valid profile loads successfully", async () => {
    const exec = vi.fn(async () => "");
    const result = await verifyCodexProfileLoads("openrig_pm", exec);
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("openrig_pm");
    expect(exec).toHaveBeenCalledWith("codex -p openrig_pm mcp list");
  });

  it("PASS: missing profile file (Codex treats absent .config.toml as valid default-config layering)", async () => {
    // Advisor ruling Option B: Codex 0.139+ exits 0 for an absent profile file
    // (default-config layering). Failing preflight on this would be a false
    // negative — preflight rejecting a config that launch ACCEPTS.
    const exec = vi.fn(async () => "");
    const result = await verifyCodexProfileLoads("missing", exec);
    expect(result.ok).toBe(true);
    expect(result.profile).toBe("missing");
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

  it("FAIL: invalid TOML stderr is NOT misclassified as legacy migration (surfaces parse reason)", async () => {
    const exec = vi.fn(async () => {
      const err = new Error("Command failed") as Error & { stderr: string };
      err.stderr = "Error: failed to load configuration\nexpected newline, found a period at line 3 column 12\n  in /Users/x/.codex/qa_invalid.config.toml";
      throw err;
    });
    const result = await verifyCodexProfileLoads("qa_invalid", exec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("expected newline");
    expect(result.migrationHint).not.toContain("[profiles.qa_invalid]");
    expect(result.migrationHint).toContain("valid TOML");
  });

  it("honest failure: unknown error carries generic hint", async () => {
    const exec = vi.fn(async () => { throw new Error("permission denied"); });
    const result = await verifyCodexProfileLoads("test", exec);
    expect(result.ok).toBe(false);
    expect(result.migrationHint).toContain("manually to diagnose");
  });

  it("FAIL: probe is bounded by timeout (never hangs indefinitely)", async () => {
    const exec = vi.fn(() => new Promise<string>(() => {}));
    const result = await verifyCodexProfileLoads("stuck", exec, 50);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
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
