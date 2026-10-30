import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "win32")("keeps refocus baseline and pending state in the native profile without HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "refocus-native-home-用户-"));
  const hook = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/refocus.cjs");
  const env = { ...process.env, PATH: "", HOME: "", USERPROFILE: root, OPENRIG_HOME: "", RIGGED_HOME: "", OPENRIG_SESSION_NAME: "synthetic@fixture", OPENRIG_REFOCUS_ENABLED: "1", OPENRIG_REFOCUS_NOW: "" };
  const run = (event: string, override: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [hook], {
    env: { ...env, ...override }, input: JSON.stringify({ hook_event_name: event, session_id: "owned-occupant", cwd: root }), encoding: "utf8", timeout: 10_000,
  });
  try {
    const result = run("Stop"); expect(result.status, result.stderr).toBe(0);
    const file = join(root, ".openrig/refocus/synthetic@fixture__owned-occupant.json");
    expect(existsSync(file)).toBe(true);
    const compact = run("PostCompact"); expect(compact.status, compact.stderr).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pendingOn: "PostCompact" });
    const explicit = join(root, "selected-instance");
    expect(run("Stop", { OPENRIG_HOME: explicit }).status).toBe(0);
    expect(existsSync(join(explicit, "refocus/synthetic@fixture__owned-occupant.json"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
