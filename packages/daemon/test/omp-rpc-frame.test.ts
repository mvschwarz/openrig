// #1275: OMP restore catch-up and the post-turn cursor refresh above one RPC frame. OMP v1 caps a stdout line
// at 1 MiB and fails a larger get_entries reply; the runner negotiates protocol v2 when OMP's ready frame
// advertises it, and reassembles rpc_chunk sequences with bounded memory and explicit failure.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OMP_MAX_REASSEMBLED_FRAME_BYTES, OmpFrameDecoder, ompProtocolV2Limit, type OmpFrameResult } from "../src/adapters/omp-rpc-frame.js";
import { MAX_UNANCHORED_REFRESH_HOLD_TURNS, prepareRunnerSidecar, RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const MiB = 1024 * 1024;
/** OMP v18.5.0's chunk payload size (rpc-frame.ts RPC_CHUNK_PAYLOAD_BYTES). */
const CHUNK_BYTES = 256 * 1024;
const READY_V2 = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: MiB, maxReassembledFrameBytes: 64 * MiB };

/** The rpc_chunk frames OMP v18.5.0 writes for one logical frame (encodeChunkedRpcFrames). */
function chunk(frame: unknown, chunkId = "rpc-1", payloadBytes = CHUNK_BYTES): Record<string, unknown>[] {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / payloadBytes);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk", chunkId, index, count, byteLength: bytes.byteLength,
    data: bytes.subarray(index * payloadBytes, (index + 1) * payloadBytes).toString("base64"),
  }));
}

/** append-order entries totalling about `bytes`. */
function history(bytes: number, prefix = "e"): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (let n = 1, size = 0; size < bytes; n++) {
    const entry = { type: "message", id: `${prefix}-${n}`, parentId: n > 1 ? `${prefix}-${n - 1}` : null, message: { role: "assistant", content: [{ type: "text", text: "é".repeat(2000) }] } };
    entries.push(entry);
    size += JSON.stringify(entry).length;
  }
  return entries;
}

const entriesReply = (id: string, entries: unknown[]) => ({ type: "response", id, command: "get_entries", success: true, data: { entries, leafId: null } });

function feed(decoder: OmpFrameDecoder, frames: Record<string, unknown>[]): OmpFrameResult[] {
  return frames.map((frame) => decoder.push(frame));
}

