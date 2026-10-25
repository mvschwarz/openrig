import type { ClaudeCompactionEnforcer, ObservedCompaction } from "./claude-compaction-enforcer.js";
import path from "node:path";
import { TerminalPolicyStore } from "./terminal-policy.js";
import type { RigRepository } from "./rig-repository.js";
import { deriveCanonicalFromEntry, getNodeInventory } from "./node-inventory.js";
import { parseSessionName } from "./session-name.js";
import type { NodeInventoryEntry, SeatIdentityVerdict } from "./types.js";
import { NativePermissionStore, type StoredNativePermissionSelection, type ResolvedSeatPermission } from "./native-permission-store.js";
import { AppliedLaunchObservationStore, type StoredAppliedLaunchObservation } from "./applied-launch-observation-store.js";
import { planPermissionAccount, type PermissionAccount } from "./permission-account.js";
import { RUNTIME_HOME_VAR, seatRuntimeHome, type HomeRuntime } from "./seat-runtime-home.js";

const SEAT_LOOKUP_GUIDANCE = "List seats with: rig ps --nodes";

export interface SeatStatus {
  compaction?: ObservedCompaction & { owedRestore: ReturnType<ClaudeCompactionEnforcer["getOwedRestore"]> };
  seat_ref: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  runtime: string | null;
  /** Configured cwd for future launches; an existing process can still use its old cwd. */
  launch_cwd: string | null;
  current_occupant: string | null;
  session_status: string | null;
  session_reason: SeatIdentityVerdict["reason"];
  startup_status: NodeInventoryEntry["startupStatus"];
  occupant_lifecycle: NodeInventoryEntry["occupantLifecycle"];
  continuity_outcome: NodeInventoryEntry["continuityOutcome"];
  handover_result: NodeInventoryEntry["handoverResult"];
  previous_occupant: string | null;
  handover_at: string | null;
  restore_outcome: NodeInventoryEntry["restoreOutcome"];
  /** Claude and Codex seats: the home (and with it the login) the seat's launches use. Configured, not proof of
   *  which login a running process holds. `ignored` is a declared value that isn't an absolute path. */
  runtime_home?: {
    variable: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
    home: string | null;
    source: "member" | "rig" | "daemon" | "native_default";
    ignored?: { source: "member" | "rig"; value: string };
  };
  terminalPolicy: ReturnType<TerminalPolicyStore["account"]> | { state: "unknown"; error: string };
  permissions: {
    selectionState: "explicit" | "inherit" | "unknown";
    desired: StoredNativePermissionSelection | null;
    lastLaunchArguments: StoredAppliedLaunchObservation | null;
    nativeEffect: "unverified";
    error?: string;
    effective?: ResolvedSeatPermission;
    /** The planned account for the next fresh managed launch (permission-account.ts); absent when it can't be read. */
    account?: PermissionAccount;
  };
}

export type SeatStatusResult =
  | { ok: true; status: SeatStatus }
  | { ok: false; code: "seat_ref_required" | "seat_not_found"; message: string; guidance: string }
  | { ok: false; code: "seat_ambiguous"; message: string; guidance: string; matches: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }> };

interface SeatMatch {
  entry: NodeInventoryEntry;
}

export class SeatStatusService {
  private rigRepo: RigRepository;
  private env: NodeJS.ProcessEnv;
  private compactionEnforcer?: Pick<ClaudeCompactionEnforcer, "recoverSeat" | "observedCompaction" | "getOwedRestore">;

  constructor(deps: { rigRepo: RigRepository; env?: NodeJS.ProcessEnv; compactionEnforcer?: SeatStatusService["compactionEnforcer"] }) {
    this.compactionEnforcer = deps.compactionEnforcer;
    this.rigRepo = deps.rigRepo;
    this.env = deps.env ?? process.env;
  }

  getStatus(seatRef: string): SeatStatusResult {
    const ref = seatRef.trim();
    if (!ref) {
      return { ok: false, code: "seat_ref_required", message: "seat reference is required", guidance: SEAT_LOOKUP_GUIDANCE };
    }

    const matches = this.findMatches(ref);
    if (matches.length === 0) {
      return { ok: false, code: "seat_not_found", message: `Seat "${ref}" not found`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "seat_ambiguous",
        message: `Seat "${ref}" matched multiple nodes`,
        guidance: SEAT_LOOKUP_GUIDANCE,
        matches: matches.map(({ entry }) => ({
          rig_name: entry.rigName,
          logical_id: entry.logicalId,
          current_occupant: entry.canonicalSessionName,
        })),
      };
    }

    return { ok: true, status: this.projectStatus(ref, matches[0]!.entry) };
  }

