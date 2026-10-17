import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chatroomWatchTmuxArgs } from "../src/commands/chatroom.js";

// tmux runs its last argument through `sh -c`. Swap the leading `rig` for a function that prints
// each argument on its own line to see exactly what the watcher would receive.
function argsSeenByWatcher(shellCommand: string): string[] {
  const probe = `f() { for a in "$@"; do printf '%s\\n' "$a"; done; }; ${shellCommand.replace(/^rig /, "f ")}`;
  return execFileSync("sh", ["-c", probe], { encoding: "utf-8" }).split("\n").slice(0, -1);
}

describe("chatroom watch --tmux command", () => {
  it("keeps a plain rig name as the session suffix and the watcher argument", () => {
    const args = chatroomWatchTmuxArgs("my-rig");
    expect(args.slice(0, 4)).toEqual(["new-session", "-d", "-s", "chatroom@my-rig"]);
    expect(argsSeenByWatcher(args[4]!)).toEqual(["chatroom", "watch", "my-rig"]);
  });

  it.each(["my rig", "it's", 'say "hi"', "$(touch /tmp/openrig-pwned)", "`id`", "a;b", "a$HOME"])(
    "delivers %j to the watcher as one literal argument",
    (rig) => {
      expect(argsSeenByWatcher(chatroomWatchTmuxArgs(rig)[4]!)).toEqual(["chatroom", "watch", rig]);
    },
  );
});
