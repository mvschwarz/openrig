// `rig config set` and `rig config reset` check the context-pressure pair as the config file will
// hold it: the file's values, with defaults where it sets none. Environment overrides aren't saved,
// so they aren't part of the check, and the refusal says so.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configCommand } from "../src/commands/config.js";

const ENV_NAMES = [
  "OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT",
  "OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT",
];

let dir: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

async function run(args: string[]): Promise<{ err: string; exitCode: number | undefined }> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await configCommand(configPath, { probeDaemonRunning: async () => false })
      .parseAsync(["node", "rig", ...args]);
    return { err: error.mock.calls.map((c) => c.join(" ")).join("\n"), exitCode: process.exitCode as number | undefined };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("rig config context-pressure pair check", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-pressure-pair-"));
    configPath = path.join(dir, "config.json");
    savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
    for (const name of ENV_NAMES) delete process.env[name];
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still refuses a critical below the file's warning and saves nothing, whatever the environment says", async () => {
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "50";
    const { exitCode } = await run(["set", "health.context_pressure.critical_percent", "80"]);
    expect(exitCode).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("the refusal says it checks the file's values and doesn't count environment overrides", async () => {
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "50";
    const { err } = await run(["set", "health.context_pressure.critical_percent", "80"]);
    expect(err).toBe(
      "Invalid context-pressure policy: in the config file, warning (95) must be less than critical (80); " +
        "a value the file doesn't set counts as its default (95/99), and environment overrides aren't saved, so they don't count here",
    );
  });

  it("a refused reset gives the same reason and leaves the file as it was", async () => {
    const before = JSON.stringify({ health: { contextPressure: { warningPercent: 99, criticalPercent: 100 } } });
    fs.writeFileSync(configPath, before);
    const { err, exitCode } = await run(["reset", "health.context_pressure.critical_percent"]);
    expect(exitCode).toBe(1);
    expect(err).toBe(
      "Invalid context-pressure policy: in the config file, warning (99) must be less than critical (99); " +
        "a value the file doesn't set counts as its default (95/99), and environment overrides aren't saved, so they don't count here",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });
});
