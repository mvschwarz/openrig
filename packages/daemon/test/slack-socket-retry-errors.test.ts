import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// POSIX directory write protection requires an ordinary user. The fixture does
// not pretend permissions fail on a root/Windows process where they do not.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["onopen", "periodic"])(
  "%s retry logs a real storage fault, survives, and recovers exactly one delivery",
  (phase) => {
    const home = mkdtempSync(join(tmpdir(), "openrig-slack-retry-child-"));
    try {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("./fixtures/slack-retry-storage-fault.mjs", import.meta.url)), phase, home,
      ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 10000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ phase, faults: 2, remaining: 0, rows: 1, state: "connected", requests: 1 });
    } finally {
      // A fatal baseline child cannot run its cleanup; retain ownership here.
      if (existsSync(join(home, "dead"))) chmodSync(join(home, "dead"), 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000,
);
