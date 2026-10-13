import path from "node:path";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { SeatStatusService } from "./seat-status-service.js";
import { SeatLifecycleService } from "./seat-lifecycle-service.js";
import { SuccessorSessionLauncher } from "./successor-session-launcher.js";
import { buildRestorePacket, type PredecessorRecapResolver } from "./seat-handover-service.js";
import { NativePermissionStore } from "./native-permission-store.js";
import { validateNativePermissionSelection, type NativePermissionSelection } from "./native-permission-selection.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { validateResumeToken } from "./resume-token-validation.js";
import { SnapshotCapture } from "./snapshot-capture.js";
import { SnapshotRepository } from "./snapshot-repository.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { planRuntimeSwitchMaterials } from "./runtime-switch-materials.js";
import { recoverRuntimeSwitch, type RuntimeSwitchIntent } from "./runtime-switch-recovery.js";
import type { PersistedEvent } from "./types.js";

export interface SeatRuntimeSwitchDeps {
  db: Database.Database; rigRepo: RigRepository; sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository; eventBus: EventBus; tmuxAdapter: TmuxAdapter;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  sessionEnv?: Record<string, string | undefined>;
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  occupantInvalidator?: OccupantInvalidator;
  activityOracle?: { declareOccupantSwap(nodeId: string, generation: string): void };
  predecessorRecapResolver?: PredecessorRecapResolver;
  authoredRecapResolver?: (seat: string) => { address: string; chainLength: number } | { absentReason: string };
  materialContext?: Parameters<typeof planRuntimeSwitchMaterials>[0]["materialContext"];
  readinessTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SeatRuntimeSwitchInput {
  seatRef: string; runtime: string; reason: string; operator?: string | null; dryRun?: boolean;
  model?: string; effort?: string; codexConfigProfile?: string; permissionMode?: string;
}

export type SeatRuntimeSwitchResult =
  | { ok: false; code: string; message: string; guidance?: string; recoveryPending?: boolean }
  | { ok: true; changed: boolean; dryRun: boolean; seat: { ref: string; nodeId: string; rigId: string };
      from: string; to: string; settings?: { model: string | null; effort: string | null; codexConfigProfile: string | null; permissionMode: string };
      sessionName: string; sessionId?: string; generation?: string; openQueueItems?: number;
      recoveryPending: boolean; warnings?: string[] };

/** A live seat keeps its logical id, graph edges, queue address and canonical
 * tmux session. Only its pane, native conversation and occupant tenure change. */
export class SeatRuntimeSwitchService {
  constructor(private readonly deps: SeatRuntimeSwitchDeps) {
    for (const owner of [deps.rigRepo, deps.sessionRegistry, deps.discoveryRepo, deps.eventBus]) {
      if (owner.db !== deps.db) throw new Error("Runtime switch dependencies must share one database.");
    }
  }

