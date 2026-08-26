import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter, SessionProbe } from "../adapters/tmux.js";
import type { NodeInventoryEntry, PersistedEvent } from "./types.js";
import { getNodeInventory } from "./node-inventory.js";
import { parseSessionName } from "./session-name.js";

/**
 * S5 (OPR.0.5.4.7) — the seat-lifecycle verb surface: set-model, single-seat stop,
 * dead-session clean. One coherent design (KI-5.3-9):
 *
 *   - ONE seat-resolution path shared by all three verbs (the SeatStatusService
 *     findMatches semantics: parseSessionName greedy first-@ rig; canonical-name or
 *     logical-id match; ambiguity returns the match list) — never a per-verb resolver.
 *   - Every mutation is transactional and persists its audit event in the SAME
 *     transaction (node.model_changed / session.stopped / session.cleaned).
 *   - Every refusal names what was actually checked; an indeterminate tmux probe is
 *     a refusal, never a guess (the S1 error bar applied at birth).
 */

const SEAT_LOOKUP_GUIDANCE = "List seats with: rig ps --nodes";

/** Terminal session statuses — rows the clean verb must NOT touch (they already
 *  record an ended tenancy; the vocabulary is shared with seat-handover-service
 *  and the watchdog's TERMINAL_SESSION_STATUSES). */
const TERMINAL_SESSION_STATUSES = new Set(["superseded", "detached", "exited"]);

export interface SeatLifecycleDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
}

interface ResolvedSeat {
  entry: NodeInventoryEntry;
  nodeId: string;
}

export interface SeatRefusal {
  ok: false;
  code:
    | "seat_ref_required"
    | "seat_not_found"
    | "seat_ambiguous"
    | "missing_model"
    | "missing_reason"
    | "no_session"
    | "claimed_session"
    | "session_not_live"
    | "session_live"
    | "tmux_probe_failed"
    | "nothing_to_clean";
  message: string;
  guidance?: string;
  matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
}

export interface SeatDescriptor {
  rigId: string;
  rigName: string;
  logicalId: string;
  nodeId: string;
}

export type SetModelResult =
  | { ok: true; seat: SeatDescriptor; from: string | null; to: string; changed: boolean }
  | SeatRefusal;

export type StopSeatResult =
  | { ok: true; seat: SeatDescriptor; sessionName: string; sessionId: string }
  | SeatRefusal;

export type CleanSeatResult =
  | { ok: true; seat: SeatDescriptor; actions: { sessionsExited: string[]; bindingCleared: boolean } }
  | SeatRefusal;

interface LatestSessionRow {
  id: string;
  session_name: string;
  status: string;
  origin: string;
}

export class SeatLifecycleService {
  private readonly db: Database.Database;
  private readonly rigRepo: RigRepository;
  private readonly sessionRegistry: SessionRegistry;
  private readonly eventBus: EventBus;
  private readonly tmuxAdapter: TmuxAdapter;

