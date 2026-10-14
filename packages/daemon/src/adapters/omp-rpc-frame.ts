// OMP RPC protocol v2 framing, from the client side (#1275).
//
// OMP caps each stdout line at 1 MiB in protocol v1, and answers a larger response with
// `success: false, error: "RPC response exceeded the transport limit"`. Its `ready` frame can advertise
// protocol v2: after `negotiate_protocol`, a larger frame (response or event) arrives as a sequence of
// `rpc_chunk` lines carrying base64 segments of one JSON object, up to `maxReassembledFrameBytes`.
// This decoder follows OMP's documented contract (docs/rpc.md "Transport and Framing", checked against
// v18.5.0): validate chunkId, index, count and byteLength, reject interrupted or interleaved sequences,
// enforce the reassembly limit, concatenate in index order, decode strict UTF-8, parse one JSON object.

/** OMP's documented reassembly ceiling; an advertised limit above it is not trusted. */
export const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
/** OMP's documented physical frame limit; one chunk line can't carry more. */
const OMP_MAX_FRAME_BYTES = 1024 * 1024;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The reassembly limit to negotiate under, when the ready frame advertises protocol v2; otherwise null (stay on v1). */
export function ompProtocolV2Limit(ready: Record<string, unknown>): number | null {
  const versions = ready.supportedProtocolVersions;
  if (!Array.isArray(versions) || !versions.includes(2)) return null;
  const advertised = ready.maxReassembledFrameBytes;
  return typeof advertised === "number" && Number.isSafeInteger(advertised) && advertised > 0
    ? Math.min(advertised, OMP_MAX_REASSEMBLED_FRAME_BYTES)
    : OMP_MAX_REASSEMBLED_FRAME_BYTES;
}

export type OmpFrameResult =
  /** A whole frame: a plain line, or a completed chunk sequence. `dropped` names a sequence the frame interrupted. */
  | { frame: Record<string, unknown>; dropped?: string }
  /** A chunk was accepted; the sequence isn't complete yet. */
  | { pending: true }
  /** A chunk sequence was rejected and discarded. Its remaining chunks are skipped without another error. */
  | { dropped: string }
  /** A chunk of a sequence already rejected. */
  | { skipped: true };

interface Pending { chunkId: string; count: number; byteLength: number; nextIndex: number; chunks: Buffer[]; received: number }

/** Reassembles protocol v2 `rpc_chunk` sequences from parsed stdout lines. Holds at most one sequence, never more
 *  than `limitBytes` of it, and checks each chunk's declared length against the limit before keeping any of it. */
export class OmpFrameDecoder {
  private pending: Pending | null = null;
  /** Sequences already reported as rejected (at most two: an interleaving pair); their later chunks are skipped. */
  private readonly rejected = new Set<string>();

  constructor(private readonly limitBytes: number) {}

  /** The sequence still waiting for chunks, if any: at end of stream it can never complete. */
  incomplete(): string | null {
    return this.pending ? `chunk sequence ${this.pending.chunkId} ended after ${this.pending.nextIndex} of ${this.pending.count} chunks` : null;
  }

  push(value: Record<string, unknown>): OmpFrameResult {
    if (value.type !== "rpc_chunk") {
      if (!this.pending) return { frame: value };
      const { chunkId } = this.pending;
      this.pending = null;
      this.rejected.clear();
      this.rejected.add(chunkId);
      return { frame: value, dropped: `chunk sequence ${chunkId} was interrupted by a ${String(value.type)} frame` };
    }
    const { chunkId, index, count, byteLength, data } = value;
    if (typeof chunkId === "string" && this.rejected.has(chunkId)) return { skipped: true };
    const reject = (reason: string): OmpFrameResult => {
      this.pending = null;
      this.rejected.clear();
      if (typeof chunkId === "string") this.rejected.add(chunkId);
      return { dropped: reason };
    };
    if (typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128
      || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength)) {
      return reject("a chunk with invalid metadata");
    }
    const at = index as number, of = count as number, length = byteLength as number;
    if (length > this.limitBytes) return reject(`chunk sequence ${chunkId} declares ${length} bytes, above the ${this.limitBytes}-byte reassembly limit`);
    if (of < 2 || at < 0 || at >= of || length < 1 || of > length) return reject(`chunk sequence ${chunkId} has invalid metadata`);
    if (typeof data !== "string" || data.length === 0 || data.length > OMP_MAX_FRAME_BYTES || !BASE64.test(data)) {
      return reject(`chunk sequence ${chunkId} has invalid chunk data`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) return reject(`chunk sequence ${chunkId} has invalid chunk data`);

    if (!this.pending) {
      if (at !== 0) return reject(`chunk sequence ${chunkId} did not start at index 0`);
      this.rejected.clear();
      this.pending = { chunkId, count: of, byteLength: length, nextIndex: 0, chunks: [], received: 0 };
    } else if (this.pending.chunkId !== chunkId) {
      const interrupted = this.pending.chunkId;
      this.pending = null;
      // Both sequences are unusable: the interrupted one is incomplete, and the newcomer interleaved it.
      this.rejected.clear();
      this.rejected.add(interrupted).add(chunkId);
      return { dropped: `chunk sequence ${interrupted} was interleaved with ${chunkId}` };
    }
    const pending = this.pending;
    if (pending.count !== of || pending.byteLength !== length || pending.nextIndex !== at) {
      return reject(`chunk sequence ${chunkId} is out of order or changed its metadata`);
    }
    if (pending.received + bytes.byteLength > pending.byteLength) return reject(`chunk sequence ${chunkId} exceeds its declared length`);
    pending.chunks.push(bytes);
    pending.received += bytes.byteLength;
    pending.nextIndex++;
    if (pending.nextIndex < pending.count) return { pending: true };
    this.pending = null;
    if (pending.received !== pending.byteLength) return reject(`chunk sequence ${chunkId} is shorter than its declared length`);
    let frame: unknown;
    try {
      frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks)));
    } catch {
      return reject(`chunk sequence ${chunkId} is not one UTF-8 JSON object`);
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return reject(`chunk sequence ${chunkId} is not one JSON object`);
    return { frame: frame as Record<string, unknown> };
  }
}
