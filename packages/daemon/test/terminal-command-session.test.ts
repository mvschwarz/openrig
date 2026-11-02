import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.each(["tmux", "psmux"] as const)("retains ordinary format names and literal command argv on %s", async kind => {
  const calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined,
    async argv => { calls.push(argv); return "$3 123\n"; }, ["-L", "owned"], kind);
  expect(await adapter.createDetachedCommandSession("chatroom@a#b;", ["C:/owned tools/node.exe", "-e", "literal;"])).toBe("$3");
  expect(calls).toEqual([["tmux", "-L", "owned", "new-session", "-d", "-P", "-F", "#{session_id} #{session_created}", "-s", "chatroom@a##b\\;",
    ...(kind === "psmux" ? ["--"] : []), "C:/owned tools/node.exe", "-e", "literal\\;"]]);
});
it("retains an unconfirmed command session without retry or cleanup", async () => {
  const calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell"); }, undefined,
    async argv => { calls.push(argv); return "unconfirmed\n"; });
  await expect(adapter.createDetachedCommandSession("owned", ["node", "literal"])).rejects.toThrow("retained");
  expect(calls).toHaveLength(1); expect(calls[0]).not.toContain("kill-session");
});
