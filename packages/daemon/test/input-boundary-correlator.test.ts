// A harness's prompt hook is matched to the one message OpenRig wrote only when the match is unambiguous; anything else
// leaves the input boundary unknown.
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { InputBoundaryCorrelator, type BoundaryHook } from "../src/domain/input-boundary-correlator.js";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("InputBoundaryCorrelator", () => {
  let db: Database.Database;
  let bus: EventBus;
  let clock: number;
  let correlator: InputBoundaryCorrelator;

  beforeEach(() => {
    db = createFullTestDb();
    bus = new EventBus(db);
    clock = Date.parse("2026-11-11T03:00:00.000Z");
    correlator = new InputBoundaryCorrelator(bus, () => clock);
    bus.subscribe((event) => correlator.noteRecord(event));
  });

  const write = (over: Partial<{ messageId: string; generation: string | null; sha: string; bytes: number; writtenAt: string; written: string }> = {}) =>
    bus.emit({
      type: "transport.delivery_evidence", sessionName: "dev-impl@r", seatKind: "tmux", pane: "%1",
      occupantGeneration: over.generation === undefined ? "gen-1" : over.generation, messageId: over.messageId ?? "m1", attemptId: `a-${over.messageId ?? "m1"}`,
      admitted: "none", written: (over.written ?? "submitted") as "submitted", terminalObserved: { outcome: null, verified: null },
      inputBoundary: "unknown", source: "send_result", wireSha256: over.sha ?? SHA, wireBytes: over.bytes ?? 5,
      writtenAt: over.writtenAt ?? "2026-11-11T03:00:00.000Z",
    });
  const hook = (over: Partial<BoundaryHook> = {}) => correlator.noteHook({
    sessionName: "dev-impl@r", generation: "gen-1", sha256: SHA, bytes: 5, occurredAt: "2026-11-11T03:00:01.000Z",
    runtime: "claude-code", nativePromptId: "p-1", nativeTurnId: null, ...over,
  });
  const observed = () => (db.prepare("SELECT node_id, payload FROM events WHERE type = 'transport.input_boundary' ORDER BY seq").all() as Array<{ node_id: string | null; payload: string }>)
    .map((row) => ({ nodeId: row.node_id, ...JSON.parse(row.payload) }));

  it("records the boundary for the one write its hook matches, written first or second, with no node", () => {
    write({ messageId: "m1" });
    hook();
    hook({ occurredAt: "2026-11-11T03:00:03.000Z", nativePromptId: "p-2" });
    write({ messageId: "m2", writtenAt: "2026-11-11T03:00:02.000Z" });
    expect(observed()).toMatchObject([
      { nodeId: null, messageId: "m1", attemptId: "a-m1", occupantGeneration: "gen-1", observed: "UserPromptSubmit", runtime: "claude-code", nativePromptId: "p-1" },
      { nodeId: null, messageId: "m2", nativePromptId: "p-2" },
    ]);
  });

  it("leaves the boundary unknown for two candidates, another generation, no generation, another text or length, or a write after the hook", () => {
    write({ messageId: "m1" });
    write({ messageId: "m2" });
    hook();
    write({ messageId: "g", sha: OTHER, generation: "gen-2" });
    hook({ sha256: OTHER });
    write({ messageId: "n", sha: "c".repeat(64), generation: null });
    hook({ sha256: "c".repeat(64) });
    write({ messageId: "t", sha: "d".repeat(64) });
    hook({ sha256: "e".repeat(64) });
    write({ messageId: "l", sha: "f".repeat(64), bytes: 6 });
    hook({ sha256: "f".repeat(64) });
    write({ messageId: "late", sha: "1".repeat(64), writtenAt: "2026-11-11T03:00:05.000Z" });
    hook({ sha256: "1".repeat(64), occurredAt: "2026-11-11T03:00:04.000Z" });
    hook({ sha256: "3".repeat(64), occurredAt: "2026-11-11T03:00:04.000Z" });
    write({ messageId: "late-after-hook", sha: "3".repeat(64), writtenAt: "2026-11-11T03:00:05.000Z" });
    expect(observed()).toEqual([]);
  });

  it("matches a write once, never a write whose text didn't reach the input, and nothing older than the window", () => {
    write({ messageId: "m1" });
    hook();
    hook({ nativePromptId: "p-again" });
    write({ messageId: "u", sha: OTHER, written: "uncertain" });
    hook({ sha256: OTHER });
    write({ messageId: "old", sha: "2".repeat(64) });
    clock += 11 * 60_000;
    hook({ sha256: "2".repeat(64), occurredAt: "2026-11-11T03:11:00.000Z" });
    expect(observed().map((event) => event.messageId)).toEqual(["m1"]);
  });

  it("matches nothing after a restart: a new correlator holds none of the writes before it", () => {
    write({ messageId: "m1" });
    const restarted = new InputBoundaryCorrelator(bus, () => clock);
    restarted.noteHook({ sessionName: "dev-impl@r", generation: "gen-1", sha256: SHA, bytes: 5, occurredAt: "2026-11-11T03:00:01.000Z",
      runtime: "codex", nativePromptId: null, nativeTurnId: "t-1" });
    expect(observed()).toEqual([]);
  });
});