  constructor(deps: SeatLifecycleDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatLifecycleService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatLifecycleService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatLifecycleService: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async setModel(input: { seatRef: string; model: string; reason: string; operator?: string | null }): Promise<SetModelResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (!input.model?.trim()) {
      return { ok: false, code: "missing_model", message: "A target model id is required (--model)." };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;

    const model = input.model.trim();
    const seat = this.describe(resolved);
    const from = resolved.entry.model ?? null;
    if (from === model) {
      // Honest no-op: the persisted value already IS the target; no event is minted.
      return { ok: true, seat, from, to: model, changed: false };
    }

    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.rigRepo.setNodeModel(resolved.nodeId, model);
      persisted = this.eventBus.persistWithinTransaction({
        type: "node.model_changed",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        logicalId: seat.logicalId,
        from,
        to: model,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, from, to: model, changed: true };
  }

  async stopSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<StopSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);

    const session = this.latestSession(resolved.nodeId);
    if (!session) {
      return { ok: false, code: "no_session", message: `Seat "${input.seatRef}" has no session to stop (checked: latest sessions row for node ${seat.logicalId}).` };
    }
    if (session.origin === "claimed") {
      return {
        ok: false,
        code: "claimed_session",
        message: `Session "${session.session_name}" was adopted (origin=claimed), not launched by OpenRig — stop refuses to kill it.`,
        guidance: "Release an adopted session with: rig unclaim",
      };
    }

    // Wave-2 fix round 1 (r1 row 9baac99f): consume the CLASSIFIED probe, never the
    // collapsed hasSession view — a transport blip is INDETERMINATE, not absence
    // (KI-5.3-8 fabricated-absence class, destructive direction).
    const probed = await this.probeLiveness(session.session_name, "stop refuses rather than kill blind");
    if ("code" in probed) return probed;
    if (probed.state === "absent") {
      return {
        ok: false,
        code: "session_not_live",
        message: `Session "${session.session_name}" is absent in tmux (checked: tmux has-session, POSITIVE absence evidence) — there is nothing to stop.`,
        guidance: "A dead seat with stale records is returned to launchable with: rig seat clean",
      };
    }

    // Kill exactly this seat's own tmux session — structurally single-seat.
    const kill = await this.tmuxAdapter.killSession(session.session_name);
    if (kill && !kill.ok && kill.code !== "session_not_found") {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `tmux kill-session for "${session.session_name}" failed: ${kill.message ?? kill.code}`,
      };
    }

    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.sessionRegistry.updateStatus(session.id, "exited");
      this.sessionRegistry.clearBinding(resolved.nodeId);
      persisted = this.eventBus.persistWithinTransaction({
        type: "session.stopped",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: session.session_name,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, sessionName: session.session_name, sessionId: session.id };
  }

