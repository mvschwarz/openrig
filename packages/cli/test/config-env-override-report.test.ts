// `rig config set` and `rig config reset` describe the config-file change they made. When an
// environment variable still supplies the value in effect, they name it instead of calling that
// value the default or printing it as the saved value.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ENV_MAP } from "../src/config-store.js";
import { configCommand } from "../src/commands/config.js";

const ENV_NAMES = [...new Set(Object.values(ENV_MAP).flatMap((e) => (e.legacy ? [e.primary, e.legacy] : [e.primary])))];

let dir: string;
let configPath: string;
let savedEnv: Record<string, string | undefined>;

async function run(args: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await configCommand(configPath, { probeDaemonRunning: async () => false })
      .parseAsync(["node", "rig", ...args]);
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  } finally {
    logSpy.mockRestore();
  }
}

describe("rig config set and reset beside an environment override", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-env-override-"));
    configPath = path.join(dir, "config.json");
    savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
    for (const name of ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reset of one key names the variable that still sets it instead of calling its value the default", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));
    process.env["OPENRIG_PORT"] = "8123";
    expect(await run(["reset", "daemon.port"])).toBe(
      "daemon.port file override cleared; OPENRIG_PORT still sets it to 8123 in this environment (default 7433).",
    );
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({});
  });

  it("names a legacy variable when only it is set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));
    process.env["RIGGED_PORT"] = "8123";
    expect(await run(["reset", "daemon.port"])).toBe(
      "daemon.port file override cleared; RIGGED_PORT still sets it to 8123 in this environment (default 7433).",
    );
  });

  it("set reports the saved value and the variable that overrides it", async () => {
    process.env["OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS"] = "75";
    expect(await run(["set", "runtime.readiness_timeout_seconds", "60"])).toBe(
      "runtime.readiness_timeout_seconds = 60 saved; OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS overrides it in this environment, so 75 is in effect.",
    );
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ runtime: { readinessTimeoutSeconds: 60 } });
  });

  it("set says when a default is in effect instead of the saved value", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "98";
    expect(await run(["set", "health.context_pressure.critical_percent", "97"])).toBe(
      "health.context_pressure.critical_percent = 97 saved; the default 99 is in effect.",
    );
  });

  it("a whole-file reset names the overrides that remain", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));
    process.env["OPENRIG_PORT"] = "8123";
    expect(await run(["reset"])).toBe(
      "Config reset to defaults, except where the environment overrides them: daemon.port (OPENRIG_PORT).",
    );
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("without an override, the messages are unchanged", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));
    expect(await run(["reset", "daemon.port"])).toBe("daemon.port reset to default (7433).");
    expect(await run(["set", "daemon.port", "7555"])).toBe("daemon.port = 7555");
    expect(await run(["reset"])).toBe("Config reset to defaults.");
  });
});
