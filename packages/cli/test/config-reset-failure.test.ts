import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { configCommand } from "../src/commands/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opr-reset-"));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; fs.rmSync(root, { recursive: true, force: true }); });

it("reports a failed reset instead of claiming the configuration was removed", async () => {
  const config = path.join(root, "config.json");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "retained"), "keep");
  expect(() => new ConfigStore(config).reset()).toThrow();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await configCommand(config).parseAsync(["reset"], { from: "user" });
  expect(process.exitCode).toBe(1);
  expect(log).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  expect(fs.readFileSync(path.join(config, "retained"), "utf8")).toBe("keep");
});

it("still resets an existing file and treats a missing file as already reset", () => {
  fs.mkdirSync(root, { recursive: true });
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, '{"daemon":{"port":7777}}');
  const store = new ConfigStore(config);
  store.reset();
  expect(fs.existsSync(config)).toBe(false);
  expect(() => store.reset()).not.toThrow();
});