  async cleanSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<CleanSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);

    const binding = this.sessionRegistry.getBindingForNode(resolved.nodeId);
    const nonTerminal = (this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY id",
    ).all(resolved.nodeId) as LatestSessionRow[])
      .filter((s) => !TERMINAL_SESSION_STATUSES.has(s.status));

    // Fix r2-F3 (row 30045f39): clean MUTATES every non-terminal session row, so
    // its safety checks must cover exactly that set — probing only the newest row
    // fabricates safety for the others (older-live/newer-dead under canonical-name
    // churn). Every row that would be touched is checked for adopted origin and
    // probed for POSITIVE absence (r1 discipline); the binding's own tmux session
    // is probed too when it names a session no row carries.
    const mutationTargets = nonTerminal;
    for (const row of mutationTargets) {
      if (row.origin === "claimed") {
        return {
          ok: false,
          code: "claimed_session",
          message: `Session "${row.session_name}" was adopted (origin=claimed) — clean refuses to touch adopted state.`,
          guidance: "Release an adopted session with: rig unclaim",
        };
      }
    }
    const probeNames = [...new Set([
      ...mutationTargets.map((s) => s.session_name),
      ...(binding?.tmuxSession ? [binding.tmuxSession] : []),
    ])];
    for (const name of probeNames) {
      const probed = await this.probeLiveness(name, "clean refuses rather than clear state under a possibly-live seat");
      if ("code" in probed) return probed;
      if (probed.state === "present") {
        return {
          ok: false,
          code: "session_live",
          message: `Session "${name}" is alive in tmux (checked: tmux has-session, against EVERY session row clean would mutate) — clean only operates on dead seats.`,
          guidance: "Stop a live seat first with: rig seat stop",
        };
      }
    }
    const session = this.latestSession(resolved.nodeId);

    if (!binding && nonTerminal.length === 0) {
      return {
        ok: false,
        code: "nothing_to_clean",
        message: `Seat "${input.seatRef}" is already clean (checked: no binding row for the node, and no session rows outside terminal statuses ${[...TERMINAL_SESSION_STATUSES].join("/")}).`,
      };
    }

    const sessionsExited: string[] = [];
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      for (const row of nonTerminal) {
        this.sessionRegistry.updateStatus(row.id, "exited");
        sessionsExited.push(row.session_name);
      }
      this.sessionRegistry.clearBinding(resolved.nodeId);
      persisted = this.eventBus.persistWithinTransaction({
        type: "session.cleaned",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: session?.session_name ?? null,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        actions: { sessionsExited, bindingCleared: binding !== null },
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, actions: { sessionsExited, bindingCleared: binding !== null } };
  }

  // -- shared internals --

  /**
   * The ONE liveness read both mutating verbs share (fix r1, row 9baac99f):
   * the CLASSIFIED probeSession, never the collapsed hasSession view.
   *   present / absent        → returned for the verb to act on (absent is
   *                             POSITIVE tmux evidence, per OPR.0.5.4.2).
   *   transport_unavailable   → an INDETERMINATE refusal: session existence was
   *                             NOT determined, so neither verb may act — and the
   *                             refusal never routes the operator to a
   *                             destructive verb.
   *   unexpected probe throw  → the same indeterminate refusal (fail closed).
   */
  private async probeLiveness(
    sessionName: string,
    refusalConsequence: string,
  ): Promise<{ state: "present" | "absent" } | SeatRefusal> {
    let probe: SessionProbe;
    try {
      probe = await this.tmuxAdapter.probeSession(sessionName);
    } catch (err) {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `tmux liveness probe for "${sessionName}" failed (${err instanceof Error ? err.message : String(err)}) — liveness is INDETERMINATE, so ${refusalConsequence}.`,
      };
    }
    if (probe.state === "transport_unavailable") {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `tmux transport unavailable probing "${sessionName}" (${probe.cause}) — session existence was NOT determined (checked: classified tmux probe), so ${refusalConsequence}. Retry when the tmux transport is back.`,
      };
    }
    return { state: probe.state };
  }

  private requireReason(reason: string): SeatRefusal | null {
    if (!reason?.trim()) {
      return { ok: false, code: "missing_reason", message: "An audit reason is required (--reason)." };
    }
    return null;
  }

  private describe(resolved: ResolvedSeat): SeatDescriptor {
    return {
      rigId: resolved.entry.rigId,
      rigName: resolved.entry.rigName,
      logicalId: resolved.entry.logicalId,
      nodeId: resolved.nodeId,
    };
  }

  private latestSession(nodeId: string): LatestSessionRow | null {
    const row = this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1",
    ).get(nodeId) as LatestSessionRow | undefined;
    return row ?? null;
  }

  /** The ONE resolution path, mirroring SeatStatusService.findMatches semantics
   *  (seat-status-service.ts) so every seat verb resolves identically: a canonical
   *  `name@rig` ref scopes to that rig's inventory; a bare ref scans all rigs;
   *  matches are by canonicalSessionName or logicalId; >1 match is a listed
   *  ambiguity, never a pick. */
  private resolveSeat(seatRef: string): ResolvedSeat | SeatRefusal {
    const ref = seatRef?.trim() ?? "";
    if (!ref) {
      return { ok: false, code: "seat_ref_required", message: "seat reference is required", guidance: SEAT_LOOKUP_GUIDANCE };
    }

    const matches = this.findMatches(ref);
    if (matches.length === 0) {
      return {
        ok: false,
        code: "seat_not_found",
        message: `Seat "${ref}" not found (checked: canonical session names and logical ids across ${parseSessionName(ref).kind === "canonical" ? "the named rig" : "all rigs"}).`,
        guidance: SEAT_LOOKUP_GUIDANCE,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "seat_ambiguous",
        message: `Seat "${ref}" matched multiple nodes`,
        guidance: SEAT_LOOKUP_GUIDANCE,
        matches: matches.map((entry) => ({
          rig_name: entry.rigName,
          logical_id: entry.logicalId,
          current_occupant: entry.canonicalSessionName,
        })),
      };
    }

    const entry = matches[0]!;
    const nodeRow = this.db.prepare(
      "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?",
    ).get(entry.rigId, entry.logicalId) as { id: string } | undefined;
    if (!nodeRow) {
      return { ok: false, code: "seat_not_found", message: `Seat "${ref}" resolved to a node that no longer exists.`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    return { entry, nodeId: nodeRow.id };
  }

  private findMatches(ref: string): NodeInventoryEntry[] {
    const parsed = parseSessionName(ref);
    if (parsed.kind === "canonical") {
      const localRef = parsed.member;
      const rigs = this.rigRepo.findRigsByName(parsed.rig);
      return rigs.flatMap((rig) => getNodeInventory(this.db, rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === localRef,
      ));
    }
    return this.rigRepo.listRigs().flatMap((rig) =>
      getNodeInventory(this.db, rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === ref,
      ),
    );
  }
}
