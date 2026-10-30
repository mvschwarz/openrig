import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "win32")("suppresses the plugin duplicate for an identical settings relay with native filename casing", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-native-case-"));
  const source = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  const relay = join(root, "state/claude-activity-hooks/activity-relay.cjs");
  try {
    mkdirSync(dirname(relay), { recursive: true }); copyFileSync(source, relay);
    mkdirSync(join(root, ".claude"));
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command",
      command: `${quote(process.execPath)} ${quote(relay.toUpperCase())}` }] }] } }));
    const { settingsRelayReports, pluginRunIsRedundant } = createRequire(import.meta.url)(source);
    const env = { CLAUDE_PROJECT_DIR: root, OPENRIG_RUNTIME: "claude-code" };
    expect(settingsRelayReports("Stop", {}, env)).toBe(true);
    expect(pluginRunIsRedundant({ hookEvent: "Stop" }, ["node", source, "--from-plugin"], env)).toBe(true);
    expect(settingsRelayReports("Notification", {}, env)).toBe(false);
    writeFileSync(relay, "// distinct owned fixture\n");
    expect(settingsRelayReports("Stop", {}, env)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("recognizes the same settings relay through a quoted native PATH snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-native-path-"));
  const source = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  const relay = join(root, "state/claude-activity-hooks/activity-relay.cjs");
  mkdirSync(dirname(relay), { recursive: true }); copyFileSync(source, relay);
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${relay}'` }] }] } }));
  const { settingsRelayReports } = createRequire(import.meta.url)(source);
  try {
    expect(settingsRelayReports("Stop", { cwd: root }, { pAtH: `"${dirname(process.execPath)}"` })).toBe(true);
    expect(settingsRelayReports("Stop", { cwd: root }, { PATH: "", Path: dirname(process.execPath) })).toBe(false);
    writeFileSync(relay, "// different script");
    expect(settingsRelayReports("Stop", { cwd: root }, { pAtH: `"${dirname(process.execPath)}"` })).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
