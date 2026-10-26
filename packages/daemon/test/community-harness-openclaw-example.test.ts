import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";

// The documented OpenClaw example, run against a stand-in `openclaw` (no OpenClaw, no model): `sessions --json` lists
// the keys in KEYS, and any other call records how it was started.
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/openclaw");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(env: Record<string, string>, keys: string[] = [], listingExit = 0, args: string[] = [], gatewayKey: string | null = keys[0] ?? null) {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-example-")); dirs.push(dir);
  const fake = join(dir, "openclaw");
  const listing = JSON.stringify({ sessions: keys.map((key) => ({ agentId: "main", key })) });
  const description = JSON.stringify({ session: gatewayKey ? { key: gatewayKey } : null });
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = sessions ]; then echo '${listing}'; exit ${listingExit}; fi\nif [ "$1" = gateway ]; then echo '${description}'; exit ${listingExit}; fi\necho "$@ STATE=$OPENCLAW_STATE_DIR" > "${dir}/started"\nprintf '%s\\0' "$@" > "${dir}/args"\n`);
  chmodSync(fake, 0o755);
  let failure: string | undefined;
  try {
    execFileSync(join(EXAMPLE, "openrig-openclaw-launch"), args, { env: { PATH: process.env["PATH"]!, OPENRIG_OPENCLAW: fake,
      OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", ...env }, timeout: 20_000, stdio: "pipe" });
  } catch (error) { failure = String((error as { stderr?: Buffer }).stderr); }
  const started = join(dir, "started");
  return { args: existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8").split("\0").slice(0, -1) : [], started: existsSync(started) ? readFileSync(started, "utf8").trim() : undefined, failure, state: join(dir, "home", "state", "openclaw", "node-1") };
}

describe("the documented OpenClaw launcher and preset", () => {
  it("starts a local chat on the session key OpenRig named, in the seat's own state folder", () => {
    const { started, state } = run({ OPENRIG_CONVERSATION: "openrig-dev-impl-1a2b3c4d" });
    expect(started).toBe(`tui --local --session agent:main:openrig-dev-impl-1a2b3c4d STATE=${state}`);
  });

  it.each([false, true])("passes exact multiline first input to the native message option (Gateway %s)", gateway => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-first-")); dirs.push(dir);
    const file = join(dir, "first.txt"); const text = "identity\n'quoted' $literal\n";
    writeFileSync(file, text, { mode: 0o600 });
    expect(run({ OPENRIG_CONVERSATION: "named", OPENRIG_FIRST_INPUT: file }, [], 0, gateway ? ["--gateway"] : []).args)
      .toEqual(["tui", ...(gateway ? [] : ["--local"]), "--session", "agent:main:named", "--message", text]);
  });

  it("starts nothing when the first-input file is unreadable", () => {
    const { started, failure } = run({ OPENRIG_CONVERSATION: "named", OPENRIG_FIRST_INPUT: "/missing/first-input" });
    expect(started).toBeUndefined();
    expect(failure).toBeDefined();
  });

  it("reopens the main agent's exact canonical session key", () => {
    expect(run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" }, ["agent:main:openrig-dev-impl-1a2b3c4d"]).started)
      .toMatch(/^tui --local --session agent:main:openrig-dev-impl-1a2b3c4d STATE=/);
  });

  it("starts nothing on a resume whose key its sessions don't list, so a gone conversation isn't recreated", () => {
    const { started, failure } = run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" }, ["agent:main:main"]);
    expect(started).toBeUndefined();
    expect(failure).toMatch(/don't list "agent:main:openrig-dev-impl-1a2b3c4d"/);
  });

  it("does not reopen another agent's conversation with the same suffix", () => {
    const { started } = run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" }, ["agent:other:openrig-dev-impl-1a2b3c4d"]);
    expect(started).toBeUndefined();
  });

  it("does not launch when the listing command fails after printing a matching row", () => {
    const { started, failure } = run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" }, ["agent:main:openrig-dev-impl-1a2b3c4d"], 1);
    expect(started).toBeUndefined();
    expect(failure).toMatch(/couldn't be listed/);
  });

  it("reopens a Gateway conversation through its Gateway lookup and runs a client without --local", () => {
    const { started, state } = run({ OPENRIG_RESUME_REF: "openrig-gw" }, [], 0, ["--gateway"], "agent:main:openrig-gw");
    expect(started).toBe(`tui --session agent:main:openrig-gw STATE=${state}`);
  });

  it("does not create a missing Gateway conversation even when the client has a local match", () => {
    const { started, failure } = run({ OPENRIG_RESUME_REF: "openrig-gw" }, ["agent:main:openrig-gw"], 0, ["--gateway"], null);
    expect(started).toBeUndefined();
    expect(failure).toMatch(/don't list "agent:main:openrig-gw"/);
  });

  it("is a preset this OpenRig loads, declaring named conversations and local resume", () => {
    expect(loadCommunityHarnessPreset("openclaw", EXAMPLE)).toMatchObject({ ok: true, preset: { namesConversation: true, launchResult: false, resume: true } });
    expect(loadCommunityHarnessPreset("openclaw-gateway", EXAMPLE)).toMatchObject({ ok: true, preset: {
      command: "openrig-openclaw-launch --gateway", namesConversation: true, resume: true,
    } });
  });
});
