import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";

// The documented Hermes example, run against a stand-in `hermes` that records how it was started (no Hermes, no model).
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/hermes");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hermes-example-")); dirs.push(dir);
  const fake = join(dir, "hermes");
  writeFileSync(fake, `#!/bin/sh\necho "$@ HOME=$HERMES_HOME" > "${dir}/started"\n`);
  chmodSync(fake, 0o755);
  const launch = (extra: Record<string, string>) => execFileSync(join(EXAMPLE, "openrig-hermes-launch"), ["--provider", "openrouter"],
    { env: { PATH: process.env["PATH"]!, OPENRIG_HERMES: fake, OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", ...extra }, timeout: 20_000, stdio: "pipe" });
  launch(env);
  return { started: readFileSync(join(dir, "started"), "utf8").trim(), home: join(dir, "home", "state", "hermes", "node-1"), launch };
}

describe("the documented Hermes launcher and preset", () => {
  it("creates the session OpenRig named, in the seat's own Hermes home", () => {
    const { started, home } = run({ OPENRIG_CONVERSATION: "openrig-dev-impl-1a2b3c4d" });
    expect(started).toBe(`chat -c openrig-dev-impl-1a2b3c4d --create-if-missing --provider openrouter HOME=${home}`);
  });

  it("reopens the named session on a resume with none of the creation flags, which Hermes refuses there", () => {
    const { started, home } = run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" });
    expect(started).toBe(`chat -c openrig-dev-impl-1a2b3c4d HOME=${home}`);
  });

  it("starts nothing when OpenRig passed no name", () => {
    const { launch } = run({ OPENRIG_CONVERSATION: "x" });
    expect(() => launch({})).toThrow(/passed no conversation name/);
  });

  it("passes the seat's own OpenRig variables to Hermes's tools, and the launcher warns about a seat config that doesn't", () => {
    const config = parse(readFileSync(join(EXAMPLE, "config.yaml.example"), "utf8")) as { terminal?: { client_env_passthrough?: string[] } };
    const passed = config.terminal?.client_env_passthrough ?? [];
    expect(passed).toEqual(expect.arrayContaining(["OPENRIG_SESSION_NAME", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_HOME"]));
    for (const name of passed) expect(name).toMatch(/^OPENRIG_(?!.*(TOKEN|KEY|SECRET|PASSWORD))/); // the seat's own variables, none a secret
    const dir = mkdtempSync(join(tmpdir(), "hermes-example-")); dirs.push(dir);
    const fake = join(dir, "hermes");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755);
    const home = join(dir, "home", "state", "hermes", "node-1");
    const launch = () => spawnSync(join(EXAMPLE, "openrig-hermes-launch"), [], { encoding: "utf8", timeout: 20_000,
      env: { PATH: process.env["PATH"]!, OPENRIG_HERMES: fake, OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", OPENRIG_CONVERSATION: "openrig-x" } });
    expect(launch().stderr).toContain("doesn't pass OPENRIG_SESSION_NAME to Hermes's tools");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), readFileSync(join(EXAMPLE, "config.yaml.example")));
    expect(launch()).toMatchObject({ status: 0, stderr: "" });
  });

  it("writes the seat's model into its config for a new session only, and never over a model already set there", () => {
    const { home, launch } = run({ OPENRIG_CONVERSATION: "openrig-a", OPENRIG_MODEL: "openai/gpt-4o-mini" });
    const config = () => readFileSync(join(home, "config.yaml"), "utf8");
    expect(parse(config())).toMatchObject({ model: "openai/gpt-4o-mini" });
    launch({ OPENRIG_RESUME_REF: "openrig-a", OPENRIG_MODEL: "vendor/other" });
    launch({ OPENRIG_CONVERSATION: "openrig-b", OPENRIG_MODEL: "vendor/other" });
    expect(parse(config())).toMatchObject({ model: "openai/gpt-4o-mini" });
  });

  function launchOver(owned: string) {
    const dir = mkdtempSync(join(tmpdir(), "hermes-example-")); dirs.push(dir);
    const fake = join(dir, "hermes"); writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755);
    const home = join(dir, "home", "state", "hermes", "node-1"); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), owned);
    const { stderr } = spawnSync(join(EXAMPLE, "openrig-hermes-launch"), [], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env["PATH"]!,
      OPENRIG_HERMES: fake, OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", OPENRIG_CONVERSATION: "openrig-a", OPENRIG_MODEL: "vendor/other" } });
    return { config: readFileSync(join(home, "config.yaml"), "utf8"), stderr };
  }

  it("writes the model into a seat's empty config", () => {
    expect(parse(launchOver("").config)).toEqual({ model: "vendor/other" });
  });

  it.each([['agent:\n  max_turns: 1\nmodel: "owner/model"\n'], ['{"model": "owner/model"}\n'], ["agent:\n  max_turns: 1\n"]])(
    "leaves a seat's own config byte-for-byte unchanged and says the model wasn't applied (%j)", (owned) => {
      const { config, stderr } = launchOver(owned);
      expect(config).toBe(owned);
      expect(stderr).toContain("OPENRIG_MODEL was not applied; set the model there");
    });

  it("is a preset this OpenRig loads, declaring names_conversation and not resume, and doesn't yet take a model", () => {
    expect(loadCommunityHarnessPreset("hermes", EXAMPLE)).toMatchObject({ ok: true, preset: { namesConversation: true, launchResult: false, resume: false, passesModel: false } });
  });
});
