import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

it.runIf(process.platform === "win32")("recognizes a persisted native legacy default with forward separators", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-legacy-native-"));
  const file = path.join(root, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ workspace: { root, slicesRoot: path.join(root, "slices").replaceAll("\\", "/") } }));
    expect(new SettingsStore(file).resolveOne("workspace.slices_root"))
      .toMatchObject({ value: path.join(root, "missions"), source: "default" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("creates and updates an owned settings file with a valid long name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-long-"));
  const name = "c".repeat(230) + ".yaml", file = path.join(root, name);
  try {
    const store = new SettingsStore(file);
    store.set("daemon.port", "17891");
    expect(new SettingsStore(file).resolveOne("daemon.port").value).toBe(17891);
    store.set("daemon.port", "17892");
    expect(new SettingsStore(file).resolveOne("daemon.port").value).toBe(17892);
    expect(fs.readdirSync(root)).toEqual([name]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
