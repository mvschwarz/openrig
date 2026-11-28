import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { readThreadIdAcrossHomes, type CodexHomeThreadReader } from "../src/domain/model-divergence/codex-thread-homes.js";

type Call = { kind: "resolve" | "legacy"; pid: number; identity?: string };

/** A home whose read runs synchronously, as a real one does (better-sqlite3), then settles at once. */
function home(events: string[], name: string, answer?: string | Error, blockMs = 0): CodexHomeThreadReader & { calls: Call[] } {
  const calls: Call[] = [];
  const read = (call: Call): Promise<string | undefined> => {
    const until = Date.now() + blockMs;
    while (Date.now() < until) { /* the home's synchronous read */ }
    events.push(`read ${name}`);
    calls.push(call);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return {
    calls,
    resolve: (pid: number, identity: string) => read({ kind: "resolve", pid, identity }),
    resolveUngatedLegacy: (pid: number) => read({ kind: "legacy", pid }),
  };
}

const homes = (events: string[], n: number, answerAt = -1, blockMs = 0) =>
  Array.from({ length: n }, (_, i) => home(events, `h${i}`, i === answerAt ? `thread-${i}` : undefined, blockMs));

/** setImmediate callbacks run only in a later event-loop iteration: a settled-promise await never reaches them. */
function countTurns(events: string[]): () => void {
  let stopped = false;
  const tick = () => { if (stopped) return; events.push("turn"); setImmediate(tick); };
  setImmediate(tick);
  return () => { stopped = true; };
}

const IDENTITY = "Fri Nov 27 18:18:00 2026";

describe("readThreadIdAcrossHomes: the first answering home, in order, with an event-loop turn between homes", () => {
  it("returns the first home that answers, in order, and reads no later home, even when a later one would answer too", async () => {
    const events: string[] = [];
    const [a, b, c] = [home(events, "a"), home(events, "b", "thread-b"), home(events, "c", "thread-c")];
    await expect(readThreadIdAcrossHomes([a, b, c], 42, IDENTITY)).resolves.toBe("thread-b");
    expect(events).toEqual(["read a", "read b"]);
    expect(c.calls).toEqual([]);
  });

  it("reads every home once, in order, and returns undefined when none answers", async () => {
    const events: string[] = [];
    await expect(readThreadIdAcrossHomes(homes(events, 3), 42, IDENTITY)).resolves.toBeUndefined();
    expect(events).toEqual(["read h0", "read h1", "read h2"]);
  });

  it("returns undefined with no homes and reads nothing", async () => {
    await expect(readThreadIdAcrossHomes([], 42, IDENTITY)).resolves.toBeUndefined();
  });

  it("passes the pid and identity to every home's gated read, and uses the ungated read only for an identity-less caller", async () => {
    const events: string[] = [];
    const gated = homes(events, 2);
    await readThreadIdAcrossHomes(gated, 42, IDENTITY);
    expect(gated.flatMap(h => h.calls)).toEqual([{ kind: "resolve", pid: 42, identity: IDENTITY }, { kind: "resolve", pid: 42, identity: IDENTITY }]);
    const legacy = homes(events, 2);
    await readThreadIdAcrossHomes(legacy, 42, undefined);
    expect(legacy.flatMap(h => h.calls)).toEqual([{ kind: "legacy", pid: 42 }, { kind: "legacy", pid: 42 }]);
  });

  it("a home whose read rejects ends the lookup with that rejection, and no later home is read", async () => {
    const events: string[] = [];
    const later = home(events, "c", "thread-c");
    await expect(readThreadIdAcrossHomes([home(events, "a"), home(events, "b", new Error("unreadable")), later], 42, IDENTITY))
      .rejects.toThrow("unreadable");
    expect(later.calls).toEqual([]);
  });

  it("takes an event-loop turn before each home after the first, and none before the first", async () => {
    const events: string[] = [];
    const stop = countTurns(events);
    await readThreadIdAcrossHomes(homes(events, 5), 42, IDENTITY);
    stop();
    const reads = events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith("read")).map(([, i]) => i);
    expect(reads).toHaveLength(5);
    expect(reads[0]).toBe(0);   // the first home reads at once
    for (let k = 1; k < reads.length; k++) expect(events.slice(reads[k - 1]! + 1, reads[k]!)).toContain("turn");
  });

  it("under a many-home late match, every home before the match is preceded by a turn and the answer is unchanged", async () => {
    const events: string[] = [];
    const stop = countTurns(events);
    await expect(readThreadIdAcrossHomes(homes(events, 30, 25), 42, IDENTITY)).resolves.toBe("thread-25");
    stop();
    const reads = events.filter(e => e.startsWith("read"));
    expect(reads).toHaveLength(26);
    let between = 0, gapsWithTurn = 0;
    for (const e of events.slice(events.indexOf("read h0") + 1)) {
      if (e === "turn") between++;
      else if (e.startsWith("read")) { if (between > 0) gapsWithTurn++; between = 0; }
    }
    expect(gapsWithTurn).toBe(25);
  });

  it("answers an HTTP request while a many-home scan with no match is under way, not after it", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const events: string[] = [];
      const scan = homes(events, 60, -1, 3);   // 60 homes of about 3 ms each, no match
      let answeredAfterReads = -1;
      const answered = new Promise<void>((resolve, reject) => {
        http.get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, (res) => {
          res.resume();
          res.on("end", () => { answeredAfterReads = events.filter(e => e.startsWith("read")).length; resolve(); });
        }).on("error", reject);
      });
      await expect(readThreadIdAcrossHomes(scan, 42, IDENTITY)).resolves.toBeUndefined();
      await answered;
      expect(events.filter(e => e.startsWith("read"))).toHaveLength(60);
      // Without a turn between homes the request could only be served after all 60 reads.
      expect(answeredAfterReads).toBeGreaterThan(0);
      expect(answeredAfterReads).toBeLessThan(60);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
