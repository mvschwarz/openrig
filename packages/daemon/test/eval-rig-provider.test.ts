// Test-A pre-drive (row 782b467a) — the SESSION-PERSISTENT RigSeatProvider mode:
// one seat/generation across baseline -> WALK -> GET -> post, completing R6's
// deferred live-provider leg behind the SAME EvalProvider seam (not a harness
// redesign). The live drive stays the non-author's; these pins prove the
// ORCHESTRATION: persistence, the input-echo contamination control, retirement,
// and the preserved not-wired refusal on the legacy path.

import { describe, it, expect, vi } from "vitest";
import { RigSeatProvider, type RigSeatSession } from "./helpers/eval-rig-provider.js";

function fakeSession(overrides?: Partial<RigSeatSession> & { paneEcho?: boolean }): { session: RigSeatSession; sent: string[]; retired: { count: number } } {
  const sent: string[] = [];
  const retired = { count: 0 };
  const session: RigSeatSession = {
    generation: "gen-A",
    sendPrompt: async (p) => { sent.push(p); },
    captureSince: async (p) => `${overrides?.paneEcho === false ? "" : `${p}\n`}seat output for: ${p.slice(0, 12)}`,
    retire: async () => { retired.count += 1; },
    ...overrides,
  };
  return { session, sent, retired };
}

describe("RigSeatProvider — session-persistent mode (Test-A)", () => {
  it("PERSISTENCE: four phases run against ONE spawned seat/generation", async () => {
    const { session, sent } = fakeSession();
    const spawn = vi.fn(async () => session);
    const provider = new RigSeatProvider({ packsRoot: "/packs", session: { spawn } });
    for (const phase of ["baseline probe", "WALK ack", "GET pull", "post probe"]) {
      const res = await provider.run(phase);
      expect(res.error).toBeUndefined();
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["baseline probe", "WALK ack", "GET pull", "post probe"]);
  });

  it("INPUT-ECHO NEGATIVE: the leading prompt echo is stripped — a grader pattern matching only the prompt text cannot pass", async () => {
    const { session } = fakeSession();
    const provider = new RigSeatProvider({ packsRoot: "/packs", session: { spawn: async () => session } });
    const res = await provider.run("magic-prompt-xyz nobody else says this");
    expect(res.transcript).not.toContain("magic-prompt-xyz nobody else says this\n");
    expect(res.transcript).toContain("seat output for: magic-prompt");
  });

  it("the echo strip removes only the LEADING echo — a genuine later quotation by the seat is kept", async () => {
    const session: RigSeatSession = {
      generation: "gen-A",
      sendPrompt: async () => {},
      captureSince: async (p) => `${p}\nI will now do exactly what "${p}" asked.`,
      retire: async () => {},
    };
    const provider = new RigSeatProvider({ packsRoot: "/packs", session: { spawn: async () => session } });
    const res = await provider.run("pull the lifecycle entry");
    expect(res.transcript.startsWith("pull the lifecycle entry")).toBe(false);
    expect(res.transcript).toContain('what "pull the lifecycle entry" asked');
  });

  it("RETIREMENT: dispose retires exactly once; run() after dispose refuses loud", async () => {
    const { session, retired } = fakeSession();
    const provider = new RigSeatProvider({ packsRoot: "/packs", session: { spawn: async () => session } });
    await provider.run("one");
    await provider.dispose();
    await provider.dispose(); // idempotent
    expect(retired.count).toBe(1);
    await expect(provider.run("two")).rejects.toThrow(/retired|disposed/i);
  });

  it("LEGACY PATH PRESERVED: without session deps, run() still throws the R6 not-wired refusal (no false green)", async () => {
    const provider = new RigSeatProvider({ packsRoot: "/packs" });
    await expect(provider.run("anything")).rejects.toThrow(/not yet driven|provider fake/i);
  });
});
