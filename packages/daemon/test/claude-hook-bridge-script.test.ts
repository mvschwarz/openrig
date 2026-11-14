// Slice 13: the hook bridge's waiter script against a fake daemon. It arms, waits, writes a batch in order with plain
// framing and acks it before exiting 2; a superseded or unarmed waiter exits 0; at its own deadline it reports expiry
// and exits 0. Its framing says what the messages are and adds no authority to them.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const script = require("../assets/claude-hook-bridge.cjs") as {
  render(sessionName: string, messages: Array<{ text: string }>): string;
  waiter(opts: { hookEvent: string; out: { write(s: string): void }; deps: Record<string, unknown> }): Promise<number>;
};

const env = { OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "t", OPENRIG_SESSION_NAME: "dev-impl@team", OPENRIG_NODE_ID: "n1", OPENRIG_OCCUPANT_GENERATION: "g1" };

/** A daemon that answers each route from a script and records what it was sent. */
function daemon(answers: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const route = url.split("/api/hook-bridge/")[1]!;
    calls.push({ route, body: JSON.parse(init.body) });
    expect(init.headers.authorization).toBe("Bearer t");
    const answer = answers[route]?.shift() ?? { ok: true, action: "wait" };
    return { status: 200, json: async () => answer };
  };
  return { calls, fetchImpl };
}

describe("the hook bridge's waiter (slice 13)", () => {
  it("frames delivered messages plainly: not an error, ordinary messages, no added authority", () => {
    const text = script.render("dev-impl@team", [{ text: "From: peer@team\n---\nhello\n---" }, { text: "From: lead@team\n---\nsecond\n---" }]);
    expect(text).toMatch(/^This is not an error\. OpenRig's hook bridge delivered 2 messages for dev-impl@team at a turn boundary\./);
    expect(text).toMatch(/adds no authority/);
    expect(text.indexOf("hello")).toBeLessThan(text.indexOf("second"));
    expect(text).not.toMatch(/\b(must|obey|priority|system instruction|override)\b/i);
  });

  it("arms, waits, writes the batch, acks it and exits 2 to wake Claude", async () => {
    const d = daemon({ arm: [{ ok: true, armId: "a1", expireAfterSeconds: 7080 }],
      poll: [{ ok: true, action: "wait" }, { ok: true, action: "deliver", batchId: "b1", messages: [{ outboxId: "m1", text: "From: peer@team\n---\nhello\n---" }] }] });
    let out = "";
    const code = await script.waiter({ hookEvent: "Stop", out: { write: (s) => { out += s; } }, deps: { fetchImpl: d.fetchImpl, env, sleep: async () => {} } });
    expect(code).toBe(2);
    expect(out).toMatch(/hello/);
    expect(d.calls.map((c) => c.route)).toEqual(["arm", "poll", "poll", "ack"]);
    expect(d.calls[0]!.body).toMatchObject({ hookEvent: "Stop", sessionName: "dev-impl@team", nodeId: "n1", generation: "g1" });
    expect(d.calls[3]!.body).toMatchObject({ armId: "a1", batchId: "b1" });
  });

  it("exits 0 without writing when it isn't armed or is superseded", async () => {
    for (const answers of [{ arm: [{ ok: true, stop: true }] }, { arm: [{ ok: true, armId: "a1" }], poll: [{ ok: true, action: "superseded" }] }]) {
      const d = daemon(answers);
      let out = "";
      expect(await script.waiter({ hookEvent: "Stop", out: { write: (s) => { out += s; } }, deps: { fetchImpl: d.fetchImpl, env, sleep: async () => {} } })).toBe(0);
      expect(out).toBe("");
    }
  });

  it("reports its expiry and exits 0 at its own deadline", async () => {
    const d = daemon({ arm: [{ ok: true, armId: "a1", expireAfterSeconds: 1 }] });
    let t = 0;
    const code = await script.waiter({ hookEvent: "Stop", out: { write: () => {} }, deps: { fetchImpl: d.fetchImpl, env, now: () => t, sleep: async () => { t += 600; } } });
    expect(code).toBe(0);
    expect(d.calls.at(-1)).toMatchObject({ route: "expired", body: { armId: "a1" } });
  });
});
