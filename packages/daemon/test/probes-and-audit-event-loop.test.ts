// The daemon must keep answering while a runtime probe or a skill audit runs. The plan, Codex launch and Codex resume
// probes ran `execSync` inside an async function, which held the event loop for the whole probe (most of a second for
// a real `codex -p <profile> mcp list`, up to 10 s for one that hangs); they now share execRuntimeProbe. The skill
// audit read every SKILL.md synchronously. The plan's probe is also covered end to end in bootstrap-orchestrator.test.ts.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execRuntimeProbe } from "../src/adapters/preflight-exec.js";
import { verifyCodexProfileLoads } from "../src/domain/codex-profile-preflight.js";
import { discoverSkillsWithProvenance } from "../src/domain/skill-discovery.js";

/** The value, and the longest the event loop went without running a 10 ms timer while it was being produced. */
async function withLongestTickGap<T>(run: () => Promise<T>): Promise<{ value: T; gap: number }> {
  const ticks = [Date.now()];
  const interval = setInterval(() => ticks.push(Date.now()), 10);
  const value = await run().finally(() => clearInterval(interval));
  ticks.push(Date.now());
  return { value, gap: Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]!)) };
}

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "probe-loop-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("the event loop stays free", () => {
  it("while a runtime probe runs", () => withDir(async (dir) => {
    writeFileSync(join(dir, "slow"), "#!/bin/sh\nsleep 1\necho ok\n", { mode: 0o755 });
    const { value, gap } = await withLongestTickGap(() => execRuntimeProbe("test.probe", join(dir, "slow")));
    expect(value).toBe("ok\n");
    expect(gap).toBeLessThan(500);
  }));

  it("and a probe gets no input, as it did under execSync", () => withDir(async (dir) => {
    writeFileSync(join(dir, "reads-input"), "#!/bin/sh\ncat\necho done\n", { mode: 0o755 });
    expect(await execRuntimeProbe("test.probe", join(dir, "reads-input"))).toBe("done\n");
  }));

  it("and a failed Codex profile probe still reports what Codex said", () => withDir(async (dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'profile probeprof contains legacy [profiles.probeprof]' >&2\nexit 1\n", { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const result = await verifyCodexProfileLoads("probeprof", (cmd) => execRuntimeProbe("test.probe", cmd, { cwd: dir, env }), undefined, dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("legacy");
    expect(result.migrationHint).toContain("probeprof.config.toml");
  }));

  it("while the skill audit scans every skill", () => withDir(async (dir) => {
    const home = join(dir, "home");
    for (let i = 0; i < 30; i++) {
      const skill = join(home, ".claude", "skills", `skill-${i}`);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), `---\nname: skill-${i}\ndescription: skill ${i}\n---\n\nBody.\n`);
    }
    let ticked = false;
    setImmediate(() => { ticked = true; });
    const result = await discoverSkillsWithProvenance({ runtime: "claude-code", homedir: home, cwd: join(dir, "work") });
    expect(result.skills).toHaveLength(30);
    // A synchronous scan returns before any other callback can run; one that reads asynchronously lets them in.
    expect(ticked).toBe(true);
  }));
});