  private findMatches(ref: string): SeatMatch[] {
    // OPR.0.4.6.MH1 FR-8: the shared parse contract (greedy first-@ rig).
    const parsed = parseSessionName(ref);
    if (parsed.kind === "canonical") {
      const localRef = parsed.member;
      const rigName = parsed.rig;
      const rigs = this.rigRepo.findUnarchivedRigsByName(rigName);
      return rigs.flatMap((rig) => this.entriesForRig(rig.id).filter((entry) =>
        entry.canonicalSessionName === ref
        || deriveCanonicalFromEntry(entry) === ref
        || entry.logicalId === localRef
      ).map((entry) => ({ entry })));
    }

    return this.rigRepo.listRigs().flatMap((rig) =>
      this.entriesForRig(rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === ref
      ).map((entry) => ({ entry }))
    );
  }

  private entriesForRig(rigId: string): NodeInventoryEntry[] {
    return getNodeInventory(this.rigRepo.db, rigId);
  }

  private projectStatus(seatRef: string, entry: NodeInventoryEntry): SeatStatus {
    return {
      ...this.compactionStatus(entry),
      seat_ref: seatRef,
      rig_id: entry.rigId,
      rig_name: entry.rigName,
      logical_id: entry.logicalId,
      pod_id: entry.podId,
      pod_namespace: entry.podNamespace ?? null,
      runtime: entry.runtime,
      launch_cwd: entry.cwd,
      current_occupant: entry.canonicalSessionName,
      session_status: entry.sessionStatus,
      session_reason: entry.identityVerdict?.reason ?? null,
      startup_status: entry.startupStatus,
      occupant_lifecycle: entry.occupantLifecycle,
      continuity_outcome: entry.continuityOutcome,
      handover_result: entry.handoverResult,
      previous_occupant: entry.previousOccupant,
      handover_at: entry.handoverAt,
      restore_outcome: entry.restoreOutcome,
      ...this.runtimeHomeStatus(entry.nodeId, entry.runtime),
      permissions: this.permissionStatus(entry.nodeId, entry.runtime, entry.canonicalSessionName ?? deriveCanonicalFromEntry(entry) ?? seatRef),
      terminalPolicy: this.terminalPolicyStatus(entry.nodeId, entry.runtime),
    };
  }

  private compactionStatus(entry: NodeInventoryEntry): Pick<SeatStatus, "compaction"> {
    const enforcer = this.compactionEnforcer, session = entry.canonicalSessionName;
    if (!enforcer || entry.runtime !== "claude-code" || !session) return {};
    enforcer.recoverSeat({ sessionName: session, cwd: entry.cwd, runtime: entry.runtime });
    const observed = enforcer.observedCompaction(session);
    return observed ? { compaction: { ...observed, owedRestore: enforcer.getOwedRestore(session) } } : {};
  }

  private runtimeHomeStatus(nodeId: string, runtime: string | null): Pick<SeatStatus, "runtime_home"> {
    if (!runtime || !Object.hasOwn(RUNTIME_HOME_VAR, runtime)) return {};
    const variable = RUNTIME_HOME_VAR[runtime as HomeRuntime];
    const own = seatRuntimeHome(this.rigRepo.db, nodeId, runtime as HomeRuntime);
    const ignored = own.ignored ? { ignored: own.ignored } : {};
    if (own.home && own.source) return { runtime_home: { variable, home: own.home, source: own.source } };
    // The daemon's explicit value, as its launches pass it on; else the runtime's native default under HOME.
    const daemon = this.env[variable];
    if (daemon) return { runtime_home: { variable, home: daemon, source: "daemon", ...ignored } };
    const home = this.env.HOME;
    const native = home ? path.join(home, runtime === "codex" ? ".codex" : ".claude") : null;
    return { runtime_home: { variable, home: native, source: "native_default", ...ignored } };
  }

  private terminalPolicyStatus(nodeId: string, runtime: string | null): SeatStatus["terminalPolicy"] {
    try { return new TerminalPolicyStore(this.rigRepo.db).account(nodeId, runtime); }
    catch (error) { return { state: "unknown", error: (error as Error).message }; }
  }

  private permissionStatus(nodeId: string, runtime: string | null | undefined, seat: string): SeatStatus["permissions"] {
    const lastLaunchArguments = new AppliedLaunchObservationStore(this.rigRepo.db).readCurrent(nodeId);
    try {
      const store = new NativePermissionStore(this.rigRepo.db);
      const desired = store.read(nodeId);
      const effective = runtime ? store.resolve(nodeId, runtime) : undefined;
      const account = planPermissionAccount(this.rigRepo.db, nodeId, seat, runtime ?? null);
      return { selectionState: desired ? "explicit" : "inherit", desired, lastLaunchArguments, nativeEffect: "unverified", ...(effective ? { effective } : {}), account };
    } catch (error) {
      return { selectionState: "unknown", desired: null, lastLaunchArguments, nativeEffect: "unverified", error: (error as Error).message };
    }
  }
}
