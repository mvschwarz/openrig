import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const session = "seat with spaces";
const pane = `psmux:${Buffer.from(session).toString("base64url")}:%7`;

describe("psmux first-target client routing", () => {
  it("does not mistake a boolean server/session flag for a target operand", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, undefined, async argv => {
      calls.push([...argv]); return "";
    }, "psmux");
    await adapter.listPanes(pane, true);
    expect(await adapter.setNativeServerOption(pane, "exit-empty", "off")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.slice(0, 3)).toEqual(["tmux", "-t", `=${session}:.%7`]);
  });

  it.each(["owned-session", pane])("does not interpret option data as routing metadata for %s", async target => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell"); }, undefined, async argv => {
      calls.push([...argv]); return "";
    }, "psmux");
    expect(await adapter.setSessionOption(target, "@owned-note", pane)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at(-1)).toBe(pane);
    if (target === "owned-session") expect(calls[0]).toEqual(["tmux", "set-option", "-t", "=owned-session:", "@owned-note", pane]);
    else expect(calls[0]!.slice(0, 3)).toEqual(["tmux", "-t", `=${session}:.%7`]);
  });

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
