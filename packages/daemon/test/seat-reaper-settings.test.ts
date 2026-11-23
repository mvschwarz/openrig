import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";
import { ConfigStore, VALID_KEYS } from "../../cli/src/config-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** #3836 review: inherited OPENRIG_POLICIES_SEAT_SCALE_* overrides would defeat the
 *  defaults assertion (a temp config path does not isolate the environment). */
function withoutSeatScaleEnv<T>(run: () => T): T {
  const saved = Object.entries(process.env)
    .filter(([key]) => key.startsWith("OPENRIG_POLICIES_SEAT_SCALE_"))
    .map(([key, value]) => [key, process.env[key]] as const);
  for (const [key] of saved) delete process.env[key];
  try { return run(); } finally { for (const [key, value] of saved) process.env[key] = value; }
}



it("registers the same six seat-scale keys in both settings twins", () => {
  // Given the daemon and CLI's machine-consumed key lists.
  const cli = readFileSync(new URL("../../cli/src/config-store.ts", import.meta.url), "utf8");
  const expected = ["enabled", "observe", "idle_threshold_minutes", "max_reaps_per_24h", "protected_rigs", "opt_in_rigs"]
    .map(key => `policies.seat_scale.${key}`);
  // When selecting the new namespace.
  const keys = SETTINGS_VALID_KEYS.filter(key => key.startsWith("policies.seat_scale."));
  // Then both twins expose exactly the agreed surface.
  expect(keys).toEqual(expected);
  expect(VALID_KEYS.filter(key => key.startsWith("policies.seat_scale."))).toEqual(keys);
  for (const key of keys) expect(cli).toContain(`"${key}"`);
});

it("defaults to disabled observation and validates policy limits", () => {
  // Given a fresh, isolated config path.
  const root = mkdtempSync(join(tmpdir(), "seat-reaper-settings-")); roots.push(root);
  const store = new SettingsStore(join(root, "config.json"));
  // When resolving the new policy with no inherited policy environment.
  const values = withoutSeatScaleEnv(() => SETTINGS_VALID_KEYS.filter(key => key.startsWith("policies.seat_scale."))
    .map(key => store.resolveOne(key).value));
  // Then default posture and bounds are conservative.
  expect(values).toEqual([false, true, 240, 12, '["coordination"]', "[]"]);
  const cli = new ConfigStore(join(root, "config.json"));
  for (const key of SETTINGS_VALID_KEYS.filter(key => key.startsWith("policies.seat_scale."))) {
    expect(cli.resolveOne(key).value).toEqual(store.resolveOne(key).value);
  }
});

it("rejects non-hours thresholds and malformed rig lists in both twins", () => {
  // Given the two writers on private config paths.
  const root = mkdtempSync(join(tmpdir(), "seat-reaper-validation-")); roots.push(root);
  const stores = [new SettingsStore(join(root, "daemon.json")), new ConfigStore(join(root, "cli.json"))];
  // When a value cannot express a conservative, typed policy.
  // Then neither writer accepts it.
  for (const store of stores) {
    expect(() => store.set("policies.seat_scale.idle_threshold_minutes", "59")).toThrow();
    expect(() => store.set("policies.seat_scale.max_reaps_per_24h", "0")).toThrow();
    expect(() => store.set("policies.seat_scale.protected_rigs", "coordination")).toThrow();
    expect(() => store.set("policies.seat_scale.opt_in_rigs", '[42]')).toThrow();
    // #3836 review: both writers reject what the daemon's zod reader rejects — a cap the
    // reader refuses must never reach the config file (each read would be a failed pass).
    expect(() => store.set("policies.seat_scale.max_reaps_per_24h", "10001")).toThrow();
    expect(() => store.set("policies.seat_scale.max_reaps_per_24h", "10000")).not.toThrow();
  }
});
