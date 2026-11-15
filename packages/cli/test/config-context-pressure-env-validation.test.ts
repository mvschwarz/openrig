import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configCommand } from "../src/commands/config.js";
import { ConfigStore } from "../src/config-store.js";

describe("issue #2529: context-pressure inverted environment pair reporting", () => {
  let root: string;
  let configPath: string;
  let savedEnv: Record<string, string | undefined>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "opr-issue-2529-"));
    configPath = path.join(root, "config.json");
    savedEnv = {
      OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT: process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"],
      OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT: process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT"],
    };
    delete process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"];
    delete process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT"];
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

  it("persists valid file value and reports inverted environment pair with env sources", async () => {
    // Scenario 2 from issue #2529:
    // warning is 98 in env. Setting critical to 97 in file.
    // The write succeeds, persists critical 97 to file, but reports the inverted pair
    // and that it falls back to 95/99 defaults in this shell.
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "98";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "health.context_pressure.critical_percent", "97"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBe(97);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(
      "health.context_pressure.critical_percent file override saved; effective value 99 (source: default; inverted pair 98/97 from OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT=98 falls back to 95/99 defaults in this shell)",
    );
    stderr.mockRestore();
  });

  it("persists and prints cleanly without warning when there is no environment conflict", async () => {
    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "health.context_pressure.critical_percent", "100"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBe(100);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("health.context_pressure.critical_percent = 100");
  });

  it("whole-file reset still works even if config file is malformed JSON", async () => {
    fs.writeFileSync(configPath, "{ not valid json ... ");
    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "reset"]);

    expect(fs.existsSync(configPath)).toBe(false);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("Config reset to defaults.");
  });

  it("reports inverted pair on reset <key> when active environment override causes fallback", async () => {
    // File has warning 90, critical 98
    const store = new ConfigStore(configPath);
    store.set("health.context_pressure.warning_percent", "90");
    store.set("health.context_pressure.critical_percent", "98");

    // Environment sets warning=99
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "99";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const cmd = configCommand(configPath);
    // Resetting critical removes file 98, so file has warning 90 / default critical 99.
    // But with env warning=99, env warning (99) >= default critical (99), falling back to 95/99.
    await cmd.parseAsync(["node", "rig", "reset", "health.context_pressure.critical_percent"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBeUndefined();

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(
      "health.context_pressure.critical_percent file override cleared; effective value 99 (source: default; inverted pair 99/99 from OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT=99 falls back to 95/99 defaults in this shell).",
    );
    stderr.mockRestore();
  });

  it("resets cleanly to default without inversion warning when no environment conflict exists", async () => {
    const store = new ConfigStore(configPath);
    store.set("health.context_pressure.critical_percent", "100");

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "reset", "health.context_pressure.critical_percent"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBeUndefined();

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("health.context_pressure.critical_percent reset to default (99).");
    expect(output).not.toContain("inverted");
  });

  it("handles rejected partial environment override without false inversion warning", async () => {
    // Warning env is partial/malformed '98junk', setting critical to 97 on an empty file.
    // The resolver discards '98junk' (falls back to default 95), so pair is 95/97 (valid).
    // The write saves 97, effective is 97 from file, and no inversion/fallback is reported.
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "98junk";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "health.context_pressure.critical_percent", "97"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBe(97);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("health.context_pressure.critical_percent = 97");
    expect(output).not.toContain("inverted");
    stderr.mockRestore();
  });

  it("handles rejected out-of-range environment override without false inversion warning", async () => {
    // Warning env is out-of-range '101', setting critical to 97 on an empty file.
    // The resolver discards '101' (falls back to default 95), so pair is 95/97 (valid).
    // The write saves 97, effective is 97 from file, and no inversion/fallback is reported.
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT"] = "101";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "health.context_pressure.critical_percent", "97"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBe(97);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toBe("health.context_pressure.critical_percent = 97");
    expect(output).not.toContain("inverted");
    stderr.mockRestore();
  });

  it("correctly explains fallback when an invalid file value is discarded and causes inversion", async () => {
    // File has invalid warningPercent: 0, critical env is 90.
    // Writing critical 100 to file saves critical 100.
    // The resolver discards file warningPercent 0, uses default 95.
    // With critical env 90, warning 95 >= critical 90 causes inversion and fallback to 95/99.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ health: { contextPressure: { warningPercent: 0 } } }, null, 2) + "\n",
    );
    process.env["OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT"] = "90";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const cmd = configCommand(configPath);
    await cmd.parseAsync(["node", "rig", "set", "health.context_pressure.critical_percent", "100"]);

    const fileContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(fileContent.health?.contextPressure?.criticalPercent).toBe(100);

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(
      "health.context_pressure.critical_percent file override saved; effective value 99 (source: default; inverted pair 95/90 from OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT=90 falls back to 95/99 defaults in this shell)",
    );
    stderr.mockRestore();
  });
});
