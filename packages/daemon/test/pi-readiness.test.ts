import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { piCredentialNotice, piVersionNotice } from "../src/adapters/pi-readiness.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";

const agentDir = path.resolve("fixture", "managed", "agent");
const missing = () => { throw Object.assign(new Error("private-path"), { code: "ENOENT" }); };
function check(files: Record<string, unknown> = {}, env: Record<string, string> = {}, model = "openrouter/fixture") {
  const readFile = vi.fn((file: string) => {
    expect(path.dirname(file)).toBe(agentDir);
    const name = path.basename(file);
    return Object.hasOwn(files, name) ? JSON.stringify(files[name]) : missing();
  });
  const notice = piCredentialNotice({ agentDir, model, env, readFile });
  expect(notice).not.toContain("private-value");
  return { notice, readFile };
}

describe("Pi credential presence, not online validation", () => {
  it("names absent credentials and their supported remedy without refusing launch", () => {
    const { notice, readFile } = check();
    expect(notice).toContain("No stored sign-in or provider key was found");
    expect(notice).toContain("OPENROUTER_API_KEY");
    expect(notice).toContain("recovery.provider_auth_env_allowlist");
    expect(notice).toContain("launch continues");
    expect(readFile.mock.calls.map(([file]) => path.basename(file))).toEqual(["auth.json", "models.json"]);
  });

  it.each([
    [{ "auth.json": { openrouter: { type: "api_key", key: "private-value" } } }, "stored provider key present"],
    [{ "auth.json": { openrouter: { type: "oauth", access: "private-value", refresh: "private-value", expires: 1 } } }, "stored sign-in present"],
    [{ "models.json": { providers: { openrouter: { apiKey: "private-value" } } } }, "model configuration has a provider key"],
  ] as const)("recognizes a declared local credential without publishing or refreshing it", (files, expected) => {
    const { notice } = check(files);
    expect(notice).toContain(expected);
    expect(notice).toContain("unverified");
    expect(notice).toContain("Launch continues");
  });

  it.each(["!private-command", "$PRIVATE_VALUE", "${PRIVATE_VALUE}", "prefix-${PRIVATE_VALUE}"])(
    "leaves dynamic credentials unknown without evaluating %s", key => {
      expect(check({ "auth.json": { openrouter: { type: "api_key", key } } }).notice).toContain("status unknown");
      expect(check({ "models.json": { providers: { openrouter: { apiKey: key } } } }).notice).toContain("status unknown");
    });

  it("uses the selected provider's actual child environment, not another provider's ambient key", () => {
    const env = buildPiChildEnv({ OPENROUTER_API_KEY: "private-value", ZAI_API_KEY: "private-value" },
      { agentDir, sessionsDir: "fixture", model: "zai/fixture" });
    expect(check({}, env).notice).toContain("No stored sign-in");
    expect(check({}, env, "zai/fixture").notice).toContain("provider key present in the managed environment");
    expect(check({ "auth.json": { zai: { type: "api_key", key: "private-value" } } }).notice).toContain("No stored sign-in");
  });

  it.each([undefined, "fixture", "private value/fixture", "__proto__/fixture"])("does not guess a saved/default model's credential", model => {
    const readFile = vi.fn(missing);
    expect(piCredentialNotice({ agentDir, model, env: {}, readFile })).toContain("status unknown");
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(["{", "null", "[]", '"private-value"', "x".repeat(1024 * 1024 + 1)])("unrecognized local metadata remains unknown (case %#)", text => {
    const notice = piCredentialNotice({ agentDir, model: "openrouter/fixture", env: { OPENROUTER_API_KEY: "private-value" }, readFile: () => text });
    expect(notice).toContain("status unknown");
    expect(notice).not.toContain("private-value");
  });

  it.each(["EACCES", "EIO", "ENOTDIR"])("read failures remain unknown and never expose diagnostics (%s)", code => {
    const notice = piCredentialNotice({ agentDir, model: "openrouter/fixture", env: {}, readFile: () => { throw Object.assign(new Error("private-value"), { code }); } });
    expect(notice).toContain("status unknown");
    expect(notice).not.toContain("private-value");
  });

  it("leaves unfamiliar auth schemas and custom providers unverified", () => {
    expect(check({ "auth.json": { openrouter: { type: "future", key: "private-value" } } }).notice).toContain("status unknown");
    expect(check({ "models.json": { providers: { local: { baseUrl: "http://localhost:1234" } } } }, {}, "local/fixture").notice).toContain("status unknown");
    expect(check({}, {}, "custom/fixture").notice).toContain("Pi may resolve another credential source");
  });
});

describe("Pi version observation", () => {
  it.each(["0.73.1", "pi 0.73.1", "v0.73.1"])("names an older tested-baseline version (%s) without a gate", output => {
    expect(piVersionNotice(output)).toContain("older than OpenRig's tested baseline 0.87.1");
    expect(piVersionNotice(output)).toContain("launch continues");
  });
  it.each(["0.87.1", "0.87.2", "1.0.0", "0.100.0", "0.87.1-dev"])("does not confuse a version response with authentication (%s)", output => {
    expect(piVersionNotice(output)).toContain("answered on the daemon's PATH");
    expect(piVersionNotice(output)).toContain("does not verify");
  });
  it.each(["", "private-value", "0.87.1\nprivate-value", "99999999999.1.2"])("does not echo arbitrary output (%s)", output => {
    expect(piVersionNotice(output)).toContain("version unknown");
    expect(piVersionNotice(output)).not.toContain("private-value");
  });
});
