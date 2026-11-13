import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore, SETTINGS_VALID_KEYS, isSettingsValidKey, parseFeedHostSubscriptionKey } from "../src/domain/user-settings/settings-store.js";
import { settingsBrowser } from "../src/domain/user-settings/settings-browser.js";
import { configRoutes } from "../src/routes/config.js";

let home: string;
let n = 0;
const freshStore = () => new SettingsStore(join(home, `config-${n++}.json`));
const browse = () => settingsBrowser(freshStore(), null, home);
/** The write path is the oracle: does the daemon's own set() accept this raw value for this key? */
const accepts = (key: string, raw: string): boolean => {
  try { freshStore().set(key, raw); return true; } catch { return false; }
};
/** Each accepts 1 to 100 on its own, but set() also requires warning < critical: a cross-key rule these per-key fields do not describe. */
const PAIRED = new Set(["health.context_pressure.warning_percent", "health.context_pressure.critical_percent"]);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s06-browser-meta-"));
  for (const key of Object.keys(process.env).filter((k) => /^(OPENRIG_|RIGGED_|SLACK_)/.test(k))) vi.stubEnv(key, "");
  vi.stubEnv("OPENRIG_HOME", home);
  vi.stubEnv("OPENRIG_WORKSPACE_ROOT", join(home, "workspace"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("browser entry metadata", () => {
  it("adds type, choices, range, format, write route and timing without changing the existing fields", () => {
    const entries = browse().entries;
    expect(entries.find((e) => e.key === "terminal.history_limit")).toMatchObject({
      type: "integer", range: { min: 2000, max: 1_000_000 }, writeRoute: true, appliesAt: "unknown",
      value: expect.anything(), defaultKnown: true, application: expect.stringContaining("tmux"),
    });
    expect(entries.find((e) => e.key === "terminal.tmux_server")).toMatchObject({
      type: "enum", choices: ["inherit", "isolated"], writeRoute: true, appliesAt: "daemon_restart",
    });
    expect(entries.find((e) => e.key === "daemon.port")).toMatchObject({ type: "integer", range: { min: 0, max: 65535 } });
    expect(entries.find((e) => e.key === "retention.stream_days")).toMatchObject({ type: "integer", range: { min: 1 } });
    expect(entries.find((e) => e.key === "retention.stream_days")!.range).not.toHaveProperty("max");
    expect(entries.find((e) => e.key === "ui.timezone")).toMatchObject({ type: "string", format: "iana-timezone" });
    expect(entries.find((e) => e.key === "retention.enabled")).toMatchObject({ type: "boolean", appliesAt: "daemon_restart" });
    // A key with no validator reports a type and nothing it cannot back up.
    const free = entries.find((e) => e.key === "host.name")!;
    expect(free).toMatchObject({ type: "string", writeRoute: true });
    expect(free).not.toHaveProperty("choices");
    expect(free).not.toHaveProperty("range");
    expect(free).not.toHaveProperty("format");
  });

  it("matches the daemon's own validator for every key it can be written under", () => {
    const entries = browse().entries.filter((e) => e.group === "general" && isSettingsValidKey(e.key));
    expect(entries.map((e) => e.key)).toEqual([...SETTINGS_VALID_KEYS]);
    for (const e of entries) {
      expect(e.writeRoute, e.key).toBe(true);
      expect(e.type, e.key).toBeDefined();
      if (e.type === "boolean") {
        expect(accepts(e.key, "true"), e.key).toBe(true);
        expect(accepts(e.key, "false"), e.key).toBe(true);
        expect(accepts(e.key, "not-a-boolean"), e.key).toBe(false);
      }
      if (e.type === "integer" && !PAIRED.has(e.key)) {
        expect(accepts(e.key, "not-a-number"), e.key).toBe(false);
        if (e.range?.min !== undefined) {
          expect(accepts(e.key, String(e.range.min)), `${e.key} min`).toBe(true);
          expect(accepts(e.key, String(e.range.min - 1)), `${e.key} below min`).toBe(false);
        }
        if (e.range?.max !== undefined) {
          expect(accepts(e.key, String(e.range.max)), `${e.key} max`).toBe(true);
          expect(accepts(e.key, String(e.range.max + 1)), `${e.key} above max`).toBe(false);
        }
        // Where a side is left out, the validator must accept a value far on that side.
        if (e.range?.max === undefined) expect(accepts(e.key, "1000000000"), `${e.key} no max`).toBe(true);
        if (e.range?.min === undefined) expect(accepts(e.key, "0") || accepts(e.key, "1"), `${e.key} no min`).toBe(true);
      }
      if (e.choices) {
        expect(e.type, e.key).toBe("enum");
        for (const choice of e.choices) expect(accepts(e.key, choice), `${e.key}=${choice}`).toBe(true);
        expect(accepts(e.key, "not-one-of-the-choices"), e.key).toBe(false);
      }
    }
  });

  it("states a range only where the validator is an interval, at sample points across the whole line", () => {
    const samples = [-1_000_000_000, -100_001, -1000, -61, -60, -2, -1, 0, 1, 2, 59, 60, 100, 101, 599, 600, 601,
      999, 1000, 1999, 2000, 2001, 3600, 3601, 65535, 65536, 999_999, 1_000_000, 1_000_001, 1_000_000_000];
    const ranged = browse().entries.filter((x) => x.type === "integer" && x.range && !PAIRED.has(x.key));
    expect(ranged.length).toBeGreaterThan(25);
    for (const e of ranged) {
      for (const sample of samples) {
        const inside = (e.range!.min === undefined || sample >= e.range!.min) && (e.range!.max === undefined || sample <= e.range!.max);
        expect(accepts(e.key, String(sample)), `${e.key} at ${sample}`).toBe(inside);
      }
    }
  });

  it("reports the per-key range of the paired percentages and leaves their cross-key rule out", () => {
    const entries = browse().entries;
    for (const key of PAIRED) expect(entries.find((e) => e.key === key)).toMatchObject({ type: "integer", range: { min: 1, max: 100 } });
    // Per key the bounds are the validator's: critical takes 100, nothing takes 0 or 101 ...
    expect(accepts("health.context_pressure.critical_percent", "100")).toBe(true);
    for (const key of PAIRED) for (const bad of ["0", "101"]) expect(accepts(key, bad), `${key}=${bad}`).toBe(false);
    expect(accepts("health.context_pressure.warning_percent", "1")).toBe(true);
    // ... while the pair rule (warning below critical) still refuses a value inside that range, and is not a field here.
    expect(accepts("health.context_pressure.warning_percent", "100")).toBe(false);
    expect(entries.find((e) => e.key === "health.context_pressure.warning_percent")).not.toHaveProperty("pair");
  });

  it("names a format that agrees with what the validator accepts and refuses", () => {
    const cases: Record<string, { format: string; ok: string[]; bad: string[] }> = {
      "ui.timezone": { format: "iana-timezone", ok: ["Europe/London", "UTC"], bad: ["Not/AZone", "+01:00"] },
      "policies.claude_compaction.preparation_root": { format: "absolute-path-or-empty", ok: ["/var/lib/example", ""], bad: ["relative/path"] },
      "decisions.template_dir": { format: "absolute-path-or-empty", ok: ["/var/lib/example", ""], bad: ["relative/path"] },
      "retention.erasure_ledger": { format: "absolute-path-or-empty", ok: ["/var/lib/example/ledger", ""], bad: ["relative/ledger"] },
      "stream.intake": { format: "queue.worker, off, or member@rig", ok: ["off", "queue.worker", "seat@rig"], bad: ["no at sign"] },
      "acp.to": { format: "member@rig-or-empty", ok: ["seat@rig", ""], bad: ["no-at-sign", "a@b@c"] },
    };
    const entries = browse().entries;
    for (const [key, c] of Object.entries(cases)) {
      expect(entries.find((e) => e.key === key)!.format, key).toBe(c.format);
      for (const ok of c.ok) expect(accepts(key, ok), `${key}=${ok}`).toBe(true);
      for (const bad of c.bad) expect(accepts(key, bad), `${key}=${bad}`).toBe(false);
    }
    // Every key that reports a format is in this table, so a new one cannot ship unchecked.
    expect(entries.filter((e) => e.format).map((e) => e.key).sort()).toEqual(Object.keys(cases).sort());
  });

  it("reports the write route as the daemon's own key rules decide, for every entry", () => {
    const store = freshStore();
    store.set("feed.subscriptions.fixture-host.enabled", "true");
    const entries = settingsBrowser(store, null, home).entries;
    for (const e of entries) {
      expect(e.writeRoute, e.key).toBe(isSettingsValidKey(e.key) || parseFeedHostSubscriptionKey(e.key) !== null);
    }
    expect(entries.find((e) => e.key === "feed.subscriptions.fixture-host.enabled")).toMatchObject({ type: "boolean", writeRoute: true });
    expect(entries.find((e) => e.key === "slack.enabled")).toMatchObject({ writeRoute: false });
    expect(entries.find((e) => e.key === "slack.enabled")).not.toHaveProperty("type");
    expect(entries.filter((e) => e.group !== "general" && e.writeRoute)).toEqual([]);
  });

  it("agrees with the write route itself: the keys it reports writable are accepted, the others are unknown keys", async () => {
    const store = freshStore();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("settingsStore" as never, store as never); await next(); });
    app.route("/api/config", configRoutes({ home }));
    const post = (key: string, value: string) => app.request(`/api/config/${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    expect((await post("terminal.history_limit", "5000")).status).toBe(200);
    expect((await post("terminal.history_limit", "1999")).status).toBe(400);
    const refused = await post("slack.enabled", "true");
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("Unknown config key");
    const browser = await (await app.request("/api/config?view=browser")).json();
    expect(browser.entries.find((e: { key: string }) => e.key === "terminal.history_limit")).toMatchObject({ writeRoute: true, range: { min: 2000, max: 1_000_000 } });
    expect(browser.entries.find((e: { key: string }) => e.key === "slack.enabled")).toMatchObject({ writeRoute: false });
    expect(browser.readOnly).toBe(true);
  });

  it("marks timing only where the application guidance says a restart applies it, and says unknown otherwise", () => {
    for (const e of browse().entries) {
      const guidanceSaysRestart = /\bdaemon (?:restart|startup)\b/i.test(e.application);
      expect(e.appliesAt, e.key).toBe(guidanceSaysRestart ? "daemon_restart" : "unknown");
    }
  });
});
