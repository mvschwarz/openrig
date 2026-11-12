import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

it.each(["-t", "ordinary-client"])("routes the scoped destination independently of the client value (%s)", async client => {
  const calls: string[][] = [];
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell execution"); }, undefined,
    async argv => { calls.push(argv); return ""; }, ["-L", "owned-home"], "psmux");
  const scoped = `psmux:${Buffer.from("owned-session").toString("base64url")}:$2`;
  expect(await adapter.switchClient(client, scoped)).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 6)).toEqual(["tmux", "-L", "owned-home", "-t", "=owned-session", "switch-client"]);
  expect(calls[0]).not.toContain(scoped);
  expect(calls[0]).toContain("$2");
  expect(calls[0]![calls[0]!.indexOf("-c") + 1]).toBe(client);
});
