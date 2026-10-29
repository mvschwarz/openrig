import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

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
