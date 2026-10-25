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

function run(env: Record<string, string>, keys: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-example-")); dirs.push(dir);
  const fake = join(dir, "openclaw");
  const listing = JSON.stringify({ sessions: keys.map((key) => ({ agentId: "main", key })) });
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = sessions ]; then echo '${listing}'; exit 0; fi\necho "$@ STATE=$OPENCLAW_STATE_DIR" > "${dir}/started"\nprintf '%s\\0' "$@" > "${dir}/args"\n`);
  chmodSync(fake, 0o755);
  let failure: string | undefined;
  try {
    execFileSync(join(EXAMPLE, "openrig-openclaw-launch"), [], { env: { PATH: process.env["PATH"]!, OPENRIG_OPENCLAW: fake,
      OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", ...env }, timeout: 20_000, stdio: "pipe" });
  } catch (error) { failure = String((error as { stderr?: Buffer }).stderr); }
  const started = join(dir, "started");
  return { args: existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8").split("\0").slice(0, -1) : [], started: existsSync(started) ? readFileSync(started, "utf8").trim() : undefined, failure, state: join(dir, "home", "state", "openclaw", "node-1") };
}

describe("the documented OpenClaw launcher and preset", () => {
  it("starts a local chat on the session key OpenRig named, in the seat's own state folder", () => {
    const { started, state } = run({ OPENRIG_CONVERSATION: "openrig-dev-impl-1a2b3c4d" });
    expect(started).toBe(`chat --session openrig-dev-impl-1a2b3c4d STATE=${state}`);
  });

  it("passes a multiline first input through the native message option", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-first-")); dirs.push(dir);
    const file = join(dir, "first.txt"); const text = "identity\n'quoted' $literal\n";
    writeFileSync(file, text, { mode: 0o600 });
    expect(run({ OPENRIG_CONVERSATION: "named", OPENRIG_FIRST_INPUT: file }).args)
      .toEqual(["chat", "--session", "named", "--message", text]);
  });

  it.each([["bare", "openrig-dev-impl-1a2b3c4d"], ["agent-scoped", "agent:main:openrig-dev-impl-1a2b3c4d"]])(
    "reopens a named session its sessions list (%s key)", (_case, stored) => {
      expect(run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" }, [stored]).started).toMatch(/^chat --session openrig-dev-impl-1a2b3c4d STATE=/);
    });

  it("starts nothing on a resume whose key its sessions don't list, so a gone conversation isn't recreated", () => {
    const { started, failure } = run({ OPENRIG_RESUME_REF: "openrig-dev-impl-1a2b3c4d" }, ["agent:main:main"]);
    expect(started).toBeUndefined();
    expect(failure).toMatch(/don't list "openrig-dev-impl-1a2b3c4d"/);
  });

  it("is a preset this OpenRig loads, declaring names_conversation and not resume", () => {
    expect(loadCommunityHarnessPreset("openclaw", EXAMPLE)).toMatchObject({ ok: true, preset: { namesConversation: true, launchResult: false, resume: false } });
  });
});
