import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const session = "seat with spaces";
const pane = `psmux:${Buffer.from(session).toString("base64url")}:%7`;

describe("psmux first-target client routing", () => {
  it("delivers Enter to an inactive pane even when the client discards the later -t", async () => {
    const received = new Map([["%7", [] as string[]], ["%8", [] as string[]]]);
    const active = "%8";
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, undefined, async argv => {
      // Model the 3.4.0 send-keys client: its first -t selects the server
      // and target; the command's later -t is consumed, not forwarded.
      const target = argv[argv.indexOf("-t") + 1]!;
      expect(target.startsWith(`=${session}`)).toBe(true);
      const selected = target.match(/\.([%]\d+)$/)?.[1] ?? active;
      received.get(selected)!.push(argv.at(-1)!);
      return "";
    }, "psmux");
    expect(await adapter.sendKeys(pane, ["Enter"])).toEqual({ ok: true });
    expect(received.get("%7")).toEqual(["Enter"]);
    expect(received.get(active)).toEqual([]);
    expect(active).toBe("%8"); // no select-window workaround
  });

  it("uses the rewritten target on the shell transport too", async () => {
    const calls: string[] = [];
    const adapter = new TmuxAdapter(async text => { calls.push(text); return ""; }, undefined, undefined, "psmux");
    expect(await adapter.sendKeys(pane, ["Enter"])).toEqual({ ok: true });
    expect(calls[0]).toContain(`=${session}:.%7`);
    expect(calls[0]).not.toContain("psmux:");
  });
});
