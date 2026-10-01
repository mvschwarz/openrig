import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opr-reset-"));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("propagates a real filesystem reset failure without deleting the retained entry", () => {
  const config = path.join(root, "config.json");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "retained"), "keep");
  expect(() => new SettingsStore(config).reset()).toThrow();
  expect(fs.readFileSync(path.join(config, "retained"), "utf8")).toBe("keep");
});

it("still resets an existing file and treats a missing file as already reset", () => {
  fs.mkdirSync(root, { recursive: true });
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, '{"daemon":{"port":7777}}');
  const store = new SettingsStore(config);
  store.reset();
  expect(fs.existsSync(config)).toBe(false);
  expect(() => store.reset()).not.toThrow();
});
