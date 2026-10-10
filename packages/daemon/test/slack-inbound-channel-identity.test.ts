import { describe, expect, it } from "vitest";
import { handleEnvelope, InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { DeadLetterStore, SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => {
      const value = files.get(p);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    appendFileSync: (p, data) => files.set(p, (files.get(p) ?? "") + data),
    writeFileSync: (p, data) => files.set(p, data),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp: () => {},
  };
}

function makeRouter(failCalls: number[] = [], waitToCreate?: () => Promise<void>) {
  const fs = memFs();
  let calls = 0;
  const rows: { qitemId: string }[] = [];
  const router = new InboundRouter({
    queue: {
      createQitem: async (input: { qitemId: string }) => {
        calls++;
        if (failCalls.includes(calls)) throw new Error("queue unavailable");
        await waitToCreate?.();
        rows.push({ qitemId: input.qitemId });
        return input.qitemId;
      },
    },
    seen: new SeenStore("/seen.jsonl", fs),
    deadLetter: new DeadLetterStore<SlackEvent>("/dead.jsonl", fs),
    destination: "operator-agent@kernel",
    resolveSender: () => ({ admitted: true, source: "founder@external" }),
  } as never);
  return { router, rows, callCount: () => calls };
}

function event(channel: string): SlackEvent {
  return { type: "message", user: "U1", text: `from ${channel}`, ts: "1700000000.000001", channel };
}

function deliver(router: InboundRouter, ev: SlackEvent) {
  return handleEnvelope(
    { envelope_id: `env-${ev.channel}`, type: "events_api", payload: { event: ev } },
    () => {},
    router,
  );
}

describe("Slack inbound identity is channel-scoped", () => {
  it("does not treat another channel's in-flight event with the same ts as a duplicate", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { router, rows, callCount } = makeRouter([], () => blocked);

    const first = deliver(router, event("C1"));
    expect(callCount()).toBe(1);
    const second = deliver(router, event("C2"));
    expect(callCount()).toBe(2);
    release();

    expect((await first).status).toBe("accepted");
    expect((await second).status).toBe("accepted");
    expect(rows).toHaveLength(2);
  });

  it("lands distinct channels with the same message ts, while ignoring same-channel redelivery", async () => {
    const { router, rows } = makeRouter();

    expect((await deliver(router, event("C1"))).status).toBe("accepted");
    expect((await deliver(router, event("C2"))).status).toBe("accepted");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.qitemId).not.toBe(rows[1]!.qitemId);

    expect((await deliver(router, event("C1"))).status).toBe("ignored");
    expect(rows).toHaveLength(2);
  });

  it("does not discard a channel's dead-letter because another channel used the same ts", async () => {
    const { router, rows } = makeRouter([1]);

    expect((await deliver(router, event("C2"))).status).toBe("dead-lettered");
    expect((await deliver(router, event("C1"))).status).toBe("accepted");
    expect(await router.retryDeadLetters()).toEqual({ retried: 1, landed: 1 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.qitemId)).size).toBe(2);
  });
});
