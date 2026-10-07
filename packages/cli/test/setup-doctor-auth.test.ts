import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { doctorCommand, runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

function fixture(options: {
  missingLogin?: string[];
  missingCli?: string[];
  config?: string;
  env?: NodeJS.ProcessEnv;
} = {}): { setup: SetupDeps; doctor: DoctorDeps; commands: string[] } {
  const commands: string[] = [];
  const readFile = vi.fn((p: string) => p === "/fixture/codex/config.toml" ? options.config ?? null : null);
  const exec = (command: string) => {
    commands.push(command);
    if (options.missingCli?.some((name) => command === `${name} --version` || command.startsWith("npm install"))) {
      throw new Error("CLI unavailable");
    }
    if (options.missingLogin?.includes(command)) throw new Error("Not logged in");
    if (command === "tmux -V") return "tmux 3.4";
    if (command === "cmux capabilities --json") return '{"capabilities":[]}';
    return "available";
  };
  const common = { exec, readFile, exists: () => true, platform: "linux" as const, env: { HOME: "/fixture", CODEX_HOME: "/fixture/codex", ...options.env } };
  return {
    commands,
    setup: { ...common, writeFile: vi.fn(), mkdirp: vi.fn() },
    doctor: {
      ...common, baseDir: "/fixture/cli/dist", checkPort: async () => true,
      configStore: { resolve: () => ({ daemon: { host: "127.0.0.1", port: 7433 }, db: { path: "/fixture/openrig.sqlite" }, transcripts: { enabled: true, path: "/fixture/transcripts" } }) },
      mkdirp: vi.fn(), checkWritable: vi.fn(), fetch: async () => ({ ok: false }),
    },
  };
}

const authNames = ["claude_auth", "codex_auth"];
const providerConfig = 'model_provider = "fixture"\n[model_providers.fixture]\nrequires_openai_auth = false\nenv_key = "FIXTURE_PROVIDER_KEY"\n';

describe("setup and doctor provider facts", () => {
  it.each<[string, string[], string[]]>([
    ["both logged out", ["claude auth status", "codex login status"], ["fail", "fail"]],
    ["Claude only", ["codex login status"], ["pass", "fail"]],
    ["Codex only", ["claude auth status"], ["fail", "pass"]],
    ["both logged in", [], ["pass", "pass"]],
  ])("agrees after setup: %s", async (_label, missingLogin, expected) => {
    const { setup, doctor, commands } = fixture({ missingLogin });
    const result = await runSetup(setup, { doctorDeps: doctor });
    const setupAuth = result.steps.filter((step) => authNames.includes(step.id));
    expect(setupAuth.map((step) => step.status)).toEqual(expected);
    expect(result.ready).toBe(expected.every((status) => status === "pass"));
    // Doctor-backed setup verification must reuse the checks made after installation.
    for (const command of ["claude auth status", "codex login status"]) {
      expect(commands.filter((value) => value === command)).toHaveLength(1);
    }
    const checks = runDoctorChecks(doctor).checks.filter((check) => authNames.includes(check.name));
    expect(checks).toEqual(setupAuth.map(({ id, fixHint, ...check }) => ({ name: id, ...check, ...(fixHint ? { fix: fixHint } : {}) })));
    expect(result.verification?.checks.filter((check) => authNames.includes(check.name))).toEqual(checks);
  });

  it.each([undefined, "", "   ", "inert-test-value"])("keeps configured-provider credentials local and consistent (%j)", async (key) => {
    const { setup, doctor, commands } = fixture({ config: providerConfig, env: { FIXTURE_PROVIDER_KEY: key } });
    const result = await runSetup(setup, {});
    const check = runDoctorChecks(doctor).checks.find((item) => item.name === "codex_auth");
    expect(check?.status).toBe(key?.trim() ? "pass" : "fail");
    expect(check?.message).toBe(result.steps.find((step) => step.id === "codex_auth")?.message);
    expect(check?.message).toContain("FIXTURE_PROVIDER_KEY");
    expect(JSON.stringify(check)).not.toContain("inert-test-value");
    expect(commands).not.toContain("codex login status");
    expect(doctor.readFile).toHaveBeenCalledWith("/fixture/codex/config.toml");
  });

  it.each(["broken = [", 'profile = "legacy"\n' + providerConfig])("keeps the unresolved-config login fallback (%s)", async (config) => {
    const { setup, doctor } = fixture({ config, missingLogin: ["codex login status"] });
    const result = await runSetup(setup, {});
    const check = runDoctorChecks(doctor).checks.find((item) => item.name === "codex_auth");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("OpenAI login was checked");
    expect(check?.message).toBe(result.steps.find((step) => step.id === "codex_auth")?.message);
  });

  it("reports missing CLIs without installing or attempting authentication", () => {
    const { doctor, commands } = fixture({ missingCli: ["claude", "codex"] });
    const { checks } = runDoctorChecks(doctor);
    for (const name of ["claude", "codex"]) {
      expect(checks.find((check) => check.name === `${name}_install`)?.status).toBe("fail");
      expect(checks.find((check) => check.name === `${name}_auth`)?.status).toBe("skipped");
    }
    expect(commands.filter((command) => /claude|codex|npm/.test(command))).toEqual(["claude --version", "codex --version"]);
  });

  it.each([false, true])("doctor login failure is visible and exits 1 (json=%s)", async (json) => {
    const { doctor, commands } = fixture({ missingLogin: ["claude auth status", "codex login status"] });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    process.exitCode = undefined;
    await new Command().addCommand(doctorCommand(doctor)).parseAsync(["node", "rig", "doctor", ...(json ? ["--json"] : [])]);
    expect(process.exitCode).toBe(1);
    const output = logs.join("\n");
    if (json) {
      const value = JSON.parse(output);
      expect(value.healthy).toBe(false);
      expect(value.checks.filter((check: { name: string }) => authNames.includes(check.name)).map((check: { status: string }) => check.status)).toEqual(["fail", "fail"]);
    } else {
      expect(output).toContain("[FAIL] claude_auth");
      expect(output).toContain("[FAIL] codex_auth");
      expect(output).toContain("claude auth login");
      expect(output).toContain("codex login");
    }
    expect(commands.filter((command) => /claude|codex|npm/.test(command))).toEqual(["claude --version", "claude auth status", "codex --version", "codex login status"]);
  });
});
