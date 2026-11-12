import { expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readPlatformEnv } from "../src/domain/platform-env.js";
import { probeCodexReadiness } from "../src/domain/kernel-boot.js";
import { checkCodexAuth } from "../../cli/src/provider-auth.js";

const variable = "OPENRIG_SYNTHETIC_PROVIDER_TOKEN";
const secret = "synthetic-do-not-echo-中文";
const config = `model_provider = "fixture"\n[model_providers.fixture]\nrequires_openai_auth = false\nenv_key = "${variable}"\n`;

it("keeps POSIX environment lookup case-sensitive and matches Windows duplicate selection", () => {
  const env = { [variable.toLowerCase()]: secret, [variable]: "" };
  expect(readPlatformEnv(env, variable, "linux")).toBe("");
  expect(readPlatformEnv({ [variable.toLowerCase()]: secret }, variable, "linux")).toBeUndefined();
  expect(readPlatformEnv(env, variable, "win32")).toBe("");
  expect(readPlatformEnv({ [variable.toLowerCase()]: secret }, variable, "win32")).toBe(secret);
});

it.runIf(process.platform === "win32").each([
  { env: { [variable.toLowerCase()]: secret }, present: true },
  { env: { [variable.toLowerCase()]: secret, [variable]: "" }, present: false },
  { env: { [variable.toLowerCase()]: "", [variable]: secret }, present: true },
])("CLI and kernel readiness match the native child's credential availability: $present", async ({ env, present }) => {
  const child = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(!!process.env[${JSON.stringify(variable)}]?.trim()))`], {
    env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toBe(present);
  const exec = vi.fn(() => "synthetic version");
  const cli = checkCodexAuth({ env, readFile: () => config, exec }, true);
  expect(cli.status).toBe(present ? "pass" : "fail");
  expect(exec).not.toHaveBeenCalled();
  expect(JSON.stringify(cli)).not.toContain(secret);
  const run = vi.fn(async (_cmd: string) => "ok" as const);
  expect(await probeCodexReadiness({ env, readConfig: () => config, run })).toBe(present ? "ok" : "unavailable");
  expect(run.mock.calls.length).toBe(present ? 1 : 0);
  if (present) expect(run).toHaveBeenCalledWith("codex --version");
});
