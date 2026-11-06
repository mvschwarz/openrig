import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configCommand } from "../src/commands/config.js";
import { ConfigStore, ENV_MAP } from "../src/config-store.js";

let dir: string;
let configPath: string;
const savedEnv = new Map<string, string | undefined>();

async function run(args: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await configCommand(configPath, {
      probeDaemonRunning: async () => false,
    }).parseAsync(["node", "rig", ...args]);
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  } finally {
    logSpy.mockRestore();
  }
}

describe("rig config reset and set with environment overrides (#2528)", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-reset-env-"));
    configPath = path.join(dir, "config.json");
    for (const mapping of Object.values(ENV_MAP)) {
      const names = [
        mapping.primary,
        ...(mapping.legacy ? [mapping.legacy] : []),
      ];
      for (const name of names) {
        savedEnv.set(name, process.env[name]);
        delete process.env[name];
      }
    }
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();

    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports when an environment override remains in effect after resetting a single key", async () => {
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "9000");

    process.env["OPENRIG_PORT"] = "8123";

    const output = await run(["reset", "daemon.port"]);
    expect(output).toBe(
      "daemon.port override cleared; effective value is 8123 (from environment, default is 7433).",
    );

    const jsonOutput = await run(["get", "daemon.port", "--json"]);
    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toEqual({
      value: 8123,
      source: "env",
      defaultValue: 7433,
    });
  });

  it("reports ordinary default reset when no environment override is active", async () => {
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "9000");

    const output = await run(["reset", "daemon.port"]);
    expect(output).toBe("daemon.port reset to default (7433).");
  });

  it("reports that an environment override masks the saved file value on set", async () => {
    process.env["OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS"] = "75";

    const output = await run([
      "set",
      "runtime.readiness_timeout_seconds",
      "60",
    ]);
    expect(output).toContain(
      "runtime.readiness_timeout_seconds = 75 (environment override masks saved file value)",
    );

    // Ensure the file value was genuinely saved
    const store = new ConfigStore(configPath);
    const fileConfig = store.readConfigFile();
    expect(fileConfig.runtime?.readinessTimeoutSeconds).toBe(60);
  });

  it("reports ordinary set confirmation when no environment override is active", async () => {
    const output = await run([
      "set",
      "runtime.readiness_timeout_seconds",
      "60",
    ]);
    expect(output).toBe("runtime.readiness_timeout_seconds = 60");
  });

  it("reports active environment overrides when resetting the entire config file", async () => {
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "9000");

    process.env["OPENRIG_PORT"] = "8123";

    const output = await run(["reset"]);
    expect(output).toBe(
      "Config reset to defaults (1 active environment override remains in effect).",
    );
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("reports clean defaults when resetting entire file with no active environment overrides", async () => {
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "9000");

    const output = await run(["reset"]);
    expect(output).toBe("Config reset to defaults.");
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
