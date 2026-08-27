import { describe, it, expect } from "vitest";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";

// In-memory FS fake — models append/write/read + a fixed clock, no real disk.
function memFs(): StateFsOps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync(p: string) {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p)!;
    },
    appendFileSync(p: string, d: string) {
      files.set(p, (files.get(p) ?? "") + d);
    },
    writeFileSync(p: string, d: string) {
      files.set(p, d);
    },
    rename(from: string, to: string) {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp() {
      /* no-op in memory */
    },
  };
}
const clock = () => new Date("2026-07-30T00:00:00.000Z");

describe("Slice-11 SeenStore — durable delivery-dedup (item 2)", () => {
  it("load() is empty when the file does not exist", () => {
    const fsx = memFs();
    expect(new SeenStore("/s/seen.jsonl", fsx, clock).load().size).toBe(0);
  });

  it("mark() then load() sees the id; SURVIVES a restart (fresh instance, same fs)", () => {
    const fsx = memFs();
    new SeenStore("/s/seen.jsonl", fsx, clock).mark("qitem-1", "posted");
    // fresh instance == process/daemon restart; reads the same durable file
    const reloaded = new SeenStore("/s/seen.jsonl", fsx, clock).load();
    expect(reloaded.has("qitem-1")).toBe(true);
    expect(reloaded.size).toBe(1);
  });

  it("dedups a repeated id in load() (byte-identical re-append collapses to one)", () => {
    const fsx = memFs();
    const s = new SeenStore("/s/seen.jsonl", fsx, clock);
    s.mark("qitem-1", "posted");
    s.mark("qitem-1", "posted"); // crash-window duplicate re-delivery, byte-identical
    expect(s.load().size).toBe(1);
    // both lines are byte-identical (same id, same fixed clock, same status)
    const lines = fsx.files.get("/s/seen.jsonl")!.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(lines[1]);
  });

  it("tolerates a torn final line (crash mid-append) without dropping good records", () => {
    const fsx = memFs();
    fsx.files.set("/s/seen.jsonl", JSON.stringify({ id: "ok", ts: "t", status: "posted" }) + "\n" + '{"id":"tor');
    expect(new SeenStore("/s/seen.jsonl", fsx, clock).load().has("ok")).toBe(true);
  });

  it("seed() marks ids as history without a side effect (item 9 backlog, zero replay-storm)", () => {
    const fsx = memFs();
    const s = new SeenStore("/s/seen.jsonl", fsx, clock);
    expect(s.seed(["a", "b", "c"])).toBe(3);
    const set = s.load();
    expect(set.has("a") && set.has("b") && set.has("c")).toBe(true);
    expect(fsx.files.get("/s/seen.jsonl")!.includes('"status":"seeded"')).toBe(true);
  });
});

describe("Slice-11 DeadLetterStore — inbound never-drop, interruption-safe (item 8, B2)", () => {
  it("append() persists an attempt-counted entry that survives restart", () => {
    const fsx = memFs();
    new DeadLetterStore("/s/dead.jsonl", fsx, clock).append({ ts: "1.1" }, 1);
    const all = new DeadLetterStore("/s/dead.jsonl", fsx, clock).readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.attempts).toBe(1);
    expect((all[0]!.ev as { ts: string }).ts).toBe("1.1");
  });

  it("B2: readAll() is NON-destructive — a crash after read but before replaceAll loses nothing", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "1.1" }, 1);
    const before = fsx.files.get("/s/dead.jsonl");
    const read = d.readAll(); // begin a retry pass…
    expect(read).toHaveLength(1);
    // …simulate a process interruption HERE (no replaceAll). The durable file is untouched:
    expect(fsx.files.get("/s/dead.jsonl")).toBe(before);
    // a fresh instance (restart) still recovers the entry — recoverableAfterInterruption = 1, not 0
    expect(new DeadLetterStore("/s/dead.jsonl", fsx, clock).readAll()).toHaveLength(1);
  });

  it("replaceAll() atomically leaves ONLY the still-failing set (temp-write + rename)", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "a" }, 1);
    d.append({ ts: "b" }, 1);
    const all = d.readAll();
    // pretend "a" landed, "b" still failing → keep only b with attempts+1
    d.replaceAll([{ ev: all[1]!.ev, at: all[1]!.at, attempts: all[1]!.attempts + 1 }]);
    const remaining = d.readAll();
    expect(remaining).toHaveLength(1);
    expect((remaining[0]!.ev as { ts: string }).ts).toBe("b");
    expect(remaining[0]!.attempts).toBe(2);
    expect(fsx.files.has("/s/dead.jsonl.tmp")).toBe(false); // temp renamed away, no litter
  });

  it("zero-drop across MANY failing retries (read → replaceAll with attempts+1)", () => {
    const fsx = memFs();
    const d = new DeadLetterStore<{ ts: string }>("/s/dead.jsonl", fsx, clock);
    d.append({ ts: "1.1" }, 1);
    for (let round = 0; round < 5; round++) {
      const entries = d.readAll();
      expect(entries).toHaveLength(1); // never lost
      d.replaceAll(entries.map((e) => ({ ev: e.ev, at: e.at, attempts: e.attempts + 1 })));
    }
    const final = d.readAll();
    expect(final).toHaveLength(1);
    expect(final[0]!.attempts).toBe(6); // 1 initial + 5 retries, attempt-counted
  });

  it("readAll()/replaceAll() on a missing file are safe (no crash)", () => {
    const d = new DeadLetterStore("/s/none.jsonl", memFs(), clock);
    expect(d.readAll()).toEqual([]);
    d.replaceAll([]); // no-op, no throw
    expect(d.readAll()).toEqual([]);
  });
});