  async setRuntime(input: SeatRuntimeSwitchInput): Promise<SeatRuntimeSwitchResult> {
    input = { ...input };
    const fail = (code: string, message: string): SeatRuntimeSwitchResult => ({ ok: false, code, message });
    if (input.runtime !== "codex" && input.runtime !== "claude-code") return fail("invalid_runtime", "Choose --runtime codex or claude-code.");
    if (!input.reason?.trim()) return fail("missing_reason", "Provide --reason for the runtime change.");
    for (const key of ["model", "effort", "codexConfigProfile", "permissionMode"] as const) {
      if (input[key] !== undefined && (!input[key]!.trim() || /[\r\n\0]/.test(input[key]!))) return fail("invalid_runtime_settings", `${key} must be a non-empty single-line value.`);
      if (input[key]) input[key] = input[key]!.trim();
    }
    if (input.runtime !== "codex" && input.codexConfigProfile) return fail("invalid_runtime_settings", "--codex-config-profile applies only to Codex.");
    const { db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus } = this.deps;
    const status = new SeatStatusService({ rigRepo }).getStatus(input.seatRef);
    if (!status.ok) return status;
    const node = rigRepo.getRig(status.status.rig_id)!.nodes.find(node => node.logicalId === status.status.logical_id)!;
    const guard = tmux.deliveryGuard;
    if (!input.dryRun && guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.setRuntime(input));
    }
    const seat = { ref: `${node.logicalId}@${status.status.rig_name}`, nodeId: node.id, rigId: node.rigId };
    const pending = db.prepare("SELECT * FROM seat_runtime_switches WHERE node_id=?").get(node.id) as RuntimeSwitchIntent | undefined;
    if (pending) {
      if (input.dryRun) return fail("runtime_switch_pending", "A prior runtime switch needs recovery before another can be planned.");
      const recovered = await recoverRuntimeSwitch(db, tmux, pending, this.deps.runtimeAdapters, this.deps.sleep);
      if (!recovered.complete) return { ok: false, code: "runtime_switch_pending", message: recovered.message!, recoveryPending: true };
      return this.setRuntime(input);
    }
    const binding = sessionRegistry.getBindingForNode(node.id);
    const sessionName = binding?.tmuxSession;
    if (node.runtime !== "codex" && node.runtime !== "claude-code") return fail("unsupported_source_runtime", "Runtime switching supports existing Codex and Claude Code seats.");
    if (node.runtime === input.runtime) {
      if (input.model || input.effort || input.codexConfigProfile || input.permissionMode) return fail("runtime_unchanged", "The seat already uses that runtime. Use the existing seat setting commands for changes within one runtime.");
      return { ok: true, changed: false, dryRun: !!input.dryRun, seat, from: node.runtime, to: node.runtime, sessionName: sessionName ?? "", recoveryPending: false };
    }
    const generation = sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;
    const session = sessionRegistry.getSessionsForRig(node.rigId).filter(session => session.nodeId === node.id && session.status === "running");
    if (!sessionName || !binding?.tmuxPane || !generation || session.length !== 1 || session[0]!.sessionName !== sessionName
      || (binding.attachmentType && binding.attachmentType !== "tmux") || !node.cwd || !path.isAbsolute(node.cwd)) {
      return fail("current_occupant_required", "Runtime switching requires one current managed tmux occupant, its generation, and an absolute cwd.");
    }
    if (!this.deps.runtimeAdapters?.[input.runtime]) return fail("runtime_unavailable", "The target runtime adapter is unavailable on this daemon.");
    const permissions = new NativePermissionStore(db);
    let oldSelection: NativePermissionSelection | null;
    let selection: NativePermissionSelection | null = null;
    try {
      oldSelection = permissions.read(node.id);
      const mode = input.permissionMode ?? "inherit";
      if (mode !== "inherit") {
        selection = input.runtime === "claude-code" && !["floor", "full_bypass"].includes(mode)
          ? /^[A-Za-z][A-Za-z0-9_]*$/.test(mode) ? { runtime: "claude-code", mode } : (() => { throw new Error("Invalid native permission mode."); })()
          : validateNativePermissionSelection(input.runtime, mode);
      }
    } catch (error) { return fail("invalid_runtime_settings", (error as Error).message); }
    const codexConfigProfile = input.codexConfigProfile ?? null;
    let materials: ReturnType<typeof planRuntimeSwitchMaterials>;
    try {
      const saved = new SeatLifecycleService(this.deps).readStartupContext(node.id, node.cwd);
      if (!saved.ok && node.agentRef) return saved.refusal;
      materials = planRuntimeSwitchMaterials({ db, node, rigName: status.status.rig_name, session: sessionName, runtime: input.runtime,
        model: input.model, effort: input.effort, saved: saved.ok ? saved.context : null,
        claudeManagedBlockFile: rigRepo.getRigClaudeManagedBlockFile(node.rigId) ?? undefined, materialContext: this.deps.materialContext });
    } catch (error) { return fail("runtime_materials_unavailable", (error as Error).message); }
    const settings = { model: materials.model, effort: materials.effort, codexConfigProfile, permissionMode: input.permissionMode ?? "inherit" };
    const base = { seat, from: node.runtime, to: input.runtime, settings, sessionName };
    if (input.dryRun) return { ok: true, changed: false, dryRun: true, ...base, recoveryPending: false };

