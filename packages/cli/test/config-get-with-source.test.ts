// `rig config get <key> --with-source` prints the value with its source, the
// same line `--show-source` gives, whichever side of `get` the flag is on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configCommand } from "../src/commands/config.js";
import { ENV_MAP } from "../src/config-store.js";

let dir: string;
let configPath: string;

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

describe("rig config get --with-source", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-get-with-source-"));
    configPath = path.join(dir, "config.json");
    for (const { primary, legacy } of Object.values(ENV_MAP)) {
      vi.stubEnv(primary, undefined);
      if (legacy) vi.stubEnv(legacy, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const positions: Array<[string, (key: string) => string[]]> = [
    ["after get", (key) => ["get", key, "--with-source"]],
    ["before get", (key) => ["--with-source", "get", key]],
  ];

  describe.each(positions)("flag %s", (_label, argsFor) => {
    it("reports a value from the config file", async () => {
      fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 7555 } }));
      expect(await run(argsFor("daemon.port"))).toBe("7555\t(source: file)");
    });

    it("reports a value from an environment variable", async () => {
      fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 7555 } }));
      process.env["OPENRIG_PORT"] = "7666";
      expect(await run(argsFor("daemon.port"))).toBe("7666\t(source: env)");
    });

    it("reports a default value", async () => {
      const expected = await run(["get", "daemon.port", "--show-source"]);
      expect(expected).toMatch(/\t\(source: default\)$/);
      expect(await run(argsFor("daemon.port"))).toBe(expected);
    });
  });

  it("prints the same line as --show-source", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 7555 } }));
    expect(await run(["get", "daemon.port", "--with-source"])).toBe(
      await run(["get", "daemon.port", "--show-source"]),
    );
  });

  it("leaves plain get and --json unchanged", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 7555 } }));
    expect(await run(["get", "daemon.port"])).toBe("7555");
    const json = JSON.parse(await run(["get", "daemon.port", "--json"]));
    expect(json).toMatchObject({ value: 7555, source: "file" });
  });

  it("reports the active environment override when setting or resetting a file value", async () => {
    process.env["OPENRIG_PORT"] = "7666";
    expect(await run(["set", "daemon.port", "7555"])).toContain("7666 (source: env; file override saved but masked)");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).daemon.port).toBe(7555);
    expect(await run(["reset", "daemon.port"])).toContain("effective value 7666 (source: env; default: 7433)");
    expect(await run(["reset"])).toContain("environment overrides them: daemon.port.");
  });

  it("retains the default reset message when no environment override remains", async () => {
    expect(await run(["reset"])).toBe("Config reset to defaults.");
  });

  it("reports a successful reset when reading effective configuration fails", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 7555 } }));
    vi.stubEnv("OPENRIG_CONTEXT_PACKS_ROOT", "/old-context");
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(["reset"])).toBe("Config reset to defaults.");
      expect(fs.existsSync(configPath)).toBe(false);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("OPENRIG_CONTEXT_PACKS_ROOT was removed");
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      errorSpy.mockRestore();
    }
  });

  it("does not promise a masked boot setting will take effect on restart", async () => {
    process.env["OPENRIG_PORT"] = "7666";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await configCommand(configPath, { probeDaemonRunning: async () => true })
        .parseAsync(["node", "rig", "set", "daemon.port", "7555"]);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("remains masked after restart");
    } finally { errorSpy.mockRestore(); }
  });

  it("distinguishes the saved threshold from the default used after an invalid environment pair", async () => {
    vi.stubEnv("OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT", "98");
    vi.stubEnv("OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT", undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run(["set", "health.context_pressure.critical_percent", "97"]))
        .toContain("file override saved; effective value 99 (source: default");
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).health.contextPressure.criticalPercent).toBe(97);
      expect(stderr).toHaveBeenCalled();
    } finally { stderr.mockRestore(); }
  });
});
