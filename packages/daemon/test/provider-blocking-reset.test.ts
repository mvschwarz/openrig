import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reports when every exhausted Claude window can reset through the cache and usage route", () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-blocking-reset-"));
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/provider-blocking-reset.mjs", import.meta.url)), home,
    ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 10000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ scenarios: ["both-exhausted", "only-five-exhausted",
      "offset-order", "one-unparseable-reset"], cacheCollectorAndRoute: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
