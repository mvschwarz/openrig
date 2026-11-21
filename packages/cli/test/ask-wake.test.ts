import { describe, it, expect, vi } from "vitest";
import { defaultWakeRunner, runWake, type WakeRunner } from "../src/ask-wake.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runWake — L3 headless one-shot wake", () => {
  it.each([["claude", false], ["claude", true], ["codex", false], ["codex", true]] as const)(
    "the actual %s child keeps legacy hooks but no bound run authority (bound=%s)", async (runtime, bound) => {
      const dir = mkdtempSync(join(tmpdir(), "wake-child-authority-"));
      const secret = bound ? "scoped-fixture-secret" : "legacy-hook";
      const script = `#!${process.execPath}
console.log(JSON.stringify({runPresent:process.env.OPENRIG_RUN_ID!==undefined,tokenPresent:process.env.OPENRIG_ACTIVITY_HOOK_TOKEN!==undefined,
  legacyToken:process.env.OPENRIG_ACTIVITY_HOOK_TOKEN==="legacy-hook",node:process.env.OPENRIG_NODE_ID,seat:process.env.OPENRIG_SESSION_NAME,
  url:process.env.OPENRIG_URL,generation:process.env.OPENRIG_OCCUPANT_GENERATION,provider:process.env.ANTHROPIC_API_KEY,args:process.argv.slice(2)}));
`;
      try {
        writeFileSync(join(dir, runtime), script, { mode: 0o755 });
        vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
        vi.stubEnv("OPENRIG_RUN_ID", bound ? "actual-run" : undefined);
        vi.stubEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", secret);
        vi.stubEnv("OPENRIG_NODE_ID", "wake-node"); vi.stubEnv("OPENRIG_SESSION_NAME", "wake@rig");
        vi.stubEnv("OPENRIG_URL", "http://fixture.test"); vi.stubEnv("OPENRIG_OCCUPANT_GENERATION", "generation");
        vi.stubEnv("ANTHROPIC_API_KEY", "fixture-provider");
        const outcome = await runWake({ runner: defaultWakeRunner }, { runtime, token: "history-token", question: "literal question", timeoutMs: 5000 });
        expect(outcome.failed).toBeUndefined();
        expect(JSON.parse(outcome.answer!)).toEqual({ runPresent: false, tokenPresent: !bound, legacyToken: !bound,
          node: "wake-node", seat: "wake@rig", url: "http://fixture.test", generation: "generation", provider: "fixture-provider",
          args: runtime === "claude" ? ["-p", "--resume", "history-token", "Answer directly and concisely, with no preamble. Question: literal question"]
            : ["exec", "resume", "history-token", "Answer directly and concisely, with no preamble. Question: literal question"] });
        expect(JSON.stringify(outcome)).not.toContain("scoped-fixture-secret");
        expect(JSON.stringify(outcome)).not.toContain("actual-run");
        expect(process.env.OPENRIG_ACTIVITY_HOOK_TOKEN).toBe(secret);
        expect(process.env.OPENRIG_RUN_ID).toBe(bound ? "actual-run" : undefined);
      } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
    });
  it("wakes a claude session by raw token, one-shot, and returns the captured answer", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "the deploy decision was X", stderr: "", code: 0, timedOut: false }));
    const out = await runWake(
      { runner },
      { question: "what was the deploy decision?", token: "3f2a-abc", runtime: "claude" },
    );

    expect(out.ran).toBe(true);
    expect(out.answer).toBe("the deploy decision was X");
    expect(out.timedOut).toBeFalsy();

    // command is claude, headless one-shot resume of the token, question present
    const call = (runner as unknown as { mock: { calls: [string, string[], unknown][] } }).mock.calls[0]!;
    expect(call[0]).toBe("claude");
    expect(call[1]).toContain("-p");
    expect(call[1]).toContain("--resume");
    expect(call[1]).toContain("3f2a-abc");
    expect(call[1].some((a) => a.includes("what was the deploy decision?"))).toBe(true);
  });

  it("builds the codex headless resume command for runtime=codex", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "answer", stderr: "", code: 0, timedOut: false }));
    await runWake({ runner }, { question: "q?", token: "tok", runtime: "codex" });
    const call = (runner as unknown as { mock: { calls: [string, string[], unknown][] } }).mock.calls[0]!;
    expect(call[0]).toBe("codex");
    expect(call[1]).toContain("resume");
    expect(call[1]).toContain("tok");
  });

  it("reports a timeout honestly — never a silent hang", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "", code: null, timedOut: true }));
    const out = await runWake({ runner }, { question: "q?", token: "tok", runtime: "claude", timeoutMs: 1000 });

    expect(out.ran).toBe(true);
    expect(out.timedOut).toBe(true);
    expect(out.answer).toBeUndefined();
    expect(out.message).toMatch(/time|background|did not/i);
  });

  it("passes the caller's bounded timeout through to the runner", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "a", stderr: "", code: 0, timedOut: false }));
    await runWake({ runner }, { question: "q?", token: "tok", runtime: "claude", timeoutMs: 42000 });
    const call = (runner as unknown as { mock: { calls: [string, string[], { timeoutMs: number }][] } }).mock.calls[0]!;
    expect(call[2].timeoutMs).toBe(42000);
  });

  it("surfaces a large-file advisory when the session file is big (never a silent slow wake)", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "a", stderr: "", code: 0, timedOut: false }));
    const fileLocator = vi.fn(() => ({ path: "/h/.claude/projects/-p/tok.jsonl", sizeBytes: 700 * 1024 * 1024 }));
    const out = await runWake({ runner, fileLocator }, { question: "q?", token: "tok", runtime: "claude" });
    expect(out.advisory).toBeDefined();
    expect(out.advisory).toMatch(/large|MB|minute/i);
  });

  it("reports a NON-ZERO exit as a FAILURE, not a silent empty answer (honest-degraded parity)", async () => {
    // bad token / missing binary / auth fail: code=1, empty stdout. Must NOT read
    // as a successful empty answer.
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "resume: invalid session token", code: 1, timedOut: false }));
    const out = await runWake({ runner }, { question: "q?", token: "bad", runtime: "claude" });
    expect(out.failed).toBe(true);
    expect(out.code).toBe(1);
    expect(out.answer).toBeUndefined();
    expect(out.message).toMatch(/fail|exit 1|invalid session token/i);
  });
});
