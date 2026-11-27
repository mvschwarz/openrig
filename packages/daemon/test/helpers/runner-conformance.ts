import { execFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { shellQuote } from "../../src/adapters/shell-quote.js";

// The runner conformance check that ships in docs/reference, run against a test double that keeps the contract, and
// against copies of it that each break one promise: the check must pass the first and catch every break. The cases are
// split across the runner-conformance-*.test.ts files so Vitest can schedule them on separate workers; each check run
// has its own tmux server, port and temporary folders.
export const CHECK = resolve(__dirname, "../../../../docs/reference/runner-conformance/check-runner.mjs");
const RUNNER = resolve(__dirname, "../fixtures/runner-conformance/minimal-acp-runner.mjs");
export const LATE_TIMERS = resolve(__dirname, "../fixtures/runner-conformance/late-check-timers.cjs");
export const SCALED_CLOCK = resolve(__dirname, "../fixtures/runner-conformance/scaled-clock.cjs");
export const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

type Check = { name: string; ok: boolean; detail?: string };
type Result = { id: string; status: "pass" | "fail" | "skip" | "advisory"; met?: boolean; checks: Check[]; reason?: string };
type Report = { results: Result[]; summary: { pass: number; fail: number; skip: number; advisory: number } };

export async function check(args: string[], runnerFlags = "", nodeArgs: string[] = [], timeoutMs = 90_000, env?: NodeJS.ProcessEnv): Promise<{ code: number; report: Report }> {
  const runner = `${shellQuote(process.execPath)} ${shellQuote(RUNNER)} --agent {agent}${runnerFlags}`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [...nodeArgs, CHECK, "--runner", runner, "--name", "minimal", "--json", ...args], { timeout: timeoutMs, env });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    if (!failed.stdout) throw new Error(`the check didn't report (exit ${failed.code}): ${failed.stderr}`);
    return { code: failed.code ?? -1, report: JSON.parse(failed.stdout) };
  }
}

export const failing = (report: Report) => report.results.filter((r) => r.status === "fail")
  .map((r) => `${r.id}: ${r.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);

// Each break, the case that must catch it, and the check in that case that names it.
export async function expectCaught(broken: string, id: string, name: string): Promise<void> {
  const { code, report } = await check(["--cases", id, "--resume", "--first-input"], ` --break ${broken}`);
  const result = report.results.find((r) => r.id === id)!;
  expect(result.status).toBe("fail");
  // A case with several runs (1b's four failed handshakes, 6's three resumes) names each check after its run.
  expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toContainEqual(expect.stringContaining(name));
  expect(code).toBe(1);
}
