import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["recovery", "incomplete"])("%s reconciliation recovers markers and retries incomplete scans without stranding notifications", (group) => {
  const home = mkdtempSync(join(tmpdir(), "openrig-reconcile-pages-"));
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/slack-reconcile-pagination.mjs", import.meta.url)), group, home,
    ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 30000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const cases = JSON.parse(result.stdout.trim()) as Array<{ posts: number; outcome: boolean; attempted: boolean }>;
    expect(cases).toHaveLength(group === "recovery" ? 8 : 6);
    expect(cases.every((testCase) => testCase.attempted && (group !== "recovery" || testCase.posts === 1 && testCase.outcome))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 45000);
