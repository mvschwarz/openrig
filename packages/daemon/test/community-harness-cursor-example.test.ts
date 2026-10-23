import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { newLaunchAttempt, readLaunchResult } from "../src/domain/community-harness-launch-result.js";

// The documented Cursor example, run against a stand-in `cursor-agent` (no Cursor, no model): its record is one OpenRig reads.
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/cursor");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Where Cursor keeps a chat's store: <config folder>/chats/<md5 of the physical working directory>/<chat id>/store.db.
function addChat(configDir: string, cwd: string, id: string) {
  const chat = join(configDir, "chats", createHash("md5").update(realpathSync(cwd)).digest("hex"), id);
  mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, "store.db"), "");
}

// `setup` prepares the seat's folder and returns the launch's extra variables.
function run(setup: (dir: string) => Record<string, string> = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), "cursor-example-")); dirs.push(dir);
  const fake = join(dir, "cursor-agent");
  // create-chat prints an id and keeps running, as Cursor's does; any other call records its arguments and exits.
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = create-chat ]; then echo chat-abc; exec sleep 30; fi\necho "$@ CFG=$CURSOR_CONFIG_DIR" > "${dir}/started"\n`);
  chmodSync(fake, 0o755);
  const env = setup(dir);
  const root = join(dir, "results");
  const attempt = newLaunchAttempt("dev-cursor@r", root);
  const exit = spawnSync(join(EXAMPLE, "openrig-cursor-launch"), [], { cwd: dir, env: { PATH: process.env["PATH"]!, OPENRIG_CURSOR_AGENT: fake,
    OPENRIG_HOME: join(dir, "home"), OPENRIG_NODE_ID: "node-1", OPENRIG_LAUNCH_RESULT: attempt.file, OPENRIG_LAUNCH_ATTEMPT: attempt.attempt, ...env },
    timeout: 20_000 }).status;
  const started = join(dir, "started");
  return { exit, read: readLaunchResult(attempt, "cursor", root), started: existsSync(started) ? readFileSync(started, "utf8") : null, dir };
}

describe("the documented Cursor launcher and preset", () => {
  it("reports the chat create-chat made, then reopens it in the seat's own Cursor config folder", () => {
    const { read, started, dir } = run();
    expect(read).toEqual({ ok: true, nativeRef: "chat-abc", producer: "openrig-cursor-launch 2" });
    expect(started?.trim()).toBe(`--resume chat-abc --trust CFG=${join(dir, "home", "state", "cursor", "node-1")}`);
  });

  it("reopens a chat Cursor holds in an already-set config folder, and reports that id", () => {
    const { read, started, dir } = run(dir => {
      addChat(join(dir, "own-config"), dir, "chat-777");
      return { CURSOR_CONFIG_DIR: join(dir, "own-config"), OPENRIG_RESUME_REF: "chat-777" };
    });
    expect(read).toMatchObject({ ok: true, nativeRef: "chat-777" });
    expect(started?.trim()).toBe(`--resume chat-777 --trust CFG=${join(dir, "own-config")}`);
  });

  it("reports a chat Cursor doesn't hold as missing, and starts nothing", () => {
    const { exit, read, started } = run(dir => {
      addChat(join(dir, "home", "state", "cursor", "node-1"), dir, "chat-other");
      return { OPENRIG_RESUME_REF: "chat-gone" };
    });
    expect(read).toMatchObject({ ok: false, missing: true });
    expect(started).toBeNull();
    expect(exit).not.toBe(0);
  });

  it("is a preset this OpenRig loads, declaring launch_result and resume", () => {
    expect(loadCommunityHarnessPreset("cursor", EXAMPLE)).toMatchObject({ ok: true, preset: { command: "openrig-cursor-launch", launchResult: true, resume: true } });
  });
});
