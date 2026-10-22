// `rig config get <key> --with-source` prints the value with its source, the
// same line `--show-source` gives, whichever side of `get` the flag is on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configCommand } from "../src/commands/config.js";

let dir: string;
let configPath: string;
let savedPort: string | undefined;

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
    savedPort = process.env["OPENRIG_PORT"];
    delete process.env["OPENRIG_PORT"];
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env["OPENRIG_PORT"];
    else process.env["OPENRIG_PORT"] = savedPort;
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
});