describe("OMP v2 frame decoder", () => {
  it("reassembles a multi-MiB reply losslessly: every entry, in order, once", () => {
    const entries = history(3 * MiB);
    const reply = entriesReply("pi-runner-catch-up", entries);
    const frames = chunk(reply);
    expect(frames.length).toBeGreaterThan(4);
    const results = feed(new OmpFrameDecoder(64 * MiB), frames);
    expect(results.slice(0, -1).every((result) => "pending" in result)).toBe(true);
    expect(results.at(-1)).toEqual({ frame: reply });
  });

  it("passes plain frames through, between and after sequences", () => {
    const decoder = new OmpFrameDecoder(64 * MiB);
    expect(decoder.push({ type: "agent_start" })).toEqual({ frame: { type: "agent_start" } });
    const reply = entriesReply("x", history(2 * MiB));
    expect(feed(decoder, chunk(reply)).at(-1)).toEqual({ frame: reply });
    expect(decoder.push({ type: "agent_end" })).toEqual({ frame: { type: "agent_end" } });
  });

  it("names a sequence still incomplete, for end of stream", () => {
    const decoder = new OmpFrameDecoder(64 * MiB);
    expect(decoder.incomplete()).toBeNull();
    const frames = chunk(entriesReply("x", history(2 * MiB)));
    decoder.push(frames[0]!);
    expect(decoder.incomplete()).toBe(`chunk sequence rpc-1 ended after 1 of ${frames.length} chunks`);
  });

  it("rejects an interrupted sequence once, keeps the interrupting frame, and skips the rest", () => {
    const decoder = new OmpFrameDecoder(64 * MiB);
    const [first, second, ...rest] = chunk(entriesReply("x", history(2 * MiB)));
    expect(decoder.push(first!)).toEqual({ pending: true });
    expect(decoder.push({ type: "notice", message: "hi" })).toEqual({ frame: { type: "notice", message: "hi" }, dropped: expect.stringContaining("interrupted") });
    expect(feed(decoder, [second!, ...rest]).every((result) => "skipped" in result)).toBe(true);
  });

  it("rejects interleaved sequences, both of them", () => {
    const decoder = new OmpFrameDecoder(64 * MiB);
    const a = chunk(entriesReply("a", history(2 * MiB)), "rpc-1");
    const b = chunk(entriesReply("b", history(2 * MiB)), "rpc-2");
    expect(decoder.push(a[0]!)).toEqual({ pending: true });
    expect(decoder.push(b[0]!)).toEqual({ dropped: "chunk sequence rpc-1 was interleaved with rpc-2" });
    expect(feed(decoder, [a[1]!, b[1]!]).every((result) => "skipped" in result)).toBe(true);
    // A later, whole sequence still decodes.
    const c = entriesReply("c", history(2 * MiB));
    expect(feed(decoder, chunk(c, "rpc-3")).at(-1)).toEqual({ frame: c });
  });

  it("enforces the reassembly limit from the declared length, before keeping any bytes", () => {
    const decoder = new OmpFrameDecoder(2 * MiB);
    const frames = chunk(entriesReply("x", history(3 * MiB)));
    expect(decoder.push(frames[0]!)).toEqual({ dropped: expect.stringContaining("above the 2097152-byte reassembly limit") });
    expect(feed(decoder, frames.slice(1)).every((result) => "skipped" in result)).toBe(true);
  });

  it("rejects malformed chunks explicitly", () => {
    const frames = chunk(entriesReply("x", history(2 * MiB)));
    const first = frames[0]!;
    const cases: Array<[string, Record<string, unknown>[]]> = [
      ["not starting at 0", [frames[1]!]],
      ["out of order", [first, frames[2]!]],
      ["changed count", [first, { ...frames[1]!, count: 99 }]],
      ["changed byteLength", [first, { ...frames[1]!, byteLength: (first.byteLength as number) + 1 }]],
      ["invalid base64", [first, { ...frames[1]!, data: "!!!!" }]],
      ["non-canonical base64", [{ ...first, data: "QR==" }]],
      ["empty data", [{ ...first, data: "" }]],
      ["missing chunkId", [{ ...first, chunkId: "" }]],
      ["fractional index", [{ ...first, index: 0.5 }]],
      ["count of one", [{ ...first, count: 1 }]],
    ];
    for (const [name, sequence] of cases) {
      const results = feed(new OmpFrameDecoder(64 * MiB), sequence);
      expect(results.at(-1), name).toEqual({ dropped: expect.any(String) });
    }
  });

  it("rejects a sequence whose bytes don't match its declared length, or aren't one UTF-8 JSON object", () => {
    const encode = (bytes: Buffer, declared = bytes.byteLength) => {
      const half = Math.ceil(bytes.byteLength / 2);
      return [bytes.subarray(0, half), bytes.subarray(half)].map((part, index) => ({
        type: "rpc_chunk", chunkId: "rpc-9", index, count: 2, byteLength: declared, data: part.toString("base64"),
      }));
    };
    const json = Buffer.from(JSON.stringify({ type: "response", pad: "x".repeat(100) }));
    expect(feed(new OmpFrameDecoder(64 * MiB), encode(json, json.byteLength + 10)).at(-1)).toEqual({ dropped: expect.stringContaining("shorter") });
    expect(feed(new OmpFrameDecoder(64 * MiB), encode(json, json.byteLength - 10)).at(-1)).toEqual({ dropped: expect.stringContaining("exceeds its declared length") });
    expect(feed(new OmpFrameDecoder(64 * MiB), encode(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).at(-1)).toEqual({ dropped: expect.stringContaining("UTF-8 JSON") });
    expect(feed(new OmpFrameDecoder(64 * MiB), encode(Buffer.from("[1,2,3]"))).at(-1)).toEqual({ dropped: expect.stringContaining("one JSON object") });
  });

  it("bounds the chunk count at OMP's own 256 (round 1, L1)", () => {
    // 2,041 one-byte chunks under a 4,096-byte limit: refused on the first chunk, nothing kept.
    const tiny = { type: "rpc_chunk", chunkId: "rpc-5", index: 0, count: 2041, byteLength: 2041, data: Buffer.from("{").toString("base64") };
    expect(new OmpFrameDecoder(4096).push(tiny)).toEqual({ dropped: expect.stringContaining("invalid metadata") });
    expect(new OmpFrameDecoder(64 * MiB).push({ ...tiny, count: 257, byteLength: 64 * MiB })).toEqual({ dropped: expect.stringContaining("invalid metadata") });
    // What OMP sends at its 64 MiB ceiling, 256 chunks of 256 KiB, is still accepted.
    expect(new OmpFrameDecoder(64 * MiB).push({ ...tiny, count: 256, byteLength: 64 * MiB })).toEqual({ pending: true });
  });

  it("reports a sequence without a usable chunkId once (round 1, LOW-1)", () => {
    const decoder = new OmpFrameDecoder(64 * MiB);
    const [first, second, third] = chunk(entriesReply("x", history(2 * MiB)));
    expect(decoder.push({ ...first!, chunkId: 7 })).toEqual({ dropped: "a chunk with invalid metadata" });
    expect(decoder.push({ ...second!, chunkId: 7 })).toEqual({ skipped: true });
    expect(decoder.push({ ...third!, chunkId: 7 })).toEqual({ skipped: true });
    // A later, whole sequence still decodes.
    const c = entriesReply("c", history(2 * MiB));
    expect(feed(decoder, chunk(c, "rpc-3")).at(-1)).toEqual({ frame: c });
  });

  it("ends the skipping of a rejected sequence at the next plain frame (round 2, R1-L1)", () => {
    const decoder = new OmpFrameDecoder(64 * MiB);
    const frames = chunk(entriesReply("x", history(2 * MiB)));
    const bad = frames.slice(0, 3).map((frame) => ({ ...frame, chunkId: 7 }));
    // Three malformed chunks, a plain frame, three more: one error per group, not one per chunk and not silence.
    const results = feed(decoder, [...bad, { type: "notice", message: "between" }, ...bad]);
    expect(results.filter((result) => "dropped" in result)).toHaveLength(2);
    // A sequence that reuses a rejected id after a plain frame decodes.
    const d2 = new OmpFrameDecoder(64 * MiB);
    feed(d2, [{ ...frames[0]!, data: "!!!!" }]);
    expect(d2.push({ type: "notice" })).toEqual({ frame: { type: "notice" } });
    const again = entriesReply("again", history(2 * MiB));
    expect(feed(d2, chunk(again, "rpc-1")).at(-1)).toEqual({ frame: again });
  });

  it("negotiates only when ready advertises v2, never above OMP's documented 64 MiB", () => {
    expect(ompProtocolV2Limit(READY_V2)).toBe(64 * MiB);
    expect(ompProtocolV2Limit({ ...READY_V2, maxReassembledFrameBytes: 8 * MiB })).toBe(8 * MiB);
    expect(ompProtocolV2Limit({ ...READY_V2, maxReassembledFrameBytes: 1024 * MiB })).toBe(OMP_MAX_REASSEMBLED_FRAME_BYTES);
    expect(ompProtocolV2Limit({ ...READY_V2, maxReassembledFrameBytes: undefined })).toBe(OMP_MAX_REASSEMBLED_FRAME_BYTES);
    expect(ompProtocolV2Limit({ type: "ready" })).toBeNull();
    expect(ompProtocolV2Limit({ type: "ready", supportedProtocolVersions: [1] })).toBeNull();
  });
});

function ompRunner(opts: { catchUpSince?: string; runtime?: "omp" | "pi"; readLastEntryId?: (path: string) => string | null } = {}) {
  const rpc: Record<string, unknown>[] = [];
  const mirror: string[] = [];
  const sidecars: PiRunnerState[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => { rpc.push(cmd); },
    mirrorLine: (line) => { mirror.push(line); },
    mirrorAppend: () => {},
    postActivity: () => {},
    writeSidecar: (state) => { sidecars.push(state); },
    sessionFileExists: () => true,
    ...(opts.readLastEntryId ? { readLastEntryId: opts.readLastEntryId } : {}),
    now: () => "2026-10-14T12:00:00Z",
  };
  const core = new RunnerCore(io, { sessionName: "omp-worker@rig", launchId: "attempt-1" }, { runtime: opts.runtime ?? "omp", catchUpSince: opts.catchUpSince });
  const line = (frame: unknown) => core.handlePiLine(JSON.stringify(frame));
  const cursor = () => sidecars.at(-1)?.lastEntryId;
  return { core, rpc, mirror, sidecars, line, cursor };
}

describe("OMP runner over protocol v2 (#1275)", () => {
  const negotiated = (catchUpSince = "e-1") => {
    const r = ompRunner({ catchUpSince });
    r.core.start(READY_V2);
    r.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    r.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/s.jsonl", sessionId: "s" } });
    return r;
  };

  it("negotiates before get_state and the catch-up, when advertised", () => {
    const { core, rpc } = ompRunner({ catchUpSince: "e-1" });
    core.start(READY_V2);
    expect(rpc).toEqual([
      { type: "negotiate_protocol", protocolVersion: 2, id: "omp-runner-negotiate" },
      { type: "get_state", id: "pi-runner-get-state" },
      { type: "get_entries", since: "e-1", id: "pi-runner-catch-up" },
    ]);
  });

  it("restore catch-up above 1 MiB advances the durable cursor to the last entry, then the post-turn refresh moves it on", () => {
    const { line, cursor, mirror, rpc } = negotiated();
    const restored = history(3 * MiB).slice(1);
    for (const frame of chunk(entriesReply("pi-runner-catch-up", restored))) line(frame);
    expect(cursor()).toBe(restored.at(-1)!.id);
    line({ type: "agent_end", isTerminal: true });
    expect(rpc.at(-1)).toEqual({ type: "get_entries", since: restored.at(-1)!.id, id: "pi-runner-cursor-refresh" });
    const delta = [{ type: "message", id: "turn-1", parentId: restored.at(-1)!.id }];
    line(entriesReply("pi-runner-cursor-refresh", delta));
    expect(cursor()).toBe("turn-1");
    expect(mirror.filter((l) => l.includes("ERROR"))).toEqual([]);
  });

  it("a dropped chunked reply is a failure noticed: the cursor isn't advanced past it, and the next refresh recovers", () => {
    const { line, cursor, mirror } = negotiated();
    const restored = history(2 * MiB).slice(1);
    const frames = chunk(entriesReply("pi-runner-catch-up", restored));
    line(frames[0]);
    line({ ...frames[1]!, data: "!!!!" });
    for (const frame of frames.slice(2)) line(frame);
    expect(mirror.filter((l) => l.startsWith("[omp-runner] ERROR rpc frame:"))).toEqual([
      "[omp-runner] ERROR rpc frame: chunk sequence rpc-1 has invalid chunk data; the chunked frame was dropped",
    ]);
    expect(cursor()).toBe("e-1");
    line({ type: "agent_end", isTerminal: true });
    for (const frame of chunk(entriesReply("pi-runner-cursor-refresh", history(2 * MiB)), "rpc-2")) line(frame);
    expect(cursor()).toBe(restored.at(-1)!.id);
  });

  it("a sequence cut off by OMP's exit is reported, and the cursor stays where it was", () => {
    const { core, line, cursor, mirror } = negotiated();
    const frames = chunk(entriesReply("pi-runner-catch-up", history(2 * MiB).slice(1)));
    for (const frame of frames.slice(0, 3)) line(frame);
    core.handlePiExit(1);
    expect(mirror).toContain(`[omp-runner] ERROR rpc frame: chunk sequence rpc-1 ended after 3 of ${frames.length} chunks; the chunked frame was dropped`);
    expect(cursor()).toBe("e-1");
  });

  it("a stdout line over OMP's 1 MiB frame is refused before parsing, and the cursor stays (round 1, F1)", () => {
    const reply = entriesReply("pi-runner-catch-up", history(2 * MiB).slice(1));
    const compliant = chunk(reply);
    // review-r2's two shapes, each an otherwise consistent sequence: chunk lines carrying exactly 1,048,576 base64 characters
    // (786,432-byte payloads), and a compliant sequence with one chunk padded by an ignored field.
    const exact = chunk(reply, "rpc-1", 786_432);
    const padded = compliant.map((frame, index) => index === 1 ? { ...frame, pad: "x".repeat(1_048_600) } : frame);
    for (const frames of [exact, padded]) {
      const { line, cursor, mirror } = negotiated();
      const oversized = frames[frames === exact ? 0 : 1]!;
      expect((oversized.data as string).length).toBeLessThanOrEqual(1024 * 1024);
      const raw = JSON.stringify(oversized);
      expect(Buffer.byteLength(raw) + 1).toBeGreaterThan(1024 * 1024);
      for (const frame of frames) line(frame);
      const errors = mirror.filter((l) => l.startsWith("[omp-runner] ERROR rpc frame:"));
      expect(errors).toEqual([expect.stringContaining(`a ${Buffer.byteLength(raw) + 1}-byte line exceeds OMP's 1048576-byte frame limit`)]);
      expect(cursor()).toBe("e-1");
      // Recovery: the next whole reply moves the cursor.
      line({ type: "agent_end", isTerminal: true });
      for (const frame of chunk(entriesReply("pi-runner-cursor-refresh", history(2 * MiB)), "rpc-2")) line(frame);
      expect(cursor()).toBe(history(2 * MiB).at(-1)!.id);
    }
  });

  it("a null, array or non-JSON line interrupts a pending sequence explicitly (round 1, F2)", () => {
    const frames = chunk(entriesReply("pi-runner-catch-up", history(2 * MiB).slice(1)));
    for (const [between, kind] of [["null", "null"], ["[]", "array"], ["not json at all", "non-JSON"]] as const) {
      const { core, line, cursor, mirror } = negotiated();
      line(frames[0]);
      core.handlePiLine(between);
      for (const frame of frames.slice(1)) line(frame);
      expect(mirror.filter((l) => l.startsWith("[omp-runner] ERROR rpc frame:")), kind).toEqual([
        `[omp-runner] ERROR rpc frame: chunk sequence rpc-1 was interrupted by a ${kind} line; the chunked frame was dropped`,
      ]);
      expect(cursor(), kind).toBe("e-1");
      // main's handling of the line itself is kept: noise is mirrored, null and arrays are not.
      expect(mirror.includes(between), kind).toBe(kind === "non-JSON");
      line({ type: "agent_end", isTerminal: true });
      for (const frame of chunk(entriesReply("pi-runner-cursor-refresh", history(2 * MiB)), "rpc-2")) line(frame);
      expect(cursor(), kind).toBe(history(2 * MiB).at(-1)!.id);
    }
  });

  it("a blank or whitespace line interrupts a pending sequence explicitly, and is ignored otherwise (round 2, R1-F1)", () => {
    const frames = chunk(entriesReply("pi-runner-catch-up", history(2 * MiB).slice(1)));
    for (const blank of ["", "   \t "]) {
      const { core, line, cursor, mirror } = negotiated();
      const mark = mirror.length;
      core.handlePiLine(blank); // nothing pending: ignored, as on main
      expect(mirror.slice(mark)).toEqual([]);
      line(frames[0]);
      core.handlePiLine(blank);
      for (const frame of frames.slice(1)) line(frame);
      expect(mirror.slice(mark)).toEqual([
        "[omp-runner] ERROR rpc frame: chunk sequence rpc-1 was interrupted by a blank line; the chunked frame was dropped",
      ]);
      expect(cursor()).toBe("e-1");
      line({ type: "agent_end", isTerminal: true });
      for (const frame of chunk(entriesReply("pi-runner-cursor-refresh", history(2 * MiB)), "rpc-2")) line(frame);
      expect(cursor()).toBe(history(2 * MiB).at(-1)!.id);
    }
  });

  it("an OMP reply over the reassembly limit stays an explicit error with the cursor in place", () => {
    const { line, cursor, mirror } = negotiated();
    line({ type: "response", id: "pi-runner-catch-up", command: "get_entries", success: false, error: "RPC response exceeded the transport limit" });
    expect(mirror).toContain("[omp-runner] ERROR rpc: RPC response exceeded the transport limit");
    expect(cursor()).toBe("e-1");
  });

  it("chunked events reach the event path too: a large agent_end still triggers the cursor refresh", () => {
    const { line, mirror, rpc } = negotiated();
    const text = "word ".repeat(300_000);
    for (const frame of chunk({ type: "agent_end", isTerminal: true, messages: [{ role: "assistant", content: [{ type: "text", text }] }] })) line(frame);
    expect(rpc.at(-1)).toEqual({ type: "get_entries", since: "e-1", id: "pi-runner-cursor-refresh" });
    expect(mirror.some((l) => l.includes("ERROR"))).toBe(false);
  });

  it("without the advertisement it stays on v1, unchanged: no negotiation, chunks aren't decoded", () => {
    const { core, rpc, line, mirror, cursor } = ompRunner({ catchUpSince: "e-1" });
    core.start({ type: "ready" });
    expect(rpc).toEqual([{ type: "get_state", id: "pi-runner-get-state" }, { type: "get_entries", since: "e-1", id: "pi-runner-catch-up" }]);
    line({ type: "response", id: "pi-runner-catch-up", command: "get_entries", success: false, error: "RPC response exceeded the transport limit" });
    expect(mirror).toContain("[omp-runner] ERROR rpc: RPC response exceeded the transport limit");
    expect(cursor()).toBeUndefined();
  });

  it("a refused negotiation says so and stays on v1", () => {
    const { core, line, mirror } = ompRunner();
    core.start(READY_V2);
    line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: false, error: "Unsupported RPC protocol version: 2" });
    expect(mirror).toEqual(["[omp-runner] RPC protocol v2 not negotiated (Unsupported RPC protocol version: 2); replies over 1 MiB will fail"]);
    const frames = chunk(entriesReply("pi-runner-catch-up", history(2 * MiB)));
    line(frames[0]);
    expect(mirror.at(-1)).not.toContain("ERROR rpc frame");
  });

  it("Pi never negotiates", () => {
    const { core, rpc } = ompRunner({ runtime: "pi", catchUpSince: "e-1" });
    core.start(READY_V2);
    expect(rpc).toEqual([{ type: "get_state", id: "pi-runner-get-state" }, { type: "get_entries", since: "e-1", id: "pi-runner-catch-up" }]);
  });

  it.each(["rpc_error", "reassembly_drop"] as const)(
    "oversized restore catch-up reports lost replay once, then bounded refresh advances cursor and restart resumes from it (%s)",
    (failureKind) => {
      let tailId: string | null = "e-1";
      const r = ompRunner({ catchUpSince: "e-1", readLastEntryId: () => tailId });
      r.core.start(READY_V2);
      r.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
      r.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/s.jsonl", sessionId: "s" } });

      if (failureKind === "rpc_error") {
        r.line({ type: "response", id: "pi-runner-catch-up", command: "get_entries", success: false, error: "RPC response exceeded the transport limit" });
      } else {
        r.line({ type: "rpc_chunk", chunkId: "rpc-big", index: 0, count: 256, byteLength: 65 * MiB, data: Buffer.from("x").toString("base64") });
      }
      const initialErrors = r.mirror.filter((l) => l.includes("ERROR"));
      const initialReplayNotices = r.mirror.filter((l) => /startup restore replay/i.test(l));
      expect(initialErrors).toHaveLength(1);
      expect(initialReplayNotices).toHaveLength(1);
      if (failureKind === "rpc_error") {
        expect(initialErrors[0]).toBe("[omp-runner] ERROR rpc: RPC response exceeded the transport limit");
        expect(initialReplayNotices[0]).toMatch(/startup restore replay was lost/i);
      } else {
        expect(initialReplayNotices[0]).toMatch(/startup restore replay.*may have been lost/i);
      }
      expect(r.cursor()).toBe("e-1");

      // While the local tail is still the oversized saved cursor, a turn end does not repeat since="e-1" or issue a full read.
      const rpcCountAfterFailure = r.rpc.length;
      r.line({ type: "agent_end", isTerminal: true });
      expect(r.rpc).toHaveLength(rpcCountAfterFailure);

      // Once a turn appends a new entry to the local session file, turn-end refresh queries boundedly from that tail
      // and advances the saved cursor without claiming the earlier lost replay was recovered.
      tailId = "e-50";
      r.line({ type: "agent_end", isTerminal: true });
      expect(r.rpc.at(-1)).toEqual({ type: "get_entries", since: "e-50", id: "pi-runner-cursor-refresh" });
      r.line({ type: "response", id: "pi-runner-cursor-refresh", command: "get_entries", success: true, data: { entries: [] } });
      expect(r.cursor()).toBe("e-50");
      expect(r.mirror.filter((l) => l.includes("ERROR"))).toEqual(initialErrors);
      expect(r.mirror.filter((l) => /startup restore replay/i.test(l))).toEqual(initialReplayNotices);
      expect(r.mirror.some((l) => /recovered/i.test(l))).toBe(false);

      // Next restart reads the persisted sidecar and begins catch-up from the advanced saved cursor.
      const files: Record<string, string> = { "/state/runner-state.json": JSON.stringify(r.sidecars.at(-1)) };
      const { catchUpSince } = prepareRunnerSidecar(
        {
          exists: (p) => p in files,
          readFile: (p) => files[p]!,
          writeFile: (p, data) => { files[p] = data; },
        },
        "/state/runner-state.json",
        "attempt-2",
        true,
        () => "2026-10-14T12:05:00Z",
      );
      expect(catchUpSince).toBe("e-50");
      const restarted = ompRunner({ catchUpSince });
      restarted.core.start(READY_V2);
      expect(restarted.rpc).toContainEqual({ type: "get_entries", since: "e-50", id: "pi-runner-catch-up" });
    },
  );

  it("an unrelated dropped chunked frame does not clear a good pending turn-end refresh", () => {
    const { line, cursor, mirror, rpc } = negotiated();
    line(entriesReply("pi-runner-catch-up", [{ type: "message", id: "e-2" }]));
    expect(cursor()).toBe("e-2");

    line({ type: "agent_end", isTerminal: true });
    expect(rpc.at(-1)).toEqual({ type: "get_entries", since: "e-2", id: "pi-runner-cursor-refresh" });

    // An unrelated corrupted chunked frame drops while the refresh is still pending.
    line({ type: "rpc_chunk", chunkId: "rpc-unrelated", index: 0, count: 2, byteLength: 4, data: "!!!!" });
    expect(mirror.filter((l) => l.startsWith("[omp-runner] ERROR rpc frame:"))).toHaveLength(1);

    // The pending refresh reply arrives next and still advances the durable cursor.
    line(entriesReply("pi-runner-cursor-refresh", [{ type: "message", id: "e-3" }]));
    expect(cursor()).toBe("e-3");
  });

  it("an unrelated oversized dropped frame does not suppress a usable refresh when the real request returns a temporary error", () => {
    // Subcase 1: unanchored refresh with no saved cursor and no readable file tail.
    const unanchored = ompRunner({ readLastEntryId: () => null });
    unanchored.core.start(READY_V2);
    unanchored.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    unanchored.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/s.jsonl", sessionId: "s" } });

    unanchored.line({ type: "agent_end", isTerminal: true });
    expect(unanchored.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });

    // An unrelated oversized v2 frame drops while the unanchored refresh is still pending.
    unanchored.line({ type: "rpc_chunk", chunkId: "rpc-unrelated-big", index: 0, count: 256, byteLength: 65 * MiB, data: Buffer.from("x").toString("base64") });
    // The real unanchored refresh returns a temporary non-size error (proving the dropped frame was unrelated).
    unanchored.line({ type: "response", id: "pi-runner-cursor-refresh", command: "get_entries", success: false, error: "temporarily busy" });

    // Later turns must still be able to dispatch an unanchored refresh and advance the cursor.
    unanchored.line({ type: "agent_end", isTerminal: true });
    expect(unanchored.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh:2" });
    unanchored.line(entriesReply("pi-runner-cursor-refresh:2", [{ type: "message", id: "e-ok-1" }]));
    expect(unanchored.cursor()).toBe("e-ok-1");

    // Subcase 2: anchored `since` refresh with an unrelated oversized drop followed by a temporary non-size error.
    const anchored = ompRunner({ catchUpSince: "e-10", readLastEntryId: () => null });
    anchored.core.start(READY_V2);
    anchored.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    anchored.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/s.jsonl", sessionId: "s" } });
    anchored.line(entriesReply("pi-runner-catch-up", []));

    anchored.line({ type: "agent_end", isTerminal: true });
    expect(anchored.rpc.at(-1)).toEqual({ type: "get_entries", since: "e-10", id: "pi-runner-cursor-refresh" });
    anchored.line({ type: "rpc_chunk", chunkId: "rpc-unrelated-big-2", index: 0, count: 256, byteLength: 65 * MiB, data: Buffer.from("x").toString("base64") });
    anchored.line({ type: "response", id: "pi-runner-cursor-refresh", command: "get_entries", success: false, error: "temporarily busy" });

    anchored.line({ type: "agent_end", isTerminal: true });
    expect(anchored.rpc.at(-1)).toEqual({ type: "get_entries", since: "e-10", id: "pi-runner-cursor-refresh:2" });
    anchored.line(entriesReply("pi-runner-cursor-refresh:2", [{ type: "message", id: "e-11" }]));
    expect(anchored.cursor()).toBe("e-11");
  });

  it.each(["rpc_error", "reassembly_drop"] as const)(
    "a known-failing unanchored full refresh does not repeat every turn, then bounded tail refresh recovers (%s)",
    (failureKind) => {
      let tailId: string | null = null;
      const r = ompRunner({ readLastEntryId: () => tailId });
      r.core.start(READY_V2);
      r.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
      r.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/s.jsonl", sessionId: "s" } });

      r.line({ type: "agent_end", isTerminal: true });
      expect(r.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
      if (failureKind === "rpc_error") {
        r.line({ type: "response", id: "pi-runner-cursor-refresh", command: "get_entries", success: false, error: "RPC response exceeded the transport limit" });
      } else {
        r.line({ type: "rpc_chunk", chunkId: "rpc-full-big", index: 0, count: 256, byteLength: 65 * MiB, data: Buffer.from("x").toString("base64") });
      }

      const rpcCountAfterFailure = r.rpc.length;
      r.line({ type: "agent_end", isTerminal: true });
      expect(r.rpc).toHaveLength(rpcCountAfterFailure);

      tailId = "e-90";
      r.line({ type: "agent_end", isTerminal: true });
      expect(r.rpc.at(-1)).toEqual({ type: "get_entries", since: "e-90", id: "pi-runner-cursor-refresh:2" });
      r.line({ type: "response", id: "pi-runner-cursor-refresh:2", command: "get_entries", success: true, data: { entries: [] } });
      expect(r.cursor()).toBe("e-90");
    },
  );

  it("an unfinished OMP turn does not issue duplicate unanchored full-history reads while keeping bounded since refreshes", () => {
    let tailId: string | null = null;
    const r = ompRunner({ readLastEntryId: () => tailId });
    r.core.start(READY_V2);
    r.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    r.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/s.jsonl", sessionId: "s" } });

    const beforeTurns = r.rpc.length;
    // Unfinished OMP turns (isTerminal === false) without an anchor must not dispatch unanchored full reads.
    r.line({ type: "agent_end", isTerminal: false });
    r.line({ type: "agent_end", isTerminal: false });
    r.line({ type: "agent_end", isTerminal: false });
    expect(r.rpc).toHaveLength(beforeTurns);

    // Completed turns coalesce an already-in-flight unanchored full read instead of stacking duplicates.
    r.line({ type: "agent_end", isTerminal: true });
    r.line({ type: "agent_end", isTerminal: true });
    const unanchoredDispatched = r.rpc.slice(beforeTurns).filter((cmd) => cmd.type === "get_entries" && cmd.since === undefined);
    expect(unanchoredDispatched).toHaveLength(1);
    expect(unanchoredDispatched[0]).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });

    r.line(entriesReply("pi-runner-cursor-refresh", [{ type: "message", id: "e-70" }]));
    expect(r.cursor()).toBe("e-70");

    // Positive control: once a usable anchor exists, a non-terminal OMP agent_end still dispatches a bounded since refresh.
    r.line({ type: "agent_end", isTerminal: false });
    expect(r.rpc.at(-1)).toEqual({ type: "get_entries", since: "e-70", id: "pi-runner-cursor-refresh:2" });
  });

  it("a corrupt chunk drop on an unanchored full refresh does not deadlock subsequent completed turns, while unrelated drops still preserve valid pending replies", () => {
    const r = ompRunner({ readLastEntryId: () => null });
    r.core.start(READY_V2);
    r.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    r.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" } });

    // Completed turn 1 issues an unanchored full read; its chunked reply has corrupt base64 and is dropped.
    r.line({ type: "agent_end", isTerminal: true });
    expect(r.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
    const corruptFrames = chunk(entriesReply("pi-runner-cursor-refresh", history(2 * MiB)));
    r.line(corruptFrames[0]);
    r.line({ ...corruptFrames[1]!, data: "!!!!" });
    for (const frame of corruptFrames.slice(2)) r.line(frame);
    expect(r.cursor()).toBeUndefined();

    // Completed turn 2 must not be blocked indefinitely by the dropped first full read; it dispatches a fresh full read.
    r.line({ type: "agent_end", isTerminal: true });
    expect(r.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh:2" });

    // While #2 is genuinely in flight with no drop, turn 3 still coalesces instead of stacking a duplicate full read.
    const countAfterSecond = r.rpc.length;
    r.line({ type: "agent_end", isTerminal: true });
    expect(r.rpc).toHaveLength(countAfterSecond);

    // #2 succeeds and advances the cursor.
    r.line(entriesReply("pi-runner-cursor-refresh:2", [{ type: "message", id: "e-80" }]));
    expect(r.cursor()).toBe("e-80");

    // Control: an unrelated corrupt drop still leaves a good pending unanchored full read intact if its own reply arrives.
    const u = ompRunner({ readLastEntryId: () => null });
    u.core.start(READY_V2);
    u.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    u.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" } });
    u.line({ type: "agent_end", isTerminal: true });
    expect(u.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
    const unrelatedCorrupt = chunk({ type: "message_end", text: "x".repeat(2 * MiB) }, "rpc-unrelated");
    u.line(unrelatedCorrupt[0]);
    u.line({ ...unrelatedCorrupt[1]!, data: "!!!!" });
    u.line(entriesReply("pi-runner-cursor-refresh", [{ type: "message", id: "e-81" }]));
    expect(u.cursor()).toBe("e-81");
  });

  it("unanchored full refresh on OMP v2 holds for three completed turns and allows a new full read on the fourth when a whole reply is lost", () => {
    expect(MAX_UNANCHORED_REFRESH_HOLD_TURNS).toBe(3);
    const getEntriesCalls = (rpc: Record<string, unknown>[]) => rpc.filter((cmd) => cmd.type === "get_entries");

    // Case 1: slow valid reply within 3 completed turns does not cause an overlapping full read; unfinished turns do not advance the bound.
    const slow = ompRunner({ readLastEntryId: () => null });
    slow.core.start(READY_V2);
    slow.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    slow.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" } });

    slow.line({ type: "agent_end", isTerminal: true }); // Turn 1 -> #1
    expect(getEntriesCalls(slow.rpc)).toEqual([{ type: "get_entries", id: "pi-runner-cursor-refresh" }]);
    slow.line({ type: "agent_end", isTerminal: false }); // Unfinished -> ignored
    slow.line({ type: "agent_end", isTerminal: true }); // Turn 2 -> held
    slow.line({ type: "agent_end", isTerminal: false }); // Unfinished -> ignored
    slow.line({ type: "agent_end", isTerminal: true }); // Turn 3 -> held
    expect(getEntriesCalls(slow.rpc)).toEqual([{ type: "get_entries", id: "pi-runner-cursor-refresh" }]);
    slow.line(entriesReply("pi-runner-cursor-refresh", [{ type: "message", id: "e-v2-slow" }]));
    expect(slow.cursor()).toBe("e-v2-slow");
    slow.line({ type: "agent_end", isTerminal: true }); // Turn 4 -> bounded since
    expect(slow.rpc.at(-1)).toEqual({ type: "get_entries", since: "e-v2-slow", id: "pi-runner-cursor-refresh:2" });

    // Case 2: lost whole reply on OMP v2 (both silent and truncated whole-line non-JSON with no active chunk sequence)
    // holds through turns 2 and 3 and dispatches a new full read on the 4th completed turn.
    for (const lossKind of ["silent", "truncated_line"] as const) {
      const lost = ompRunner({ readLastEntryId: () => null });
      lost.core.start(READY_V2);
      lost.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
      lost.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" } });

      lost.line({ type: "agent_end", isTerminal: true }); // Turn 1 -> #1
      expect(getEntriesCalls(lost.rpc)).toEqual([{ type: "get_entries", id: "pi-runner-cursor-refresh" }]);
      if (lossKind === "truncated_line") {
        const truncated = '{"type":"response","id":"pi-runner-cursor-refresh"';
        lost.core.handlePiLine(truncated);
        expect(lost.mirror).toContain(truncated);
        expect(lost.mirror.some((l) => l.startsWith("[omp-runner] ERROR rpc frame:"))).toBe(false);
      }

      // Unfinished OMP turns do not count toward the 3-completed-turn hold.
      lost.line({ type: "agent_end", isTerminal: false });
      lost.line({ type: "agent_end", isTerminal: false });
      lost.line({ type: "agent_end", isTerminal: true }); // Turn 2 -> held
      lost.line({ type: "agent_end", isTerminal: true }); // Turn 3 -> held
      expect(getEntriesCalls(lost.rpc), lossKind).toEqual([{ type: "get_entries", id: "pi-runner-cursor-refresh" }]);

      lost.line({ type: "agent_end", isTerminal: true }); // Turn 4 -> #2
      expect(getEntriesCalls(lost.rpc), lossKind).toEqual([
        { type: "get_entries", id: "pi-runner-cursor-refresh" },
        { type: "get_entries", id: "pi-runner-cursor-refresh:2" },
      ]);

      // #2 settles; a late reply to #1 is ignored under the existing late-reply rule.
      lost.line(entriesReply("pi-runner-cursor-refresh:2", [{ type: "message", id: "e-v2-recovered-4" }]));
      expect(lost.cursor(), lossKind).toBe("e-v2-recovered-4");
      lost.line(entriesReply("pi-runner-cursor-refresh", [{ type: "message", id: "e-v2-stale-1" }]));
      expect(lost.cursor(), lossKind).toBe("e-v2-recovered-4");
    }

    // Case 3: late reply to #1 arriving after turn 4 sent #2 (before #2 settles) still advances, then #2 advances further.
    const late = ompRunner({ readLastEntryId: () => null });
    late.core.start(READY_V2);
    late.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    late.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" } });
    late.line({ type: "agent_end", isTerminal: true }); // Turn 1 -> #1
    late.line({ type: "agent_end", isTerminal: true }); // Turn 2 -> held
    late.line({ type: "agent_end", isTerminal: true }); // Turn 3 -> held
    late.line({ type: "agent_end", isTerminal: true }); // Turn 4 -> #2
    expect(late.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh:2" });
    late.line(entriesReply("pi-runner-cursor-refresh", [{ type: "message", id: "e-v2-late-1" }]));
    expect(late.cursor()).toBe("e-v2-late-1");
    late.line(entriesReply("pi-runner-cursor-refresh:2", [{ type: "message", id: "e-v2-fresh-2" }]));
    expect(late.cursor()).toBe("e-v2-fresh-2");

    // Control: suspected oversized drop on OMP v2 still suppresses later unanchored full reads past turn 4.
    const big = ompRunner({ readLastEntryId: () => null });
    big.core.start(READY_V2);
    big.line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    big.line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" } });
    big.line({ type: "agent_end", isTerminal: true });
    big.line({ type: "rpc_chunk", chunkId: "rpc-big-v2", index: 0, count: 256, byteLength: 65 * MiB, data: Buffer.from("x").toString("base64") });
    const countAfterDrop = big.rpc.length;
    for (let turn = 2; turn <= 5; turn++) {
      big.line({ type: "agent_end", isTerminal: true });
    }
    expect(big.rpc).toHaveLength(countAfterDrop);
  });
});

// The production wiring: the real runner entry hands OMP's ready frame to the core. A fake `omp` answers
// with OMP v18.5.0's framing: v1 overflow for a reply over 1 MiB, rpc_chunk after negotiate_protocol.
const RUNNER = nodePath.join(__dirname, "..", "src", "adapters", "pi-runner.ts");
const FAKE_OMP = String.raw`
const fs = require("node:fs"), readline = require("node:readline");
const v2 = process.env.HOME.endsWith("/v2"); // the seat HOME is the only env the runner forwards that the test can name
const argv = process.argv.slice(2), sessionFile = argv[argv.indexOf("--session") + 1];
const entries = () => fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type !== "session");
let version = 1, chunkId = 0;
const write = (frame) => {
  const json = JSON.stringify(frame), bytes = Buffer.from(json);
  if (bytes.length + 1 <= 1048576) return void process.stdout.write(json + "\n");
  if (version === 1) return void process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: frame.command, success: false, error: "RPC response exceeded the transport limit" }) + "\n");
  const count = Math.ceil(bytes.length / 262144), id = "rpc-" + ++chunkId;
  for (let index = 0; index < count; index++) process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId: id, index, count, byteLength: bytes.length, data: bytes.subarray(index * 262144, (index + 1) * 262144).toString("base64") }) + "\n");
};
write(v2 ? { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 } : { type: "ready" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line), ok = (data) => ({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
  if (cmd.type === "negotiate_protocol") { write(ok({ protocolVersion: 2 })); version = 2; }
  else if (cmd.type === "get_state") write(ok({ sessionFile, sessionId: "s" }));
  else if (cmd.type === "get_entries") { const all = entries(); write(ok({ entries: all.slice(all.findIndex((e) => e.id === cmd.since) + 1), leafId: null })); }
}).on("close", () => process.exit(0));
`;

let root: string | null = null;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = null; });

