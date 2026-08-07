// M1 A4a — the gateway-side DISPATCH BUFFER: durable OutboundDecisions held until the
// connector Acks (contract a305310d). This is what makes connector-outage -> no-loss ->
// ack-gated drain PROVABLE (proof-9). It is a DISTINCT store from the connector-side
// slice-11 delivery ledger (SeenStore/DeadLetterStore) — the two are NEVER merged
// (conflating them re-creates the drift class the arch verdict called out).
//
// Durability = the slice-11 atomic pattern (write a temp sibling + rename): a decision is
// persisted BEFORE it is dispatched, and removed ONLY after its Ack. decisionId is the
// idempotency key — re-dispatching an un-Acked decision produces a byte-identical dup.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";
import type { OutboundDecision } from "./protocol.js";

export function dispatchBufferPath(home: string = getOpenRigHome()): string {
  return join(home, "gateway", "dispatch-buffer.json");
}

interface BufferState {
  pending: OutboundDecision[];
}

function readState(path: string): BufferState {
  if (!existsSync(path)) return { pending: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BufferState>;
    return { pending: Array.isArray(raw.pending) ? raw.pending : [] };
  } catch {
    // A corrupt buffer fails CLOSED to empty rather than throwing — a dispatch buffer
    // that can't be read must not wedge the gateway; the un-Acked decisions are lost
    // only if the file itself is corrupt (a separate durability incident), never silently
    // dropped on a clean read.
    return { pending: [] };
  }
}

function writeState(path: string, state: BufferState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 0), { mode: 0o600 });
  renameSync(tmp, path);
}

/** The durable gateway dispatch buffer. Restart-surviving: `pending()` reads from disk.
 *  Idempotent on decisionId — enqueuing the same decisionId twice keeps ONE record. */
export class DispatchBuffer {
  private readonly path: string;
  constructor(home: string = getOpenRigHome()) {
    this.path = dispatchBufferPath(home);
  }

  /** Persist a decision BEFORE dispatch (durable-first). Idempotent by decisionId. */
  enqueue(decision: OutboundDecision): void {
    const state = readState(this.path);
    if (state.pending.some((d) => d.decisionId === decision.decisionId)) return; // already durable
    state.pending.push(decision);
    writeState(this.path, state);
  }

  /** Ack-gated DRAIN: remove a decision only once the connector has Acked it. */
  ack(decisionId: string): void {
    const state = readState(this.path);
    const next = state.pending.filter((d) => d.decisionId !== decisionId);
    if (next.length !== state.pending.length) writeState(this.path, { pending: next });
  }

  /** The un-Acked decisions (restart-surviving) — what a re-dispatch replays on recovery. */
  pending(): OutboundDecision[] {
    return readState(this.path).pending;
  }
}
