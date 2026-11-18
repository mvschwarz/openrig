// #1275: OMP restore catch-up and the post-turn cursor refresh above one RPC frame. OMP v1 caps a stdout line
// at 1 MiB and fails a larger get_entries reply; the runner negotiates protocol v2 when OMP's ready frame
// advertises it, and reassembles rpc_chunk sequences with bounded memory and explicit failure.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OMP_MAX_REASSEMBLED_FRAME_BYTES, OmpFrameDecoder, ompProtocolV2Limit, type OmpFrameResult } from "../src/adapters/omp-rpc-frame.js";
import * as piRunnerModule from "../src/adapters/pi-runner.js";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
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

function ompRunner(opts: { catchUpSince?: string; runtime?: "omp" | "pi" } = {}) {
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
    now: () => "2026-10-14T12:00:00Z",
  };
  const core = new RunnerCore(io, { sessionName: "omp-worker@rig", launchId: "attempt-1" }, { runtime: opts.runtime ?? "omp", catchUpSince: opts.catchUpSince });
  const line = (frame: unknown) => core.handlePiLine(JSON.stringify(frame));
  const cursor = () => sidecars.at(-1)?.lastEntryId;
  return { core, rpc, mirror, line, cursor };
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
    const all = [...history(3 * MiB), { type: "message", id: "turn-1", parentId: restored.at(-1)!.id }];
    for (const frame of chunk(entriesReply("pi-runner-cursor-refresh", all), "rpc-2")) line(frame);
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
    expect(rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
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

  function sinceAwareOmp(
    initialEntries: Array<Record<string, unknown>>,
    opts: { catchUpSince?: string; sessionFile?: string; tailFn?: () => string | null } = {},
  ) {
    const entries = [...initialEntries];
    const rpc: Record<string, unknown>[] = [];
    const mirror: string[] = [];
    const sidecars: PiRunnerState[] = [];
    const sessionFile = opts.sessionFile ?? "/s.jsonl";
    const io: RunnerIo = {
      sendRpc: (cmd) => { rpc.push(cmd); },
      mirrorLine: (l) => { mirror.push(l); },
      mirrorAppend: () => {},
      postActivity: () => {},
      writeSidecar: (state) => { sidecars.push(state); },
      sessionFileExists: () => true,
      ...(opts.tailFn ? { readLastEntryId: () => opts.tailFn!() } : {}),
      now: () => "2026-10-14T12:00:00Z",
    };
    const core = new RunnerCore(
      io,
      { sessionName: "omp-worker@rig", launchId: "attempt-1" },
      { runtime: "omp", catchUpSince: opts.catchUpSince, requestedSessionFile: sessionFile },
    );
    const line = (frame: unknown) => core.handlePiLine(JSON.stringify(frame));
    core.start(READY_V2);
    line({ type: "response", id: "omp-runner-negotiate", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    line({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true, data: { sessionFile, sessionId: "s" } });

    const answerGetEntries = (cmd: Record<string, unknown>, subsetEndId?: string) => {
      const id = String(cmd.id);
      let slice: Array<Record<string, unknown>>;
      if (typeof cmd.since === "string") {
        const idx = entries.findIndex((e) => e.id === cmd.since);
        if (idx === -1) {
          line({ type: "response", id, command: "get_entries", success: false, error: `Entry not found: ${cmd.since}` });
          return;
        }
        const endIdx = subsetEndId ? entries.findIndex((e) => e.id === subsetEndId) : entries.length - 1;
        slice = entries.slice(idx + 1, endIdx >= 0 ? endIdx + 1 : entries.length);
      } else {
        slice = entries.slice();
      }
      const reply = entriesReply(id, slice);
      const replyBytes = Buffer.byteLength(JSON.stringify(reply), "utf8");
      if (replyBytes > OMP_MAX_REASSEMBLED_FRAME_BYTES) {
        line({ type: "response", id, command: "get_entries", success: false, error: "RPC response exceeded the transport limit" });
        return;
      }
      if (replyBytes + 1 > MiB) {
        for (const frame of chunk(reply, `rpc-${id}`)) line(frame);
        return;
      }
      line(reply);
    };

    return { core, entries, rpc, mirror, sidecars, line, answerGetEntries, cursor: () => sidecars.at(-1)?.lastEntryId };
  }

  it("#1275: startup restore orders [B, C] ahead of live B, retries bounded catch-up at turn end on gap or stalled pending, and unpins Entry not found after an unrelated frame drop", () => {
    // 1. Startup reply [e2, e3] after live e2 saves e3 (not e2), and buffered refresh [e3, e4] after since: e2 chains across interior e3 to e4.
    const baseEntries = [
      { type: "message", id: "e1", parentId: null },
      { type: "message", id: "e2", parentId: "e1" },
      { type: "message", id: "e3", parentId: "e2" },
      { type: "message", id: "e4", parentId: "e3" },
    ];
    const rOrder = sinceAwareOmp(baseEntries, { catchUpSince: "e1" });
    rOrder.line({ type: "agent_start", entryId: "e2" });
    expect.soft(rOrder.cursor()).toBe("e1");
    rOrder.answerGetEntries({ id: "pi-runner-catch-up", since: "e1" }, "e3");
    expect.soft(rOrder.cursor()).toBe("e3");
    rOrder.line({ type: "agent_end", isTerminal: true });
    expect.soft(rOrder.rpc.at(-1)).toEqual({ type: "get_entries", since: "e3", id: "pi-runner-cursor-refresh" });

    const rChain = sinceAwareOmp(baseEntries, { catchUpSince: "e1" });
    rChain.line({ type: "agent_start", entryId: "e2" });
    rChain.line({ type: "agent_end", isTerminal: true });
    expect.soft(rChain.rpc.at(-1)).toEqual({ type: "get_entries", since: "e2", id: "pi-runner-cursor-refresh" });
    rChain.answerGetEntries(rChain.rpc.at(-1)!); // returns [e3, e4] while catch-up is still pending
    expect.soft(rChain.cursor()).toBe("e1");
    rChain.answerGetEntries({ id: "pi-runner-catch-up", since: "e1" }, "e3"); // returns [e2, e3], overlapping interior e3 -> chains to e4
    expect.soft(rChain.cursor()).toBe("e4");

    // 2. Dropped chunked catch-up (gap) retries bounded pi-runner-catch-up at next agent_end; unanswered catch-up keeps at most
    //    one in flight across Turn 1 and retries pi-runner-catch-up at Turn 2 agent_end.
    const rDrop = sinceAwareOmp(baseEntries, { catchUpSince: "e1", tailFn: () => "e4" });
    rDrop.line({ type: "rpc_chunk", chunkId: "rpc-drop", index: 0, count: 260, byteLength: OMP_MAX_REASSEMBLED_FRAME_BYTES + 1024, data: "e30=" });
    expect.soft(rDrop.cursor()).toBe("e1");
    rDrop.line({ type: "agent_end", isTerminal: true });
    expect.soft(rDrop.rpc.at(-1)).toEqual({ type: "get_entries", since: "e1", id: "pi-runner-catch-up" });
    rDrop.answerGetEntries(rDrop.rpc.at(-1)!);
    expect.soft(rDrop.cursor()).toBe("e4");

    const rStalled = sinceAwareOmp(baseEntries, { catchUpSince: "e1", tailFn: () => "e4" });
    // Initial pi-runner-catch-up never answers: Turn 1 agent_end does not send a second catch-up while #1 is in its first turn.
    rStalled.line({ type: "agent_end", isTerminal: true });
    const catchUpsAfterTurn1 = rStalled.rpc.filter((c) => c.id === "pi-runner-catch-up");
    expect.soft(catchUpsAfterTurn1).toHaveLength(1);
    expect.soft(rStalled.rpc.at(-1)).toEqual({ type: "get_entries", since: "e4", id: "pi-runner-cursor-refresh" });
    rStalled.answerGetEntries(rStalled.rpc.at(-1)!); // empty tail reply does not connect e1 -> cursor stays e1
    expect.soft(rStalled.cursor()).toBe("e1");
    // Turn 2 agent_end (pending past one turn) retries bounded pi-runner-catch-up from e1 and connects through e4.
    rStalled.line({ type: "agent_end", isTerminal: true });
    expect.soft(rStalled.rpc.at(-1)).toEqual({ type: "get_entries", since: "e1", id: "pi-runner-catch-up" });
    rStalled.answerGetEntries(rStalled.rpc.at(-1)!);
    expect.soft(rStalled.cursor()).toBe("e4");

    // 3. An unrelated dropped OMP frame during startup sets gap, and an explicit Entry not found reply on pi-runner-catch-up
    //    clears gap so the next turn's local tail anchor confirms and saves e4.
    const rUnpin = sinceAwareOmp(baseEntries, { catchUpSince: "stale-id", tailFn: () => "e4" });
    rUnpin.line({ type: "rpc_chunk", chunkId: "rpc-event-drop", index: 0, count: 260, byteLength: OMP_MAX_REASSEMBLED_FRAME_BYTES + 1024, data: "e30=" });
    rUnpin.answerGetEntries({ id: "pi-runner-catch-up", since: "stale-id" }); // Entry not found: stale-id
    expect.soft(rUnpin.cursor()).toBe("stale-id");
    rUnpin.line({ type: "agent_end", isTerminal: true });
    expect.soft(rUnpin.rpc.at(-1)).toEqual({ type: "get_entries", since: "e4", id: "pi-runner-cursor-refresh" });
    rUnpin.answerGetEntries(rUnpin.rpc.at(-1)!); // entries: [], success: true -> confirms anchor e4
    expect.soft(rUnpin.cursor()).toBe("e4");
  });

  it("#1275: saved replay position advances only through connected reads, and > 64 MiB sessions advance or seed boundedly via readSessionTailEntryId", async () => {
    // 1. Live entryId during pending restore never skips silent disk entries when catch-up returns an earlier snapshot;
    //    empty, malformed, stale and evicted refresh replies never move lastEntryId.
    const diskEntries = [
      { type: "message", id: "big-1", parentId: null },
      { type: "message", id: "older-restored", parentId: "big-1" },
      { type: "message", id: "silent-disk-entry", parentId: "older-restored" },
      { type: "message", id: "live-entry-2", parentId: "silent-disk-entry" },
      { type: "message", id: "turn-end", parentId: "live-entry-2" },
    ];
    const rConn = sinceAwareOmp(diskEntries, { catchUpSince: "big-1" });
    rConn.line({ type: "agent_start", entryId: "live-entry-2" });
    expect.soft(rConn.cursor()).toBe("big-1");
    rConn.answerGetEntries({ id: "pi-runner-catch-up", since: "big-1" }, "older-restored");
    // Must stop at older-restored rather than jumping to unconnected live-entry-2.
    expect.soft(rConn.cursor()).toBe("older-restored");

    // Malformed, id-less, empty, stale and evicted refresh replies leave older-restored untouched.
    rConn.line({ type: "agent_end", isTerminal: true });
    expect.soft(rConn.rpc.at(-1)).toEqual({ type: "get_entries", since: "older-restored", id: "pi-runner-cursor-refresh" });
    rConn.line({ type: "response", id: "pi-runner-cursor-refresh", success: true, data: {} });
    expect.soft(rConn.cursor()).toBe("older-restored");
    rConn.line({ type: "agent_end", isTerminal: true });
    rConn.line({ type: "response", id: "pi-runner-cursor-refresh:2", success: true, data: { entries: [{ noId: true }] } });
    expect.soft(rConn.cursor()).toBe("older-restored");

    // Eviction (> 16 pending) and stale out-of-order refresh replies:
    rConn.line({ type: "agent_end", isTerminal: true });
    const evictedId = String(rConn.rpc.at(-1)!.id);
    for (let i = 0; i < 16; i++) rConn.line({ type: "agent_end", isTerminal: true });
    const newestId = String(rConn.rpc.at(-1)!.id);
    rConn.line({ type: "response", id: evictedId, success: true, data: { entries: [{ id: "turn-end" }] } });
    expect.soft(rConn.cursor()).toBe("older-restored");

    // Now the newest connected refresh from older-restored reads [silent-disk-entry, live-entry-2, turn-end] and advances to turn-end;
    // a late older reply afterward cannot regress turn-end.
    rConn.answerGetEntries({ id: newestId, since: "older-restored" });
    expect.soft(rConn.cursor()).toBe("turn-end");
    rConn.line({ type: "response", id: "pi-runner-cursor-refresh:10", success: true, data: { entries: [{ id: "live-entry-2" }] } });
    expect.soft(rConn.cursor()).toBe("turn-end");

    // 2. Synthetic > 64 MiB (66+ MiB) session on a since-aware v2 fake:
    //    (a) catch-up > 64 MiB behind fails with transport limit and keeps lastEntryId unchanged;
    //    (b) catch-up from a recent cursor succeeds and post-turn refresh advances without an unbounded > 64 MiB response;
    //    (c) unseeded > 64 MiB session seeds boundedly from readSessionTailEntryId on disk, including through the real runner entry.
    const bigPayload = "x".repeat(MiB);
    const largeEntries: Array<Record<string, unknown>> = Array.from({ length: 66 }, (_, i) => ({
      type: "message",
      id: `huge-${i + 1}`,
      parentId: i > 0 ? `huge-${i}` : null,
      text: bigPayload,
    }));
    largeEntries.push(
      { type: "message", id: "tail-prev", parentId: "huge-66", text: "recent" },
      { type: "message", id: "turn-after-64m", parentId: "tail-prev", text: "turn" },
    );

    const rOver = sinceAwareOmp(largeEntries, { catchUpSince: "huge-1" });
    rOver.answerGetEntries(rOver.rpc.at(-1)!); // > 64 MiB from huge-1 -> transport limit error, cursor stays huge-1
    expect.soft(rOver.mirror).toContain("[omp-runner] ERROR rpc: RPC response exceeded the transport limit");
    expect.soft(rOver.cursor()).toBe("huge-1");

    const rRecent = sinceAwareOmp(largeEntries, { catchUpSince: "huge-66" });
    rRecent.answerGetEntries(rRecent.rpc.at(-1)!); // bounded restore [tail-prev, turn-after-64m]
    rRecent.entries.push({ type: "message", id: "turn-next-64m", parentId: "turn-after-64m", text: "next" });
    rRecent.line({ type: "agent_end", isTerminal: true });
    expect.soft(rRecent.rpc.at(-1)).toEqual({ type: "get_entries", since: "turn-after-64m", id: "pi-runner-cursor-refresh" });
    rRecent.answerGetEntries(rRecent.rpc.at(-1)!);
    expect.soft(rRecent.cursor()).toBe("turn-next-64m");
    expect.soft(rRecent.mirror.filter((l) => l.includes("ERROR"))).toEqual([]);

    const readTail = (piRunnerModule as { readSessionTailEntryId?: (p: string, limit?: number, hooks?: { afterStat?: () => void; afterRead?: () => void }) => string | null }).readSessionTailEntryId;
    expect.soft(typeof readTail).toBe("function");
    if (typeof readTail !== "function") return;

    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-tail-1275-"));
    try {
      const tailFile = nodePath.join(tmp, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "sess-1" });
      const multiChunkRecord = JSON.stringify({ type: "message", id: "utf8-tail-id", text: "é".repeat(45_000) });
      fs.writeFileSync(tailFile, `${header}\n${multiChunkRecord}\n`);
      expect.soft(readTail(tailFile)).toBe("utf8-tail-id");
      expect.soft(readTail(tailFile, 1024)).toBeNull(); // exceeds limitBytes
      expect.soft(readTail(tailFile, undefined, { afterRead: () => fs.appendFileSync(tailFile, "\n") })).toBeNull(); // mutated during read

      for (const bad of ["", `${header}\n`, `${header}\n{"id":"torn"`, `${header}\n${multiChunkRecord}\n\n`, `${header}\nnull\n`, `${header}\n{"type":"message"}\n`]) {
        fs.writeFileSync(tailFile, bad);
        expect.soft(readTail(tailFile)).toBeNull();
      }
      expect.soft(readTail(tmp)).toBeNull(); // directory
      const fifo = nodePath.join(tmp, "pipe.jsonl");
      execFileSync("mkfifo", [fifo]);
      expect.soft(readTail(fifo)).toBeNull(); // non-regular FIFO never blocks

      // Real runner entry wiring on an unseeded session whose full get_entries exceeds the cap while tail-anchored get_entries succeeds.
      fs.writeFileSync(tailFile, `${header}\n${multiChunkRecord}\n`);
      const rUnseeded = sinceAwareOmp(largeEntries, { sessionFile: tailFile, tailFn: () => readTail(tailFile) });
      rUnseeded.entries.push({ type: "message", id: "utf8-tail-id", parentId: "turn-after-64m", text: "seeded" });
      rUnseeded.line({ type: "agent_end", isTerminal: true });
      expect.soft(rUnseeded.rpc.at(-1)).toEqual({ type: "get_entries", since: "utf8-tail-id", id: "pi-runner-cursor-refresh" });
      rUnseeded.answerGetEntries(rUnseeded.rpc.at(-1)!);
      expect.soft(rUnseeded.cursor()).toBe("utf8-tail-id");

      // Production runPiRunner wiring check: spawn the real runner entry with an unseeded session and verify agent_end passes `since` from disk tail.
      const bin = nodePath.join(tmp, "bin");
      const seat = nodePath.join(tmp, "state", "omp-child");
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(nodePath.join(seat, "sessions"), { recursive: true });
      const childSession = nodePath.join(seat, "sessions", "s.jsonl");
      fs.writeFileSync(childSession, `${header}\n${JSON.stringify({ type: "message", id: "disk-tail-1" })}\n`);
      const rpcLog = nodePath.join(tmp, "rpc.jsonl");
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
      fs.writeFileSync(nodePath.join(tmp, "fake-child-omp.cjs"), fakeChildOmp);
      fs.writeFileSync(nodePath.join(bin, "omp"), `#!/bin/sh\nexec "${process.execPath}" "${nodePath.join(tmp, "fake-child-omp.cjs")}" "$@"\n`, { mode: 0o755 });
      const child = spawn(process.execPath, [
        "--import", "tsx", RUNNER, "--runtime", "omp", "--approval-mode", "always-ask", "--session-name", "omp-child",
        "--state-root", nodePath.join(tmp, "state"), "--cwd", tmp, "--launch-id", "launch-child", "--session", childSession,
      ], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: tmp,
          TMPDIR: os.tmpdir(),
          ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
          ...(process.env.NO_NETWORK_TRACE_FILE ? { NO_NETWORK_TRACE_FILE: process.env.NO_NETWORK_TRACE_FILE } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise((r) => child.once("close", r));
      try {
        const sidecarPath = nodePath.join(seat, "runner-state.json");
        for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
          if (fs.existsSync(sidecarPath)) {
            const st = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as PiRunnerState;
            if (st.lastEntryId === "disk-tail-1") break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const finalState = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as PiRunnerState;
        expect.soft(finalState.lastEntryId).toBe("disk-tail-1");
        const sentCmds = fs.readFileSync(rpcLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
        expect.soft(sentCmds).toContainEqual({ type: "get_entries", since: "disk-tail-1", id: "pi-runner-cursor-refresh" });
      } finally {
        child.kill();
        await exited;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 40_000);
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
  ], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: os.tmpdir() }, stdio: ["pipe", "pipe", "pipe"] });
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
});
