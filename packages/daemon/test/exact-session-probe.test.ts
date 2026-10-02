import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("probes exact native session names so a live prefix neighbor cannot hide a detached seat", () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-exact-probe-"));
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/exact-session-probe.mjs", import.meta.url)), home,
    ], { env: { ...process.env, HOME: home, TMUX: "" }, encoding: "utf8", timeout: 15000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ nativeTmux: true, argvAndLegacy: true, missingDetached: true, neighborPreserved: true, exactPaneListing: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);
