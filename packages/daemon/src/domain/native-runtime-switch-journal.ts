import type Database from "better-sqlite3";
import { nextNativeRuntimeExchangeStep, type NativeExchangeIdentity, type NativeExchangeSlot } from "./native-runtime-switch-exchange.js";

export interface NativeExchangeRecord {
  schema: "openrig.native-runtime-exchange/v1";
  identity: NativeExchangeIdentity;
  direction: "forward" | "rollback";
}

/** Custody stays in the existing switch row. A fresh coordinator can recover it
 * without an in-memory rename count; unrelated plan fields remain intact. */
export class NativeRuntimeSwitchJournal {
  constructor(private readonly db: Database.Database, private readonly switchId: string, private readonly nodeId: string) {}

  read(): NativeExchangeRecord | null {
    const row = this.db.prepare(`SELECT node_id, canonical_session, staging_session, predecessor_generation,
      successor_generation, plan_json FROM seat_runtime_switches WHERE id = ?`).get(this.switchId) as {
        node_id: string; canonical_session: string; staging_session: string; predecessor_generation: string; successor_generation: string; plan_json: string;
      } | undefined;
    if (!row || row.node_id !== this.nodeId) throw new Error("Native exchange record is outside this node's custody");
    const record = (JSON.parse(row.plan_json) as { nativeExchange?: NativeExchangeRecord }).nativeExchange;
    if (record === undefined) return null;
    if (record?.schema !== "openrig.native-runtime-exchange/v1" || !record.identity || !["forward", "rollback"].includes(record.direction)
      || record.identity.canonical !== row.canonical_session || record.identity.staging !== row.staging_session
      || record.identity.predecessorGeneration !== row.predecessor_generation || record.identity.successorGeneration !== row.successor_generation) {
      throw new Error("Invalid native runtime exchange record");
    }
    return record;
  }

  prepare(identity: NativeExchangeIdentity, direction: NativeExchangeRecord["direction"]): NativeExchangeRecord {
    const initial = nextNativeRuntimeExchangeStep(identity, {
      canonical: { state: "present", generation: identity.predecessorGeneration },
      staging: { state: "present", generation: identity.successorGeneration }, parking: { state: "absent" },
    }, "forward");
    if (initial.state !== "rename") throw new Error("Invalid native runtime exchange identities");
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT node_id, canonical_session, staging_session, predecessor_generation,
        successor_generation, phase, committed_at, plan_json FROM seat_runtime_switches WHERE id = ?`).get(this.switchId) as {
          node_id: string; canonical_session: string; staging_session: string; predecessor_generation: string;
          successor_generation: string; phase: string; committed_at: string | null; plan_json: string;
        } | undefined;
      if (!row || row.node_id !== this.nodeId || row.canonical_session !== identity.canonical || row.staging_session !== identity.staging
        || row.predecessor_generation !== identity.predecessorGeneration || row.successor_generation !== identity.successorGeneration
        || !(["confirmed", "committed"].includes(row.phase) || (row.phase === "abandoned" && direction === "rollback" && !row.committed_at))
        || (direction === "rollback" && row.committed_at)) {
        throw new Error("The native runtime exchange does not match the switch's custody or commit state");
      }
      const plan: unknown = JSON.parse(row.plan_json);
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Invalid runtime-switch plan record");
      const object = plan as Record<string, unknown>;
      const previous = object.nativeExchange as NativeExchangeRecord | undefined;
      if (previous && (previous.schema !== "openrig.native-runtime-exchange/v1" || !previous.identity
        || (Object.keys(identity) as Array<keyof NativeExchangeIdentity>).some(key => previous.identity[key] !== identity[key]))) {
        throw new Error("Native runtime exchange custody already names another identity");
      }
      const record: NativeExchangeRecord = { schema: "openrig.native-runtime-exchange/v1", identity: { ...identity }, direction };
      object.nativeExchange = record;
      this.db.prepare("UPDATE seat_runtime_switches SET plan_json = ? WHERE id = ? AND node_id = ?")
        .run(JSON.stringify(object), this.switchId, this.nodeId);
      return record;
    })();
  }
}

export interface NativeExchangeTerminal {
  ownsLifecycle(): boolean;
  observe(): Promise<{ canonical: NativeExchangeSlot; staging: NativeExchangeSlot; parking: NativeExchangeSlot }>;
  /** The backend must verify source occupant identity at the rename boundary. */
  rename(from: string, to: string, expectedGeneration: string): Promise<void>;
}

/** A thrown/uncertain rename stops this invocation. The next invocation persists
 * its intended direction and reobserves the slots instead of replaying a write.
 * The caller must retain both servers when this reports pending. */
export async function executeNativeRuntimeExchange(
  journal: NativeRuntimeSwitchJournal,
  terminal: NativeExchangeTerminal,
  identity: NativeExchangeIdentity,
  direction: NativeExchangeRecord["direction"],
): Promise<{ ok: true } | { ok: false; pending: true; message: string }> {
  try {
    if (!terminal.ownsLifecycle()) throw new Error("Native runtime exchange requires its lifecycle lease");
    journal.prepare(identity, direction);
    for (let count = 0; count < 4; count++) {
      if (!terminal.ownsLifecycle()) throw new Error("Native runtime exchange lifecycle lease was lost");
      const slots = await terminal.observe();
      const step = nextNativeRuntimeExchangeStep(identity, slots, direction);
      if (step.state === "complete") return { ok: true };
      if (step.state === "blocked") throw new Error(step.reason);
      const source = step.from === identity.canonical ? slots.canonical : step.from === identity.staging ? slots.staging : slots.parking;
      if (source.state !== "present") throw new Error("Native exchange source identity is unavailable");
      if (!terminal.ownsLifecycle()) throw new Error("Native runtime exchange lifecycle lease was lost");
      await terminal.rename(step.from, step.to, source.generation);
    }
    throw new Error("Native exchange did not reach an observed completed state");
  } catch (error) {
    return { ok: false, pending: true, message: error instanceof Error ? error.message : String(error) };
  }
}
