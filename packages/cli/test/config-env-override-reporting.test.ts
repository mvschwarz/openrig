import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configCommand } from "../src/commands/config.js";
import { ENV_MAP, type ValidKey } from "../src/config-store.js";

describe("issue #2528: config reset and set with active environment overrides", () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "opr-issue-2528-"));
    savedEnv = {};
    for (const mapping of Object.values(ENV_MAP)) {
      savedEnv[mapping.primary] = process.env[mapping.primary];
      delete process.env[mapping.primary];
      if (mapping.legacy) {
        savedEnv[mapping.legacy] = process.env[mapping.legacy];
        delete process.env[mapping.legacy];
      }
    }
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rig config reset <key> reports environment override and default honestly when env is active", async () => {
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));
    process.env["OPENRIG_PORT"] = "8123";

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "reset", "daemon.port"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("daemon.port override cleared (effective: 8123, from environment; default: 7433).");
    expect(output).not.toContain("reset to default (8123)");

    // File override was removed:
    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.daemon?.port).toBeUndefined();
  });

  it("rig config reset <key> reports reset to default when no env override is active", async () => {
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "reset", "daemon.port"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("daemon.port reset to default (7433).");
  });

  it("rig config set <key> notes when saved value is masked/overridden by environment", async () => {
    const configPath = path.join(root, "config.json");
    process.env["OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS"] = "75";

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "runtime.readiness_timeout_seconds", "60"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("runtime.readiness_timeout_seconds = 60 (effective: 75, overridden by environment)");

    // File contains saved value 60:
    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.runtime?.readinessTimeoutSeconds).toBe(60);
  });

  it("rig config set <key> prints ordinary key = value when no env override is present", async () => {
    const configPath = path.join(root, "config.json");

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "runtime.readiness_timeout_seconds", "60"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("runtime.readiness_timeout_seconds = 60");
  });

  it("rig config reset (whole file) identifies when environment overrides remain active", async () => {
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));
    process.env["OPENRIG_PORT"] = "8123";

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "reset"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/Config overrides cleared; 1 environment override still active\./);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("rig config reset (whole file) reports defaults when no environment overrides are active", async () => {
    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ daemon: { port: 9000 } }));

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "reset"]);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("Config reset to defaults.");
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
