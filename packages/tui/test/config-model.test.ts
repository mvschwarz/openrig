import { describe, expect, it } from "vitest";
import { CONFIG_CATEGORIES, configCategory, configEntries, configDetailLines, configListLines,
  configValue, configSourceLines, type ConfigRead, type ConfigEntry } from "../src/config/config-model.js";
import { SETTINGS_VALID_KEYS } from "../../daemon/src/domain/user-settings/settings-store.js";
const entry = (key: string, overrides: Partial<ConfigEntry> = {}): ConfigEntry => ({
  key, group: "general", value: true, defaultValue: false, source: "file", visibility: "shown",
  reason: null, scope: "Displayed daemon instance", application: "Running application unverified.", ...overrides,
});
const makeRead = (entries: ConfigEntry[]): ConfigRead => ({ observedAt: "2026-09-09T00:00:00Z", home: "/fixture",
  sources: [{ id: "general", state: "available", path: "/fixture/config.json", detail: "Environment > file > default." }],
  entries, exclusions: ["Credentials withheld."], readOnly: true });

describe("CONFIG presentation core (shared navigation not yet integrated)", () => {
  it("keeps all runtime keys categorized or discoverable and searches labels plus exact keys", () => {
    const read = makeRead([...SETTINGS_VALID_KEYS.map((key) => entry(key)), entry("future.owner_setting"),
      entry("slack.enabled", { group: "slack" }), entry("hosts.0.transport", { group: "hosts" }),
      entry("health.policy.diagnosis.enabled", { group: "health" })]);
    expect(read.entries.every((e) => CONFIG_CATEGORIES.some((c) => c.id === configCategory(e)))).toBe(true);
    expect(configEntries(read, "all")).toHaveLength(read.entries.length);
    expect(configEntries(read, "all", "retry interval").map((e) => e.key)).toEqual(["queue.wake_retry_interval_seconds"]);
    expect(configEntries(read, "all", "event history").map((e) => e.key)).toEqual(["retention.events_days"]);
    expect(configEntries(read, "all", "future.owner_setting")).toHaveLength(1);
    expect(configEntries(read, "slack").map((e) => e.key)).toEqual(["slack.enabled"]);
    expect(configEntries(read, "context").some((e) => e.group === "health")).toBe(true);
    expect(configEntries(read, "instance").some((e) => e.group === "hosts")).toBe(true);
  });
  it.each([54, 88])("fits a %i-column content pane while retaining full long detail", (width) => {
    const path = "/fixture/" + "long-folder/".repeat(18) + "tail";
    const read = makeRead([entry("workspace.root", { value: path, defaultValue: path }),
      entry("queue.wake_retry_interval_seconds", { value: 300, defaultValue: 300 })]);
    const list = configListLines(read.entries, width, "workspace.root");
    expect(list.every((l) => l.text.length <= width)).toBe(true);
    expect(list[0].text).toContain("…");
    const detail = configDetailLines(read, "workspace.root", width);
    expect(detail.every((l) => l.text.length <= width)).toBe(true);
    expect(detail.map((l) => l.text).join("").replaceAll(" ", "")).toContain(path);
    expect(read.entries[0].value).toBe(path);
    expect(configValue(read.entries[1])).toBe("5 min");
  });
  it("keeps unavailable and withheld values honest and invalidates removed selections", () => {
    const read = makeRead([entry("host.name", { visibility: "unavailable", value: null, defaultKnown: false }),
      entry("policies.claude_compaction.message_inline", { value: null, visibility: "withheld", reason: "Instruction body withheld." })]);
    expect(configValue(read.entries[0])).toBe("Unavailable");
    expect(configValue(read.entries[0], true)).toBe("Not reported");
    expect(configValue(read.entries[1])).toBe("Contents withheld");
    expect(configDetailLines(read, "removed.setting", 54)[0].text).toContain("unavailable after refresh");
    expect(configSourceLines(read, 54).map((l) => l.text).join(" ")).toContain("Credentials withheld.");
    expect(configSourceLines(null, 54)[0].text).toContain("CONFIG unavailable");
  });
});
