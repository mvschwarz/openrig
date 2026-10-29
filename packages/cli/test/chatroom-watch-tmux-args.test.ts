import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chatroomWatchTmuxArgs } from "../src/commands/chatroom.js";

const sessionArg = (rig: string) => { const args = chatroomWatchTmuxArgs(rig); return args[args.indexOf("-s") + 1]; };

describe("chatroom watch --tmux arguments", () => {
  it("hands tmux the watcher as separate arguments, with the rig name after --, and asks for the name it used", () => {
    expect(chatroomWatchTmuxArgs("my rig")).toEqual(["new-session", "-d", "-P", "-F", "#{session_name}", "-s", "chatroom@my rig",
      "rig", "chatroom", "watch", "--", "my rig"]);
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
    expect(sessionArg(rig)).toBe(session);
  });

  // tmux ends a command at an argument ending in `;` unless a `\` comes before it.
  it.each([
    ["a;", "chatroom@a\\;", "a\\;"],
    [";", "chatroom@\\;", "\\;"],
    ["a\\;", "chatroom@a\\\\;", "a\\\\;"],
    ["a;b", "chatroom@a;b", "a;b"],
  ])("puts a \\ before a final ; in %j", (rig, session, watcherArg) => {
    const args = chatroomWatchTmuxArgs(rig);
    expect(sessionArg(rig)).toBe(session);
    expect(args[args.length - 1]).toBe(watcherArg);
  });
});

const TMUX_SOCKET = `openrig-chatroom-test-${process.pid}`;
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
const names = ["my-rig", "my rig", "it's", 'say "hi"', "$(echo pwned)", "`id`", "a;b", "-rig",
  "a#b", "a##b", "a#{b}", "a#[fg=red]b", "a##[b", "a;", ";"];

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

  // The exact arguments, with only the `rig` program swapped for the recorder; tmux prints the session it made.
  function start(rig: string, out: string): string {
    const args = chatroomWatchTmuxArgs(rig);
    const program = args.indexOf("-s") + 2;
    return execFileSync("tmux", ["-L", TMUX_SOCKET, "-f", "/dev/null", ...args.slice(0, program), process.execPath, recorder, out,
      ...args.slice(program + 1)], { encoding: "utf8" }).trim();
  }

  it.each(names.map((rig, i) => [rig, i] as const))("keeps the session chatroom@%s and hands the watcher the name as one argument", async (rig, i) => {
    const out = path.join(dir, `argv-${i}.json`);
    expect(start(rig, out)).toBe(`chatroom@${rig}`);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["chatroom", "watch", "--", rig]), { timeout: 5000 });
  });

  // tmux versions differ in how they normalize dots and literal dollars in session names.
  // The reported name must address the real session, while the watcher still gets the original rig name.
  it.each([
    ["release-0.7", ["chatroom@release-0.7", "chatroom@release-0_7"]],
    ["a$HOME", ["chatroom@a$HOME", "chatroom@a\\$HOME"]],
  ] as const)("reports the name tmux used for %s", async (rig, expected) => {
    const out = path.join(dir, `argv-normalized-${rig}.json`);
    const reported = start(rig, out);
    expect(expected).toContain(reported);
    expect(execFileSync("tmux", ["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).split("\n"))
      .toContain(reported);
    expect(spawnSync("tmux", ["-L", TMUX_SOCKET, "has-session", "-t", `=${reported}:`]).status).toBe(0);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["chatroom", "watch", "--", rig]), { timeout: 5000 });
  });
});
