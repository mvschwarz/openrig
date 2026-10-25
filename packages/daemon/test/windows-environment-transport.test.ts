import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("psmux environment command transport", () => {
  it("creates the named native session directly, without tmux's empty-server source-file bootstrap", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("no shell transport"); }, undefined, async argv => {
      calls.push(argv);
      return argv[1] === "new-session" ? "%1\n" : "";
    }, "psmux");
    expect(await adapter.createSession("native-worker", "C:/work space", { EXAMPLE: "two words" })).toEqual({ ok: true });
    expect(calls[0]).toEqual(["tmux", "new-session", "-d", "-s", "native-worker", "-c", "C:/work space",
      "-e", "OPENRIG_TRANSCRIPTS_LINES=", "-e", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS=", "-e", "EXAMPLE=two words", "-P", "-F", "#{pane_id}"]);
    expect(calls.some(argv => argv.includes("source-file") || argv.includes("start-server"))).toBe(false);
  });
});
