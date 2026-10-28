import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatroomWatchTmuxArgs } from "../src/commands/chatroom.js";

describe("chatroom watch --tmux arguments", () => {
  it("hands tmux the watcher as separate arguments, with the rig name after --", () => {
    expect(chatroomWatchTmuxArgs("my rig"))
      .toEqual(["new-session", "-d", "-s", "chatroom@my rig", "rig", "chatroom", "watch", "--", "my rig"]);
  });

  // tmux reads -s as a format: `##` is one `#`, and a run of `#` before `[` is a style it keeps as written.
  it.each([
    ["my-rig", "chatroom@my-rig"],
    ["a#b", "chatroom@a##b"],
    ["a##b", "chatroom@a####b"],
    ["a#", "chatroom@a##"],
    ["a#{b}", "chatroom@a##{b}"],
    ["a#[fg=red]b", "chatroom@a#[fg=red]b"],
    ["a##[b", "chatroom@a##[b"],
  ])("encodes %j for tmux's session-name format as %j", (rig, session) => {
    expect(chatroomWatchTmuxArgs(rig)[3]).toBe(session);
  });
});

const TMUX_SOCKET = `openrig-chatroom-test-${process.pid}`;
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
const names = ["my-rig", "my rig", "it's", 'say "hi"', "$(echo pwned)", "`id`", "a;b", "a$HOME", "-rig",
  "a#b", "a##b", "a#{b}", "a#[fg=red]b", "a##[b"];

describe.runIf(tmuxAvailable)("chatroom watch --tmux against a real tmux server (private socket)", () => {
  let dir = "";
  let recorder = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "openrig-chatroom-watch-"));
    // Stands in for `rig`: records the arguments the watcher gets, then stays up so the session lives.
    recorder = path.join(dir, "record.cjs");
    writeFileSync(recorder, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\nsetTimeout(() => {}, 30000);\n");
  });
  afterAll(() => {
    spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(names.map((rig, i) => [rig, i] as const))("keeps the session chatroom@%s and hands the watcher the name as one argument", async (rig, i) => {
    const out = path.join(dir, `argv-${i}.json`);
    const args = chatroomWatchTmuxArgs(rig);
    execFileSync("tmux", ["-L", TMUX_SOCKET, "-f", "/dev/null", ...args.slice(0, 4), process.execPath, recorder, out, ...args.slice(5)]);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["chatroom", "watch", "--", rig]), { timeout: 5000 });
    const sessions = execFileSync("tmux", ["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).split("\n");
    expect(sessions).toContain(`chatroom@${rig}`);
  });
});
