// OPR.0.4.1.29 — command-level `rig auth` surface: --runtime axis + structured output wiring.
// (Secret-leak coverage lives in codex-auth-leakhunt.test.ts; lib semantics in the other suites.)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authCommand } from "../src/commands/auth.js";

const NOW = () => "2026-06-26T00:00:00Z";
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-cmd-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

// Capture stdout/stderr + the resulting process.exitCode for one invocation, never poisoning the runner.
async function run(subArgs: string[]): Promise<{ out: string; code: number | undefined }> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  let code: number | undefined;
  try {
    const cmd = authCommand({ env: { CODEX_HOME: home, HOME: home }, loginStatus: () => "unavailable", now: NOW });
    await cmd.parseAsync(subArgs, { from: "user" });
    code = process.exitCode as number | undefined;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  return { out: chunks.join("\n"), code };
}

describe("rig auth command surface (OPR.0.4.1.29)", () => {
  it("--runtime non-codex is rejected on every verb (harness = flag, MVP codex only)", async () => {
    for (const v of [["status"], ["list"], ["save", "p"], ["switch", "p"], ["validate", "p"], ["seats", "list"]]) {
      const { out, code } = await run([...v, "--runtime", "claude-code"]);
      expect(out).toContain("unsupported_runtime");
      expect(code).toBe(1);
    }
  });

  it("status reports structured presence fields (no secrets) on an empty CODEX_HOME", async () => {
    const { out } = await run(["status"]);
    expect(out).toContain(`codex_home: ${home}`);
    expect(out).toContain("active_auth_present: no");
    expect(out).toContain("saved_profiles: 0");
    expect(out).toContain("login_status: unavailable");
  });

  it("save without an active auth.json fails with a structured reason + exit 1", async () => {
    const { out, code } = await run(["save", "work"]);
    expect(out).toContain("not_configured");
    expect(code).toBe(1);
  });

  it("a successful restore distinguishes saved credential bytes from verified sign-in", async () => {
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture-key" }), { mode: 0o600 });
    await run(["save", "work"]);
    const { out, code } = await run(["switch", "work"]);
    expect(code).toBeUndefined();
    expect(out).toContain("activated_profile: work");
    expect(out).toContain("Restored saved credential bytes only; sign-in is unverified.");
    expect(out).toContain("may expire, be revoked, or be superseded by refresh elsewhere");
    expect(out).toContain("Restart the affected seat and use the existing account verification; fresh sign-in may be required.");
    expect(out).not.toContain("synthetic-fixture-key");
  });

  it("seats output carries the labels-are-not-proof-of-live-account disclaimer", async () => {
    await run(["seats", "set", "--seat", "a@r", "--rig", "r", "--profile", "work"]);
    const { out } = await run(["seats", "list"]);
    expect(out).toMatch(/not.*(proof|prove)|metadata/i);
    const report = await run(["seats", "report"]);
    expect(report.out).toMatch(/not.*(proof|prove)|metadata/i);
  });

  it("invalid profile name fails closed (whitelist)", async () => {
    const { out, code } = await run(["validate", "../escape"]);
    expect(out).toContain("invalid_profile");
    expect(code).toBe(1);
  });
});