    const snapshot = () => JSON.stringify({
      node: rigRepo.getRig(node.rigId)?.nodes.find(value => value.id === node.id),
      binding: sessionRegistry.getBindingForNode(node.id), generation: sessionRegistry.currentOccupantTenure(node.id)?.generationUuid,
      selection: permissions.read(node.id),
      startup: db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id),
      nodePolicy: rigRepo.getNodePolicyProvenance(node.id), rigPolicy: rigRepo.getRigPolicyProvenance(node.rigId),
      nonInterruptive: rigRepo.getRigNonInterruptive(node.rigId), managedBlock: rigRepo.getRigClaudeManagedBlockFile(node.rigId),
    });
    const expected = snapshot();
    const assertCurrent = () => {
      if (snapshot() !== expected) throw new Error("Seat settings or ownership changed during runtime startup; no configuration was overwritten.");
      if (db.prepare("SELECT 1 FROM bindings WHERE node_id<>? AND (tmux_session=? OR tmux_pane=?)").get(node.id, intent.staging_session, intent.successor_pane)
        || db.prepare("SELECT 1 FROM sessions WHERE node_id<>? AND session_name=? AND status='running'").get(node.id, intent.staging_session)) {
        throw new Error("The staging successor was claimed by another seat; no configuration was overwritten.");
      }
    };
    const successorGeneration = sessionRegistry.reserveOccupantGeneration();
    if (!successorGeneration) return fail("generation_unavailable", "A successor generation is required before starting a runtime switch.");
    const id = ulid();
    const intent: RuntimeSwitchIntent = { id, node_id: node.id, canonical_session: sessionName, staging_session: `openrig-switch-${id.toLowerCase()}`,
      predecessor_pane: binding.tmuxPane, successor_pane: null, predecessor_generation: generation, successor_generation: successorGeneration,
      from_runtime: node.runtime, to_runtime: input.runtime, phase: "preparing" };
    let journaled = false;
    let committed = false;
    let sessionId: string | undefined;
    let openQueueItems = 0;
    try {
      const panes = await tmux.listPanes(sessionName);
      if ((await tmux.listWindows(sessionName)).length !== 1 || panes.length !== 1 || panes[0]!.id !== binding.tmuxPane) {
        throw new Error("Runtime switching requires a single-window, single-pane seat matching its binding.");
      }
      // Capture native history before a target runtime can publish same-seat telemetry.
      const screen = await tmux.capturePaneScreen(sessionName).catch(() => null);
      const recap = this.deps.predecessorRecapResolver?.({ nodeId: node.id, runtime: node.runtime, sessionName });
      const authored = this.deps.authoredRecapResolver?.(seat.ref);
      assertCurrent();
      db.prepare(`INSERT INTO seat_runtime_switches (id,node_id,canonical_session,staging_session,predecessor_pane,
        predecessor_generation,successor_generation,from_runtime,to_runtime) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, node.id, sessionName, intent.staging_session, binding.tmuxPane, generation, successorGeneration, node.runtime, input.runtime);
      journaled = true;
      const override = permissions.launchOverride(node.id, input.runtime, { selection, codexProfile: codexConfigProfile });
      const posture = override.launchPosture ?? rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
        ?? rigRepo.getRigPolicyProvenance(node.rigId)?.launchPosture ?? "floor";
      const launcher = new SuccessorSessionLauncher(tmux, this.deps.discoveryRepo, {
        sessionEnv: this.deps.sessionEnv, runtimeSessionEnv: this.deps.runtimeSessionEnv, runtimeAdapters: this.deps.runtimeAdapters,
        tmuxOptionDefaults: this.deps.tmuxOptionDefaults, readinessTimeoutMs: this.deps.readinessTimeoutMs, sleep: this.deps.sleep,
      });
      const launch = await launcher.stageSuccessor({ stagingSession: intent.staging_session, canonicalSession: sessionName, occupantGeneration: successorGeneration,
        node: { id: node.id, runtime: input.runtime, cwd: node.cwd, model: materials.model, effort: materials.effort, codexConfigProfile,
          ...override, launchPosture: posture === "auto" && input.runtime === "codex" ? "floor" : posture,
          permissionMode: override.permissionMode ?? (posture === "auto" && input.runtime === "claude-code" ? "auto" : undefined),
          nonInterruptive: rigRepo.getRigNonInterruptive(node.rigId), claudeManagedBlockFile: rigRepo.getRigClaudeManagedBlockFile(node.rigId) ?? undefined,
          runtimeSwitchFrom: { runtime: node.runtime, session: sessionName, pane: binding.tmuxPane, generation } },
        onPaneCreated: pane => { intent.successor_pane = pane; db.prepare("UPDATE seat_runtime_switches SET successor_pane=? WHERE id=?").run(pane, id); },
        prepare: async (binding, adapter) => { assertCurrent(); await materials.prepare(binding, adapter); assertCurrent(); },
      });
      if (!launch.ok) throw new Error(launch.message);
      assertCurrent();
      const queue = db.prepare("SELECT qitem_id,state,priority,source_session FROM queue_items WHERE destination_session=? AND state IN ('pending','in-progress','blocked') ORDER BY ts_created,qitem_id")
        .all(sessionName) as Array<{ qitem_id: string; state: string; priority: string; source_session: string }>;
      openQueueItems = queue.length;
      const packet = [
        `You are the staged ${input.runtime} successor of ${seat.ref}. Generation: ${successorGeneration}.`,
        "Read this handover context and wait for the OpenRig activation reminder. Do not start work or mutate the queue yet: the incumbent still owns the seat and your mutations will be refused until commit.",
        buildRestorePacket({ seatRef: seat.ref, reason: input.reason.trim(), departingSession: sessionName, handoverAt: new Date().toISOString(), capturedContext: screen ?? "",
          ...(recap && "recap" in recap ? recap : { recapUnavailableReason: recap?.unavailableReason ?? "no provider recap available" }),
          ...(authored ? "address" in authored ? { authoredRecap: authored } : { authoredRecapAbsentReason: authored.absentReason } : {}) }),
        materials.context,
        `Open queue responsibility (${queue.length} active items, existing claims retained):`,
        ...queue.slice(0, 100).map(item => `${item.qitem_id}: ${item.state}, ${item.priority}, from ${item.source_session}`),
        "After activation, refresh rig queue list --owned --full. The queue is authoritative; this bounded snapshot can change while the incumbent finishes.",
      ].filter(Boolean).join("\n\n");
      const sent = await tmux.sendText(intent.staging_session, packet);
      if (!sent.ok) throw new Error(sent.message);
      await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(200);
      const submit = await tmux.sendKeys(intent.staging_session, ["Enter"]);
      if (!submit.ok) throw new Error(submit.message);
      assertCurrent();
      const swapped = await tmux.swapRuntimeSwitchPanes({ nodeId: node.id, session: intent.staging_session,
        canonicalSession: sessionName, canonicalPane: binding.tmuxPane, stagedPane: launch.tmuxPane });
      if (!swapped.ok) throw new Error(swapped.message);
      const notifications: PersistedEvent[] = [];
      const afterCommit: Array<() => void> = [];
      const event = db.transaction(() => {
        assertCurrent();
        db.prepare("UPDATE nodes SET runtime=?, model=?, effort=?, codex_config_profile=?, session_source_json=NULL, occupant_lifecycle='active', continuity_outcome='rebuilt', handover_result='complete', previous_occupant=?, handover_at=? WHERE id=?")
          .run(input.runtime, materials.model, materials.effort, codexConfigProfile, sessionName, new Date().toISOString(), node.id);
        permissions.write(node.id, selection, input.operator?.trim() || sessionName, input.reason.trim());
        db.prepare("INSERT OR REPLACE INTO node_startup_context (node_id,projection_entries_json,resolved_files_json,startup_actions_json,runtime) VALUES (?,?,?,?,?)")
          .run(node.id, JSON.stringify(materials.plan.entries), JSON.stringify(materials.files), JSON.stringify(materials.actions), input.runtime);
        db.prepare("UPDATE sessions SET status='superseded' WHERE node_id=? AND status NOT IN ('superseded','detached','exited')").run(node.id);
        db.prepare("UPDATE bindings SET tmux_pane=?, tmux_window=NULL, updated_at=datetime('now') WHERE node_id=?").run(launch.tmuxPane, node.id);
        const successor = sessionRegistry.registerClaimedSession(node.id, sessionName, "handover", successorGeneration);
        if (sessionRegistry.currentOccupantTenure(node.id)?.generationUuid !== successorGeneration) throw new Error("Successor generation could not be committed.");
        sessionId = successor.id;
        db.prepare("UPDATE sessions SET origin='launched', restore_policy=? WHERE id=?").run(session[0]!.restorePolicy ?? node.restorePolicy, sessionId);
        const stagedIdentity = db.prepare("SELECT successor_resume_token FROM seat_runtime_switches WHERE id=?").get(id) as { successor_resume_token: string | null };
        const nativeId = stagedIdentity.successor_resume_token ?? launch.resumeToken;
        if (nativeId) {
          const token = validateResumeToken(input.runtime, nativeId);
          if (token.ok) sessionRegistry.updateResumeToken(sessionId, token.resumeType, token.token, stagedIdentity.successor_resume_token ? "hook" : "scrape");
        }
        const observations = new AppliedLaunchObservationStore(db);
        observations.invalidateGeneration(generation);
        if (launch.appliedLaunch) observations.recordGeneration(successorGeneration, launch.appliedLaunch);
        // These claims belong to the same durable seat. Transfer their tenure
        // before ordinary handover invalidation can release retired claims.
        db.prepare("UPDATE queue_items SET claimed_by_generation_uuid=? WHERE destination_session=? AND claimed_by_generation_uuid=? AND state='in-progress'")
          .run(successorGeneration, sessionName, generation);
        this.deps.occupantInvalidator?.invalidateRetiringOccupant({ retiringSessionName: sessionName, successorSessionName: sessionName,
          retiringGeneration: generation, deferInMemory: invalidate => afterCommit.push(invalidate) });
        db.prepare("UPDATE discovered_sessions SET status='vanished', claimed_node_id=NULL WHERE claimed_node_id=? OR (tmux_session=? AND tmux_pane=?)")
          .run(node.id, intent.staging_session, launch.tmuxPane);
        const discovered = this.deps.discoveryRepo.upsertDiscoveredSession({ tmuxSession: sessionName, tmuxPane: launch.tmuxPane,
          cwd: node.cwd!, runtimeHint: input.runtime as "codex" | "claude-code", confidence: "high" });
        this.deps.discoveryRepo.markClaimed(discovered.id, node.id);
        db.prepare("UPDATE seat_runtime_switches SET phase='committed' WHERE id=?").run(id);
        // The newest default restore must describe the target runtime, even if
        // the daemon stops immediately after the configuration transaction.
        new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) })
          .captureSnapshot(node.rigId, "runtime-switch", { deferNotify: event => notifications.push(event) });
        return eventBus.persistWithinTransaction({ type: "seat.runtime_changed", rigId: node.rigId, nodeId: node.id,
          from: node.runtime!, to: input.runtime, reason: input.reason.trim(), operator: input.operator ?? null,
          generation: successorGeneration, previousGeneration: generation, resetPermissionSelection: oldSelection !== null });
      })();
      committed = true;
      intent.phase = "committed";
      guard?.rebindLifecycle(node.id);
      // Observers run after the authoritative transaction; an observer failure
      // must never trigger rollback of an already committed native cutover.
      for (const notify of afterCommit) notify();
      try { this.deps.activityOracle?.declareOccupantSwap(node.id, successorGeneration); } catch { /* durable state remains authoritative */ }
      for (const notification of [...notifications, event]) eventBus.notifySubscribers(notification);
      const finished = await recoverRuntimeSwitch(db, tmux, intent, this.deps.runtimeAdapters, this.deps.sleep);
      return { ok: true, changed: true, dryRun: false, ...base, sessionId, generation: successorGeneration, openQueueItems,
        recoveryPending: !finished.complete, ...(finished.message ? { warnings: [finished.message] } : {}) };
    } catch (error) {
      const recovered = journaled ? await recoverRuntimeSwitch(db, tmux, intent, this.deps.runtimeAdapters, this.deps.sleep) : { complete: true };
      if (committed) return { ok: true, changed: true, dryRun: false, ...base, sessionId, generation: successorGeneration, openQueueItems,
        recoveryPending: !recovered.complete, warnings: [(error as Error).message, ...(recovered.message ? [recovered.message] : [])] };
      return { ok: false, code: "runtime_switch_failed", message: (error as Error).message, recoveryPending: !recovered.complete,
        guidance: recovered.complete ? "The incumbent and managed configuration are unchanged. Correct the target runtime failure before retrying."
          : `Automatic recovery is pending: ${recovered.message}. Inspect rig seat status; the saved switch intent will be retried at daemon startup.` };
    }
  }
}