async function restoreThroughRunner(v2: boolean): Promise<{ cursor: string | undefined; output: string; last: string }> {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-v2-"));
  const bin = nodePath.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(nodePath.join(root, "fake-omp.cjs"), FAKE_OMP);
  fs.writeFileSync(nodePath.join(bin, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${nodePath.join(root, "fake-omp.cjs")}" "$@"\n`, { mode: 0o755 });
  // The seat HOME is <stateRoot>/<sessionName>; the fake reads v1/v2 from its name.
  const sessionName = v2 ? "v2" : "v1";
  const seat = nodePath.join(root, "state", sessionName);
  fs.mkdirSync(nodePath.join(seat, "sessions"), { recursive: true });
  const entries = history(2 * MiB);
  const sessionFile = nodePath.join(seat, "sessions", "s.jsonl");
  fs.writeFileSync(sessionFile, `${[{ type: "session", id: "s" }, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  fs.writeFileSync(nodePath.join(seat, "runner-state.json"), JSON.stringify({ ready: false, updatedAt: "2026-10-14T00:00:00Z", lastEntryId: "e-1" }));
  const child = spawn(process.execPath, [
    "--import", "tsx", RUNNER, "--runtime", "omp", "--approval-mode", "always-ask", "--session-name", sessionName,
    "--state-root", nodePath.join(root, "state"), "--cwd", root, "--launch-id", "launch-1", "--session", sessionFile,
  ], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: os.tmpdir(),
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      ...(process.env.NO_NETWORK_TRACE_FILE ? { NO_NETWORK_TRACE_FILE: process.env.NO_NETWORK_TRACE_FILE } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const state = () => JSON.parse(fs.readFileSync(nodePath.join(seat, "runner-state.json"), "utf8")) as PiRunnerState;
  // Done when the catch-up has answered: the cursor moved, or the failure was reported.
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (output.includes("[omp-runner] ERROR") || (output.includes("[omp-runner] READY") && state().lastEntryId !== "e-1")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const exited = new Promise((r) => child.once("close", r));
  child.kill();
  await exited;
  return { cursor: state().lastEntryId, output, last: entries.at(-1)!.id as string };
}

describe("OMP restore catch-up through the real runner entry (#1275)", () => {
  it("v2 advertised: a 2 MiB catch-up reaches the last persisted entry", async () => {
    const { cursor, output, last } = await restoreThroughRunner(true);
    expect(output).toContain("[omp-runner] READY");
    expect(output).not.toContain("ERROR");
    expect(cursor).toBe(last);
  }, 40_000);

  it("v1 only (an older OMP): the same restore fails as before and the cursor stays put", async () => {
    const { cursor, output } = await restoreThroughRunner(false);
    expect(output).toContain("[omp-runner] ERROR rpc: RPC response exceeded the transport limit");
    expect(cursor).toBe("e-1");
  }, 40_000);

  it("unseeded OMP session uses production readLastEntryId binding on disk tail and persists the confirmed cursor", async () => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-unseeded-"));
    const bin = nodePath.join(root, "bin");
    const seat = nodePath.join(root, "state", "omp-unseeded");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(nodePath.join(seat, "sessions"), { recursive: true });
    const sessionFile = nodePath.join(seat, "sessions", "s.jsonl");
    const header = JSON.stringify({ type: "session", id: "sess-1" });
    fs.writeFileSync(sessionFile, `${header}\n${JSON.stringify({ type: "message", id: "disk-tail-1" })}\n`);
    const rpcLog = nodePath.join(root, "rpc.jsonl");
    const fakeChildOmp = [
      'const fs = require("node:fs"), readline = require("node:readline");',
      "const argv = process.argv.slice(2), sessionFile = argv[argv.indexOf('--session') + 1];",
      `const rpcLog = ${JSON.stringify(rpcLog)};`,
      "const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
      "out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const cmd = JSON.parse(line); fs.appendFileSync(rpcLog, line + '\\n');",
      "  if (cmd.type === 'negotiate_protocol') out({ id: cmd.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } });",
      "  else if (cmd.type === 'get_state') { out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { sessionFile, sessionId: 's' } }); setImmediate(() => out({ type: 'agent_end', isTerminal: true })); }",
      "  else if (cmd.type === 'get_entries') {",
      "    if (!cmd.since) out({ id: cmd.id, type: 'response', command: 'get_entries', success: false, error: 'RPC response exceeded the transport limit' });",
      "    else out({ id: cmd.id, type: 'response', command: 'get_entries', success: true, data: { entries: [], leafId: null } });",
      "  }",
      "}).on('close', () => process.exit(0));",
    ].join("\n");
    fs.writeFileSync(nodePath.join(root, "fake-unseeded-omp.cjs"), fakeChildOmp);
    fs.writeFileSync(nodePath.join(bin, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${nodePath.join(root, "fake-unseeded-omp.cjs")}" "$@"\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [
      "--import", "tsx", RUNNER, "--runtime", "omp", "--approval-mode", "always-ask", "--session-name", "omp-unseeded",
      "--state-root", nodePath.join(root, "state"), "--cwd", root, "--launch-id", "launch-unseeded", "--session", sessionFile,
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: os.tmpdir(),
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
        ...(process.env.NO_NETWORK_TRACE_FILE ? { NO_NETWORK_TRACE_FILE: process.env.NO_NETWORK_TRACE_FILE } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const exited = new Promise((r) => child.once("close", r));
    const statePath = nodePath.join(seat, "runner-state.json");
    const readState = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) as PiRunnerState : null);
    try {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        if (child.exitCode !== null || output.includes("[omp-runner] ERROR") || readState()?.lastEntryId === "disk-tail-1") break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      child.kill();
      await exited;
    }
    const sent = fs.existsSync(rpcLog)
      ? fs.readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    const refreshes = sent.filter((cmd) => cmd.type === "get_entries");
    expect(output).not.toContain("ERROR");
    expect(refreshes).toContainEqual({ type: "get_entries", since: "disk-tail-1", id: "pi-runner-cursor-refresh" });
    expect(readState()?.lastEntryId).toBe("disk-tail-1");
  }, 40_000);
});
