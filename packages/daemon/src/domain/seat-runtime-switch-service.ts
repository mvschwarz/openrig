import nodePath from "node:path";
import { ulid } from "ulid";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { QueueRepository } from "./queue-repository.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import type { PersistedEvent } from "./types.js";
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
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { seatCodexCorePluginDir, seatCorePluginDir, withPluginDirs } from "./claude-core-plugin-env.js";
import { planRuntimeSwitchMaterials, type RuntimeSwitchMaterials, type RuntimeSwitchMaterialsInput, type SwitchRuntime } from "./runtime-switch-materials.js";
import { terminatePaneInPlace } from "./pane-cutover.js";

/**
 * Slice 16: switch one live seat between Codex and Claude Code, successor first (founder
 * decision-20261014-0454-1214-successor-first; built from #1214 by Aschenbath, whose design is the starting point).
 *
 * The seat keeps its address, edges, queue rows and claims. Its successor starts on the target runtime in a staging
 * session beside the current occupant, reads a handover, and confirms it through OpenRig with its own reserved
 * generation. That confirmation is the evidence it can carry on. Only then are the panes exchanged and the seat's
 * configuration committed (one transaction, which also moves the claims); then the predecessor is retired. Before the
 * commit the predecessor holds the seat; after it the successor does; a durable record (`seat_runtime_switches`) lets
 * recovery finish either side without guessing.
 */

export const RUNTIME_SWITCH_CONFIRM_TIMEOUT_MS_DEFAULT = 180_000;

export interface SeatRuntimeSwitchDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  queueRepo?: Pick<QueueRepository, "transferClaimsByGeneration">;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  sessionEnv?: Record<string, string | undefined>;
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  occupantInvalidator?: OccupantInvalidator;
  activityOracle?: { declareOccupantSwap(nodeId: string, generation: string): void };
  predecessorRecapResolver?: PredecessorRecapResolver;
  authoredRecapResolver?: (seatRef: string) => { address: string; chainLength: number } | { absentReason: string };
  materialResolution?: RuntimeSwitchMaterialsInput["resolution"];
  pluginsDir?: string;
  openrigHome?: string;
  readinessTimeoutMs?: number;
  confirmPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface SetRuntimeInput {
  seatRef: string;
  runtime: string;
  reason: string;
  requestedBy?: string | null;
  dryRun?: boolean;
  model?: string;
  effort?: string;
  codexConfigProfile?: string;
  /** Target native permission selection; absent or "inherit" means member and rig policy. */
  permissionMode?: string;
  /** How long the successor has to confirm the handover. */
  confirmTimeoutMs?: number;
}

export interface RuntimeSwitchRefusal {
  ok: false;
  code: string;
  message: string;
  guidance?: string;
  switchId?: string;
  /** For a failed switch: whether it committed (it didn't, for every refusal this service returns). */
  committed?: boolean;
}

export interface RuntimeSwitchPlan {
  seat: { ref: string; nodeId: string; rigId: string; session: string };
  from: string;
  to: string;
  settings: RuntimeSwitchMaterials["settings"];
  permission: { mode: string; source: "explicit" | "member_or_rig_policy" };
  dropped: RuntimeSwitchMaterials["dropped"];
  costs: string[];
  notRun: string[];
  warnings: string[];
}

export type SetRuntimeResult =
  | RuntimeSwitchRefusal
  | ({ ok: true; dryRun: true; changed: true } & RuntimeSwitchPlan)
  /** The seat already runs that runtime and no settings were given: nothing to do. */
  | ({ ok: true; dryRun: boolean; changed: false } & Pick<RuntimeSwitchPlan, "seat" | "from" | "to">)
  | ({ ok: true; dryRun: false; changed: true; switchId: string; generation: string; previousGeneration: string;
      claimsMoved: number; openRows: number; confirmation: { note: string; at: string }; recoveryPending: boolean } & RuntimeSwitchPlan);

interface SwitchRow {
  id: string; node_id: string; canonical_session: string; staging_session: string;
  predecessor_pane: string; successor_pane: string | null; predecessor_generation: string; successor_generation: string;
  from_runtime: string; to_runtime: string; phase: string; reason: string; requested_by: string | null; plan_json: string;
  confirmation_note: string | null; confirmed_at: string | null; successor_resume_type: string | null; successor_resume_token: string | null;
  committed_at: string | null; outcome: string | null; attention: string | null; created_at: string;
}

const COSTS = [
  "A new conversation: native history isn't converted; only the handover carries over.",
  "Same address, different terminal: the seat's session and address stay, its pane and scrollback change.",
  "The team file isn't rewritten: the database and rig export show the new runtime, the imported YAML keeps the old one, so a later converge reports a deferred change_runtime.",
  "Source settings are cleared, not mapped: model, effort, Codex profile and an explicit native permission choice. A model or effort the seat's agent spec declares for the source runtime doesn't apply either.",
  "A second process runs on the target's account until cutover.",
  "Messages sent to the seat while it switches are held, not typed; rig send says the seat is switching and until when, and they need sending again afterwards.",
  "A failed switch can leave the target runtime's prepared files (its seat storage and projections).",
  "Codex and Claude Code only, single-pane seats only.",
];

export class SeatRuntimeSwitchService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SeatRuntimeSwitchDeps) {
    for (const owner of [deps.rigRepo, deps.sessionRegistry, deps.discoveryRepo, deps.eventBus]) {
      if (owner.db !== deps.db) throw new Error("Runtime switch dependencies must share one database.");
    }
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The open (or attention-holding) switch for a seat, as `rig seat status` shows it. */
  openSwitch(nodeId: string): SwitchRow | null {
    try {
      return (this.deps.db.prepare(`SELECT * FROM seat_runtime_switches WHERE node_id = ?
        AND (phase IN ('preparing', 'confirmed', 'committed') OR attention IS NOT NULL) ORDER BY created_at DESC LIMIT 1`)
        .get(nodeId) as SwitchRow | undefined) ?? null;
    } catch { return null; }
  }

  async setRuntime(input: SetRuntimeInput): Promise<SetRuntimeResult> {
    const refuse = (code: string, message: string, guidance?: string): RuntimeSwitchRefusal => ({ ok: false, code, message, ...(guidance ? { guidance } : {}) });
    if (input.runtime !== "codex" && input.runtime !== "claude-code") {
      return refuse("invalid_runtime_settings", "Choose --runtime codex or --runtime claude-code.");
    }
    const target: SwitchRuntime = input.runtime;
    const reason = input.reason?.trim();
    if (!reason) return refuse("invalid_runtime_settings", "Give a --reason for the switch; it is recorded with it.");
    const explicit: { model?: string; effort?: string; codexConfigProfile?: string; permissionMode?: string } = {};
    for (const key of ["model", "effort", "codexConfigProfile", "permissionMode"] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (!value.trim() || /[\r\n\0]/.test(value)) return refuse("invalid_runtime_settings", `${key} must be a non-empty single-line value.`);
      explicit[key] = value.trim();
    }
    if (target !== "codex" && explicit.codexConfigProfile) {
      return refuse("invalid_runtime_settings", "--codex-config-profile applies only when switching to Codex.");
    }

    const { db, rigRepo, sessionRegistry, tmuxAdapter: tmux } = this.deps;
    const status = new SeatStatusService({ rigRepo }).getStatus(input.seatRef);
    if (!status.ok) return status;
    const node = rigRepo.getRig(status.status.rig_id)?.nodes.find((candidate) => candidate.logicalId === status.status.logical_id);
    if (!node) return refuse("seat_not_found", `No seat ${input.seatRef}.`);
    const guard = tmux.deliveryGuard;
    if (!input.dryRun && guard && !guard.ownsLifecycle(node.id)) {
      try { return await guard.lifecycle([node.id], () => this.setRuntime(input)); }
      catch (error) {
        if (error instanceof DeliveryGuardError) return refuse(error.code, `${error.message} The seat wasn't changed.`);
        throw error;
      }
    }
    const seatRef = `${node.logicalId}@${status.status.rig_name}`;
    const open = this.openSwitch(node.id);
    if (open) {
      return { ...refuse("runtime_switch_pending",
        `${seatRef} already has a runtime switch ${open.committed_at ? "that committed and still needs finishing"
          : open.phase === "abandoned" ? "whose staged successor hasn't been retired" : "in progress"} (${open.from_runtime} → ${open.to_runtime}, switch ${open.id}).`,
        `Inspect it with rig seat status ${seatRef}; finish an interrupted one with rig seat set-runtime ${seatRef} --recover.`), switchId: open.id };
    }
    if (node.runtime !== "codex" && node.runtime !== "claude-code") {
      return refuse("runtime_switch_unsupported", `${seatRef} runs ${node.runtime ?? "an unknown runtime"}; only Codex and Claude Code seats can switch.`);
    }
    const binding = sessionRegistry.getBindingForNode(node.id);
    const sessionName = binding?.tmuxSession ?? null;
    const base = { seat: { ref: seatRef, nodeId: node.id, rigId: node.rigId, session: sessionName ?? "" }, from: node.runtime, to: target };
    if (node.runtime === target) {
      if (explicit.model || explicit.effort || explicit.codexConfigProfile || explicit.permissionMode) {
        return refuse("runtime_unchanged", `${seatRef} already runs ${target}.`,
          "Change settings within one runtime with rig seat set-model, rig seat set-effort or rig seat set-permissions.");
      }
      return { ok: true, dryRun: !!input.dryRun, changed: false, ...base };
    }
    const predecessorGeneration = sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;
    const running = sessionRegistry.getSessionsForRig(node.rigId).filter((session) => session.nodeId === node.id && session.status === "running");
    const unsupported = !sessionName || !binding?.tmuxPane ? "it has no bound tmux pane"
      : binding.attachmentType && binding.attachmentType !== "tmux" ? `it's attached through ${binding.attachmentType}, not tmux`
      : !predecessorGeneration ? "its current occupant generation isn't recorded"
      : running.length !== 1 || running[0]!.sessionName !== sessionName ? "it doesn't have exactly one running session at its address"
      : !node.cwd || !nodePath.isAbsolute(node.cwd) ? "its working directory isn't an absolute path"
      : null;
    if (unsupported) return refuse("runtime_switch_unsupported", `${seatRef} can't switch runtime: ${unsupported}.`);
    try {
      const [panes, windows] = await Promise.all([tmux.listPanes(sessionName!), tmux.listWindows(sessionName!)]);
      if (windows.length !== 1 || panes.length !== 1 || panes[0]!.id !== binding!.tmuxPane) {
        return refuse("runtime_switch_unsupported", `${seatRef} can't switch runtime: only a single-window, single-pane seat can, and its session has ${windows.length} window(s) and ${panes.length} pane(s).`);
      }
    } catch (error) {
      return refuse("runtime_switch_unsupported", `${seatRef} can't switch runtime: its session couldn't be read (${(error as Error).message}).`);
    }
    if (!this.deps.runtimeAdapters?.[target]) {
      return refuse("runtime_target_unavailable", `${target} isn't available on this daemon, so no successor can start here.`);
    }

    // Settings: the target's explicit permission choice, else member and rig policy. Never the source's selection.
    const permissions = new NativePermissionStore(db);
    let selection: NativePermissionSelection | null = null;
    let sourceSelection: { runtime: string; mode: string } | null = null;
    try {
      sourceSelection = permissions.read(node.id);
      const mode = explicit.permissionMode ?? "inherit";
      if (mode !== "inherit") {
        selection = target === "claude-code" && mode !== "floor" && mode !== "full_bypass"
          ? (/^[A-Za-z][A-Za-z0-9_]*$/.test(mode) ? { runtime: "claude-code", mode } : (() => { throw new Error(`"${mode}" isn't a permission mode.`); })())
          : validateNativePermissionSelection(target, mode);
      }
    } catch (error) { return refuse("invalid_runtime_settings", (error as Error).message); }

    let materials: RuntimeSwitchMaterials;
    try {
      const saved = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus: this.deps.eventBus, tmuxAdapter: tmux }).readStartupContext(node.id, node.cwd!);
      if (!saved.ok && node.agentRef) return refuse("runtime_target_unavailable", saved.refusal.message);
      materials = planRuntimeSwitchMaterials({ db, node, rigName: status.status.rig_name, canonicalSession: sessionName!, runtime: target,
        explicit, saved: saved.ok ? saved.context : null, claudeManagedBlockFile: rigRepo.getRigClaudeManagedBlockFile(node.rigId) ?? undefined,
        resolution: this.deps.materialResolution, openrigHome: this.deps.openrigHome });
    } catch (error) { return refuse("runtime_target_unavailable", (error as Error).message); }

    const dropped = [...materials.dropped, ...(sourceSelection ? [{ setting: "native permission choice", value: `${sourceSelection.runtime}:${sourceSelection.mode}` }] : [])];
    const plan: RuntimeSwitchPlan = {
      ...base,
      settings: materials.settings,
      permission: selection ? { mode: selection.mode, source: "explicit" } : { mode: "inherit", source: "member_or_rig_policy" },
      dropped,
      costs: COSTS,
      notRun: materials.notRun.map((command) => `startup slash command not run by a switch: ${command}`),
      warnings: materials.warnings,
    };
    if (input.dryRun) return { ok: true, dryRun: true, changed: true, ...plan };
    return this.execute({ input: { ...input, reason }, node, seatRef, sessionName: sessionName!, predecessorPane: binding!.tmuxPane!,
      predecessorGeneration: predecessorGeneration!, target, materials, selection, plan, restorePolicy: running[0]!.restorePolicy ?? node.restorePolicy ?? null });
  }

  /** The staged successor's confirmation: only that switch's reserved generation, at the seat it names. */
  confirm(input: { seatRef: string; switchId: string; note: string; actorSession: string | null; generation: string | null }): { ok: true; switchId: string; message: string } | RuntimeSwitchRefusal {
    const refused = (message: string): RuntimeSwitchRefusal => ({ ok: false, code: "runtime_switch_confirmation_refused", message, switchId: input.switchId });
    const note = input.note?.trim();
    if (!note || note.length > 2000 || /\0/.test(note)) return refused("Confirm with a --note of up to 2000 characters saying what you'll do first.");
    const row = this.deps.db.prepare("SELECT * FROM seat_runtime_switches WHERE id = ?").get(input.switchId) as SwitchRow | undefined;
    if (!row) return refused(`No runtime switch ${input.switchId}.`);
    if (row.committed_at || row.phase !== "preparing") return refused(`Switch ${row.id} isn't waiting for a confirmation (it is ${row.phase}).`);
    if (!input.actorSession || input.actorSession !== row.canonical_session || input.generation !== row.successor_generation) {
      return refused(`Only the staged successor of ${row.canonical_session} for switch ${row.id} can confirm it. Nothing was changed.`);
    }
    const changed = this.deps.db.prepare(`UPDATE seat_runtime_switches SET phase = 'confirmed', confirmation_note = ?, confirmed_at = ?,
      updated_at = ? WHERE id = ? AND phase = 'preparing' AND committed_at IS NULL`).run(note, this.now().toISOString(), this.now().toISOString(), row.id);
    if (changed.changes !== 1) return refused(`Switch ${row.id} changed while confirming; nothing was recorded.`);
    return { ok: true, switchId: row.id, message: `Confirmed. OpenRig is moving ${row.canonical_session} to you now. Wait for the activation message before acting as the seat.` };
  }

  private async execute(ctx: {
    input: SetRuntimeInput & { reason: string }; node: NonNullable<ReturnType<RigRepository["getRig"]>>["nodes"][number]; seatRef: string; sessionName: string;
    predecessorPane: string; predecessorGeneration: string; target: SwitchRuntime; materials: RuntimeSwitchMaterials;
    selection: NativePermissionSelection | null; plan: RuntimeSwitchPlan; restorePolicy: string | null;
  }): Promise<SetRuntimeResult> {
    const { db, rigRepo, sessionRegistry, tmuxAdapter: tmux } = this.deps;
    const { node, sessionName, target, materials } = ctx;
    const failed = (message: string, guidance?: string): RuntimeSwitchRefusal => ({ ok: false, code: "runtime_switch_failed", committed: false, message,
      guidance: guidance ?? `${ctx.seatRef} is unchanged on ${node.runtime}. Correct the cause and try again.` });
    const successorGeneration = sessionRegistry.reserveOccupantGeneration();
    if (!successorGeneration) return failed("No occupant generation could be reserved for the successor (the tenure ledger is unavailable).");

    // Facts the handover carries, read while the predecessor still holds the seat.
    const screen = await tmux.capturePaneScreen(ctx.predecessorPane).catch(() => null);
    const recap = this.deps.predecessorRecapResolver?.({ nodeId: node.id, runtime: node.runtime, sessionName });
    const authored = this.deps.authoredRecapResolver?.(ctx.seatRef);
    const id = ulid();
    const row: Pick<SwitchRow, "id" | "staging_session"> = { id, staging_session: `openrig-switch-${id.toLowerCase()}` };
    const stamp = () => this.now().toISOString();
    const confirmTimeoutMs = ctx.input.confirmTimeoutMs ?? RUNTIME_SWITCH_CONFIRM_TIMEOUT_MS_DEFAULT;
    // An upper estimate a waiting send can quote: the successor's start and readiness, then its confirmation window.
    const deadlineAt = new Date(this.now().getTime() + (this.deps.readinessTimeoutMs ?? 60_000) + confirmTimeoutMs + 30_000).toISOString();
    db.prepare(`INSERT INTO seat_runtime_switches (id, node_id, canonical_session, staging_session, predecessor_pane, predecessor_generation,
      successor_generation, from_runtime, to_runtime, reason, requested_by, plan_json, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, node.id, sessionName, row.staging_session, ctx.predecessorPane, ctx.predecessorGeneration, successorGeneration, node.runtime, target,
        ctx.input.reason, ctx.input.requestedBy ?? null, JSON.stringify(ctx.plan), deadlineAt, stamp(), stamp());
    let successorPane: string | null = null;
    const abandon = async (why: string): Promise<RuntimeSwitchRefusal> => {
      const retired = await this.retireStaging(row.staging_session, node.id, "Uncommitted successor");
      db.prepare(`UPDATE seat_runtime_switches SET phase = 'abandoned', outcome = ?, attention = ?, updated_at = ? WHERE id = ? AND committed_at IS NULL`)
        .run(why, retired.ok ? null : `The staged successor couldn't be retired: ${retired.message}`, stamp(), id);
      tmux.finishLaunchBinding(row.staging_session);
      return { ...failed(`${why}${retired.ok ? "" : ` The staged successor couldn't be retired (${retired.message}); recover with rig seat set-runtime ${ctx.seatRef} --recover.`}`), switchId: id };
    };

    // 1. The successor, on the target runtime, beside the predecessor.
    const permissions = new NativePermissionStore(db);
    const override = permissions.launchOverride(node.id, target, { selection: ctx.selection, codexProfile: materials.settings.codexConfigProfile.value });
    const policyPosture = rigRepo.getNodePolicyProvenance(node.id)?.launchPosture ?? rigRepo.getRigPolicyProvenance(node.rigId)?.launchPosture ?? "floor";
    const posture = override.launchPosture ?? policyPosture;
    // Codex has no auto mode; it launches at the floor, as its permission resolution says.
    const launchPosture = posture === "auto" && target === "codex" ? "floor" : posture;
    const permissionMode = override.permissionMode ?? (posture === "auto" && target === "claude-code" ? "auto" : undefined);
    const targetNode = { id: node.id, runtime: target };
    const corePluginDir = seatCorePluginDir(targetNode, db, materials.pluginPaths, this.deps.pluginsDir);
    const codexCorePluginDir = seatCodexCorePluginDir(targetNode, db, materials.pluginPaths, this.deps.pluginsDir);
    const launcher = new SuccessorSessionLauncher(tmux, this.deps.discoveryRepo, {
      sessionEnv: this.deps.sessionEnv, runtimeSessionEnv: this.deps.runtimeSessionEnv, runtimeAdapters: this.deps.runtimeAdapters,
      tmuxOptionDefaults: this.deps.tmuxOptionDefaults, readinessTimeoutMs: this.deps.readinessTimeoutMs, sleep: this.deps.sleep,
    });
    const launch = await launcher.stageSuccessor({
      stagingSession: row.staging_session, canonicalSession: sessionName, occupantGeneration: successorGeneration,
      node: { id: node.id, runtime: target, cwd: node.cwd, model: materials.settings.model.value, effort: materials.settings.effort.value,
        advisor: materials.settings.advisor.value, codexConfigProfile: materials.settings.codexConfigProfile.value,
        kernelAuthority: override.kernelAuthority, teamPermissionDefault: override.teamPermissionDefault,
        nonInterruptive: rigRepo.getRigNonInterruptive(node.rigId), launchPosture, ...(permissionMode ? { permissionMode } : {}),
        seatEnv: withPluginDirs(rigRepo.getEffectiveSeatEnv(node.id), [corePluginDir, target === "claude-code" ? materials.seatSkills.pluginDir : undefined]),
        ...((corePluginDir || codexCorePluginDir) && node.cwd ? { seatProjectDir: node.cwd } : {}) },
      onPaneCreated: (pane) => {
        successorPane = pane;
        db.prepare("UPDATE seat_runtime_switches SET successor_pane = ?, updated_at = ? WHERE id = ?").run(pane, stamp(), id);
      },
      staged: { prepare: (binding, adapter) => materials.prepare(binding, adapter),
        binding: { ...materials.bindingAdditions(), runtimeSwitchFrom: { runtime: node.runtime!, session: sessionName, pane: ctx.predecessorPane, generation: ctx.predecessorGeneration } } },
    });
    if (!launch.ok) {
      const attention = launch.code === "successor_attention_required" ? " It is waiting at a login, trust or approval prompt." : "";
      return abandon(`The ${target} successor didn't start: ${launch.message}.${attention}`);
    }
    const warnings = [...ctx.plan.warnings, ...(launch.notes ?? [])];

    // 2. The handover, as the successor's first turn; the confirmation it asks for is the evidence it can carry on.
    const queue = db.prepare(`SELECT qitem_id, state, priority, source_session FROM queue_items WHERE destination_session = ?
      AND state IN ('pending', 'in-progress', 'blocked') ORDER BY ts_created, qitem_id`).all(sessionName) as Array<{ qitem_id: string; state: string; priority: string; source_session: string }>;
    const packet = [
      `You are ${ctx.seatRef}'s successor on ${target}, staged for runtime switch ${id}. The ${node.runtime} occupant still holds the seat: until OpenRig tells you the switch committed, don't act as the seat (queue changes and sends are refused).`,
      materials.firstTurn,
      buildRestorePacket({ seatRef: ctx.seatRef, reason: ctx.input.reason, departingSession: sessionName, handoverAt: stamp(), capturedContext: screen ?? "",
        ...(recap && "recap" in recap ? recap : { recapUnavailableReason: recap?.unavailableReason ?? "no provider recap available" }),
        ...(authored ? ("address" in authored ? { authoredRecap: authored } : { authoredRecapAbsentReason: authored.absentReason }) : {}) }),
      `The seat's open queue work (${queue.length} rows; its claims become yours at commit):`,
      ...queue.slice(0, 100).map((item) => `- ${item.qitem_id}: ${item.state}, ${item.priority}, from ${item.source_session}`),
      [
        "When you've read this handover and can carry on the seat's work, confirm it, saying what you'll do first:",
        `  rig seat set-runtime ${ctx.seatRef} --confirm ${id} --note "<what you'll do first>"`,
        "Then wait for OpenRig's activation message. If you can't carry on (an unusable model, a login or permission problem), don't confirm; the switch then stops and the current occupant keeps the seat.",
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
    const typed = await tmux.sendText(row.staging_session, packet);
    if (!typed.ok) return abandon(`The handover couldn't be typed to the successor: ${typed.message}.`);
    await this.sleep(200);
    const entered = await tmux.sendKeys(row.staging_session, ["Enter"]);
    if (!entered.ok) return abandon(`The handover couldn't be submitted to the successor: ${entered.message}.`);

    // 3. Wait for the confirmation (P2's evidence), bounded.
    const timeoutMs = confirmTimeoutMs;
    const pollMs = this.deps.confirmPollMs ?? 1000;
    const deadline = this.now().getTime() + timeoutMs;
    let confirmation: { note: string; at: string } | null = null;
    while (!confirmation) {
      const current = db.prepare("SELECT phase, confirmation_note, confirmed_at FROM seat_runtime_switches WHERE id = ?").get(id) as Pick<SwitchRow, "phase" | "confirmation_note" | "confirmed_at">;
      if (current.phase === "confirmed" && current.confirmation_note && current.confirmed_at) { confirmation = { note: current.confirmation_note, at: current.confirmed_at }; break; }
      if (this.now().getTime() >= deadline) {
        const tail = successorPane ? (await tmux.capturePaneScreen(successorPane).catch(() => null))?.trim().split("\n").slice(-6).join("\n") : null;
        return abandon(`The ${target} successor didn't confirm the handover within ${Math.round(timeoutMs / 1000)} s, so it isn't shown able to carry on.${tail ? ` Its screen ended with:\n${tail}` : ""}`);
      }
      const probe = await tmux.probeSession(row.staging_session).catch(() => ({ state: "unknown" as const }));
      if (probe.state === "absent") return abandon(`The ${target} successor's session ended before it confirmed the handover.`);
      await this.sleep(pollMs);
    }

    // 4. The exchange, then the commit. A pane exchange the commit doesn't follow is undone (by the same exchange).
    const swapped = await tmux.swapRuntimeSwitchPanes({ nodeId: node.id, stagingSession: row.staging_session, canonicalSession: sessionName,
      canonicalPane: ctx.predecessorPane, stagedPane: successorPane! });
    if (!swapped.ok) return abandon(`The panes couldn't be exchanged: ${swapped.message}.`);
    let committed: { event: PersistedEvent; notifications: PersistedEvent[]; claimsMoved: number; afterCommit: Array<() => void> };
    try {
      committed = this.commit({ ...ctx, id, successorGeneration, successorPane: successorPane!, appliedLaunch: launch.appliedLaunch,
        launchResume: launch.resumeToken ? { type: launch.resumeType, token: launch.resumeToken } : null });
    } catch (error) {
      const back = await tmux.swapRuntimeSwitchPanes({ nodeId: node.id, stagingSession: row.staging_session, canonicalSession: sessionName,
        canonicalPane: successorPane!, stagedPane: ctx.predecessorPane });
      if (!back.ok) {
        db.prepare("UPDATE seat_runtime_switches SET attention = ?, updated_at = ? WHERE id = ?")
          .run(`The commit failed (${(error as Error).message}) and the panes couldn't be exchanged back: ${back.message}`, stamp(), id);
        return { ...failed(`The commit failed (${(error as Error).message}), and the panes couldn't be put back (${back.message}).`,
          `The ${node.runtime} occupant still holds ${ctx.seatRef} by record. Recover with rig seat set-runtime ${ctx.seatRef} --recover.`), switchId: id };
      }
      return abandon(`The commit failed: ${(error as Error).message}.`);
    }
    tmux.deliveryGuard?.rebindLifecycle(node.id);
    for (const step of committed.afterCommit) { try { step(); } catch { /* the committed record is authoritative */ } }
    try { this.deps.activityOracle?.declareOccupantSwap(node.id, successorGeneration); } catch { /* the committed record is authoritative */ }
    for (const event of [...committed.notifications, committed.event]) this.deps.eventBus.notifySubscribers(event);

    // 5. Retire the predecessor and tell the successor it holds the seat. A failure here leaves the switch committed.
    const finished = await this.finishCommitted({ id, node_id: node.id, canonical_session: sessionName, staging_session: row.staging_session,
      to_runtime: target, from_runtime: node.runtime!, successor_generation: successorGeneration });
    return { ok: true, dryRun: false, changed: true, ...ctx.plan, switchId: id, generation: successorGeneration, previousGeneration: ctx.predecessorGeneration,
      claimsMoved: committed.claimsMoved, openRows: queue.length, confirmation, recoveryPending: !finished.ok,
      warnings: finished.ok ? warnings : [...warnings, `The switch committed, but ${finished.message} Finish it with rig seat set-runtime ${ctx.seatRef} --recover.`] };
  }

  private commit(ctx: {
    input: SetRuntimeInput & { reason: string }; node: NonNullable<ReturnType<RigRepository["getRig"]>>["nodes"][number]; sessionName: string;
    predecessorPane: string; predecessorGeneration: string; target: SwitchRuntime; materials: RuntimeSwitchMaterials;
    selection: NativePermissionSelection | null; plan: RuntimeSwitchPlan; restorePolicy: string | null;
    id: string; successorGeneration: string; successorPane: string;
    appliedLaunch?: Parameters<AppliedLaunchObservationStore["recordGeneration"]>[1]; launchResume: { type?: string; token: string } | null;
  }) {
    const { db, rigRepo, sessionRegistry, eventBus } = this.deps;
    const { node, materials, target } = ctx;
    const notifications: PersistedEvent[] = [];
    const afterCommit: Array<() => void> = [];
    let claimsMoved = 0;
    const event = db.transaction(() => {
      // The seat must be exactly as the switch found it.
      const binding = sessionRegistry.getBindingForNode(node.id);
      if (binding?.tmuxSession !== ctx.sessionName || binding.tmuxPane !== ctx.predecessorPane
        || sessionRegistry.currentOccupantTenure(node.id)?.generationUuid !== ctx.predecessorGeneration
        || (db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(node.id) as { runtime: string } | undefined)?.runtime !== node.runtime) {
        throw new Error("the seat's binding, occupant or runtime changed during the switch");
      }
      const at = this.now().toISOString();
      const spec = materials.resolvedSpec;
      db.prepare(`UPDATE nodes SET runtime = ?, model = ?, effort = ?, effort_choice = NULL, advisor = ?, codex_config_profile = ?,
        ${spec ? "resolved_spec_name = ?, resolved_spec_version = ?, resolved_spec_hash = ?, restore_policy = ?," : ""}
        occupant_lifecycle = 'active', continuity_outcome = 'fresh', handover_result = 'complete', previous_occupant = ?, handover_at = ? WHERE id = ?`)
        .run(target, materials.settings.model.value, materials.settings.effort.value, materials.settings.advisor.value, materials.settings.codexConfigProfile.value,
          ...(spec ? [spec.name, spec.version, spec.hash, spec.restorePolicy] : []), ctx.sessionName, at, node.id);
      new NativePermissionStore(db).write(node.id, ctx.selection, ctx.input.requestedBy?.trim() || ctx.sessionName, ctx.input.reason);
      db.prepare(`INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)`)
        .run(node.id, JSON.stringify(materials.plan.entries.map((e) => ({ category: e.category, effectiveId: e.effectiveId, sourceSpec: e.sourceSpec, sourcePath: e.sourcePath,
          resourcePath: e.resourcePath, absolutePath: e.absolutePath, resourceType: e.resourceType, mergeStrategy: e.mergeStrategy, target: e.target }))),
          JSON.stringify(materials.files), JSON.stringify(materials.actions), target);
      db.prepare("UPDATE sessions SET status = 'superseded' WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited')").run(node.id);
      db.prepare("UPDATE bindings SET tmux_pane = ?, tmux_window = NULL, updated_at = datetime('now') WHERE node_id = ?").run(ctx.successorPane, node.id);
      const successor = sessionRegistry.registerClaimedSession(node.id, ctx.sessionName, "handover", ctx.successorGeneration);
      if (sessionRegistry.currentOccupantTenure(node.id)?.generationUuid !== ctx.successorGeneration) throw new Error("the successor's generation couldn't be recorded");
      db.prepare("UPDATE sessions SET origin = 'launched', restore_policy = ? WHERE id = ?").run(ctx.restorePolicy, successor.id);
      const hooked = db.prepare("SELECT successor_resume_token FROM seat_runtime_switches WHERE id = ?").get(ctx.id) as { successor_resume_token: string | null };
      const nativeId = hooked.successor_resume_token ?? ctx.launchResume?.token;
      if (nativeId) {
        const token = validateResumeToken(target, nativeId);
        if (token.ok) sessionRegistry.updateResumeToken(successor.id, token.resumeType, token.token, hooked.successor_resume_token ? "hook" : "scrape");
      }
      const observations = new AppliedLaunchObservationStore(db);
      observations.invalidateGeneration(ctx.predecessorGeneration);
      if (ctx.appliedLaunch) observations.recordGeneration(ctx.successorGeneration, ctx.appliedLaunch);
      // The claims stay with the seat: moved to the successor before ordinary invalidation could release them.
      claimsMoved = this.deps.queueRepo?.transferClaimsByGeneration(ctx.predecessorGeneration, ctx.successorGeneration,
        `moved: the seat's runtime switch ${ctx.id} (${node.runtime} → ${target}) committed; the claim is the successor's`) ?? 0;
      this.deps.occupantInvalidator?.invalidateRetiringOccupant({ retiringSessionName: ctx.sessionName, successorSessionName: ctx.sessionName,
        retiringGeneration: ctx.predecessorGeneration });
      db.prepare("UPDATE discovered_sessions SET status = 'vanished', claimed_node_id = NULL WHERE claimed_node_id = ?").run(node.id);
      const discovered = this.deps.discoveryRepo.upsertDiscoveredSession({ tmuxSession: ctx.sessionName, tmuxPane: ctx.successorPane, cwd: node.cwd!,
        runtimeHint: target, confidence: "high" });
      this.deps.discoveryRepo.markClaimed(discovered.id, node.id);
      db.prepare(`UPDATE seat_runtime_switches SET phase = 'committed', committed_at = ?, updated_at = ? WHERE id = ? AND phase = 'confirmed'`).run(at, at, ctx.id);
      if ((db.prepare("SELECT committed_at FROM seat_runtime_switches WHERE id = ?").get(ctx.id) as { committed_at: string | null }).committed_at !== at) {
        throw new Error("the switch record changed during the commit");
      }
      // The newest default restore describes the committed target, even if the daemon stops right after this.
      new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) })
        .captureSnapshot(node.rigId, "runtime-switch", { deferNotify: (persisted) => notifications.push(persisted) });
      return eventBus.persistWithinTransaction({ type: "seat.runtime_changed", rigId: node.rigId, nodeId: node.id, switchId: ctx.id, from: node.runtime!, to: target,
        reason: ctx.input.reason, requestedBy: ctx.input.requestedBy ?? null, generation: ctx.successorGeneration, previousGeneration: ctx.predecessorGeneration,
        settings: { ...materials.settings }, dropped: ctx.plan.dropped, permissionSelection: ctx.selection ? ctx.selection.mode : "inherit", claimsMoved });
    })();
    return { event, notifications, claimsMoved, afterCommit };
  }

  /** After the commit: retire the predecessor (in the staging session), carry the successor's runtime on the seat's
   *  session, and tell the successor it holds the seat. Idempotent enough for recovery to call again. */
  private async finishCommitted(row: Pick<SwitchRow, "id" | "node_id" | "canonical_session" | "staging_session" | "to_runtime" | "from_runtime" | "successor_generation">): Promise<{ ok: true } | { ok: false; message: string }> {
    const { db, tmuxAdapter: tmux } = this.deps;
    const problems: string[] = [];
    const retired = await this.retireStaging(row.staging_session, row.node_id, "Predecessor");
    if (!retired.ok) problems.push(`the ${row.from_runtime} predecessor couldn't be retired (${retired.message})`);
    const env = await tmux.setRuntimeSwitchEnvironment(row.canonical_session, row.to_runtime, row.successor_generation);
    if (!env.ok) problems.push(`the seat's session environment couldn't be updated (${env.message})`);
    tmux.finishLaunchBinding(row.staging_session);
    if (retired.ok) {
      const text = `OpenRig: runtime switch ${row.id} committed. You now hold ${row.canonical_session} on ${row.to_runtime}; the ${row.from_runtime} occupant has retired. Carry on from the handover: the seat's queue rows and claims are yours.`;
      const typed = await tmux.sendText(row.canonical_session, text);
      const entered = typed.ok ? (await this.sleep(200), await tmux.sendKeys(row.canonical_session, ["Enter"])) : typed;
      if (!entered.ok) problems.push(`the activation message couldn't be delivered (${entered.message})`);
    }
    const at = this.now().toISOString();
    if (problems.length === 0) {
      db.prepare("UPDATE seat_runtime_switches SET phase = 'finished', outcome = ?, attention = NULL, updated_at = ? WHERE id = ? AND committed_at IS NOT NULL")
        .run(`committed: the seat runs ${row.to_runtime}; the ${row.from_runtime} predecessor retired`, at, row.id);
      return { ok: true };
    }
    const message = `${problems.join("; ")}.`;
    db.prepare("UPDATE seat_runtime_switches SET attention = ?, updated_at = ? WHERE id = ?").run(message, at, row.id);
    return { ok: false, message };
  }

  /** Terminate and remove a staging session this switch created (holding either the uncommitted successor or, after the
   *  exchange, the predecessor). Requires the seat's lifecycle lease and the staging session's custody. */
  private async retireStaging(stagingSession: string, _nodeId: string, label: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const tmux = this.deps.tmuxAdapter;
    const probe = await tmux.probeSession(stagingSession).catch(() => ({ state: "unknown" as const }));
    if (probe.state === "absent") return { ok: true };
    if (probe.state !== "present") return { ok: false, message: "the staging session's presence couldn't be established" };
    const terminated = await terminatePaneInPlace(tmux, stagingSession, { pollMs: 100, timeoutMs: 3000, sleep: this.sleep }, label);
    if (!terminated.ok) return { ok: false, message: terminated.message };
    const removed = await tmux.killSession(stagingSession);
    if (!removed.ok && removed.code !== "session_not_found") return { ok: false, message: removed.message };
    return { ok: true };
  }

  /**
   * Finish an interrupted switch from its durable record, under the seat's lifecycle lease. Before its commit the
   * predecessor holds the seat: an exchanged pane is put back and the staged successor retired. After it the successor
   * holds the seat: the predecessor is retired and the successor told; custody never goes back. Where the panes don't
   * match the record, nothing is touched and the record says why (status shows it).
   */
  async recover(nodeId: string): Promise<{ ok: true; outcome: string; switchId: string | null } | { ok: false; code: string; message: string; switchId?: string }> {
    const guard = this.deps.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(nodeId)) {
      try { return await guard.lifecycle([nodeId], () => this.recover(nodeId)); }
      catch (error) { return { ok: false, code: (error as { code?: string }).code ?? "runtime_switch_pending", message: (error as Error).message }; }
    }
    const row = this.openSwitch(nodeId);
    if (!row) return { ok: true, outcome: "No runtime switch needs recovery.", switchId: null };
    const { db, tmuxAdapter: tmux } = this.deps;
    const at = () => this.now().toISOString();
    const stuck = (message: string) => {
      db.prepare("UPDATE seat_runtime_switches SET attention = ?, updated_at = ? WHERE id = ?").run(message, at(), row.id);
      return { ok: false as const, code: "runtime_switch_pending", message, switchId: row.id };
    };
    let canonicalPane: string | null = null;
    try {
      const panes = await tmux.listPanes(row.canonical_session);
      canonicalPane = panes.length === 1 ? panes[0]!.id : null;
    } catch { /* absent or unreadable: decided below */ }
    const staging = await tmux.probeSession(row.staging_session).catch(() => ({ state: "unknown" as const }));
    if (staging.state === "unknown") return stuck("The staging session's presence couldn't be established; nothing was touched.");
    let stagingPane: string | null = null;
    if (staging.state === "present") {
      const panes = await tmux.listPanes(row.staging_session).catch(() => []);
      stagingPane = panes.length === 1 ? panes[0]!.id : null;
      const adopted = stagingPane ? await tmux.adoptRuntimeSwitchStaging({ nodeId, stagingSession: row.staging_session, pane: stagingPane, generations: [row.successor_generation] })
        : { ok: false as const, message: "it doesn't have exactly one pane" };
      if (!adopted.ok) return stuck(`The staging session ${row.staging_session} can't be taken back: ${adopted.message}`);
    }
    if (!row.committed_at) {
      // Before commit: the predecessor holds the seat.
      const exchanged = canonicalPane !== null && canonicalPane === row.successor_pane && stagingPane === row.predecessor_pane;
      if (exchanged) {
        const back = await tmux.swapRuntimeSwitchPanes({ nodeId, stagingSession: row.staging_session, canonicalSession: row.canonical_session,
          canonicalPane: row.successor_pane!, stagedPane: row.predecessor_pane });
        if (!back.ok) return stuck(`The panes couldn't be exchanged back: ${back.message}`);
      } else if (canonicalPane !== row.predecessor_pane) {
        return stuck(`The seat's pane (${canonicalPane ?? "none"}) is neither the predecessor's nor the successor's; nothing was touched.`);
      }
      const retired = await this.retireStaging(row.staging_session, nodeId, "Uncommitted successor");
      if (!retired.ok) return stuck(`The staged successor couldn't be retired: ${retired.message}`);
      tmux.finishLaunchBinding(row.staging_session);
      // An abandoned switch keeps why it stopped; recovery only settles the successor it couldn't retire then.
      const outcome = row.phase === "abandoned" ? `${row.outcome ?? "abandoned before commit"} The staged ${row.to_runtime} successor was retired at recovery.`
        : `interrupted before commit: the ${row.from_runtime} occupant holds the seat; the staged ${row.to_runtime} successor was retired`;
      db.prepare("UPDATE seat_runtime_switches SET phase = 'abandoned', outcome = ?, attention = NULL, updated_at = ? WHERE id = ?").run(outcome, at(), row.id);
      return { ok: true, outcome, switchId: row.id };
    }
    // After commit: the successor holds the seat; finish forward.
    if (canonicalPane !== row.successor_pane) {
      return stuck(`The switch committed, but the seat's pane (${canonicalPane ?? "none"}) isn't the successor's; nothing was touched.`);
    }
    const finished = await this.finishCommitted(row);
    if (!finished.ok) return { ok: false, code: "runtime_switch_pending", message: finished.message, switchId: row.id };
    return { ok: true, outcome: `committed: finished; the seat runs ${row.to_runtime}`, switchId: row.id };
  }

  /** Daemon start: finish every interrupted switch, including an abandoned one whose successor wasn't retired. Returns
   *  warnings for the ones that still need attention. */
  async recoverAll(): Promise<string[]> {
    let rows: Array<{ node_id: string; canonical_session: string }> = [];
    try {
      rows = this.deps.db.prepare(`SELECT DISTINCT node_id, canonical_session FROM seat_runtime_switches
        WHERE phase IN ('preparing', 'confirmed', 'committed') OR attention IS NOT NULL`).all() as typeof rows;
    } catch { return []; }
    const warnings: string[] = [];
    for (const row of rows) {
      try {
        const result = await this.recover(row.node_id);
        if (!result.ok) warnings.push(`${row.canonical_session}: ${result.message}`);
      } catch (error) { warnings.push(`${row.canonical_session}: ${(error as Error).message}`); }
    }
    return warnings;
  }
}

/** A switch of this seat that committed at or after `since` (a send that waited behind it says the seat moved). */
export function runtimeSwitchCommittedSince(db: Database.Database, session: string, since: string): { id: string; from: string; to: string; committedAt: string } | null {
  try {
    const row = db.prepare(`SELECT id, from_runtime, to_runtime, committed_at FROM seat_runtime_switches
      WHERE canonical_session = ? AND committed_at >= ? ORDER BY committed_at DESC LIMIT 1`).get(session, since) as
      { id: string; from_runtime: string; to_runtime: string; committed_at: string } | undefined;
    return row ? { id: row.id, from: row.from_runtime, to: row.to_runtime, committedAt: row.committed_at } : null;
  } catch { return null; }
}

/** What `rig seat status` and a send to a switching seat show about a seat's open (or attention-holding) runtime switch. */
export interface RuntimeSwitchSummary {
  id: string; phase: string; from: string; to: string; committed: boolean; startedAt: string; deadlineAt: string;
  attention: string | null; outcome: string | null;
}

export function runtimeSwitchSummary(db: Database.Database, where: { nodeId: string } | { session: string }): RuntimeSwitchSummary | null {
  try {
    const row = db.prepare(`SELECT id, phase, from_runtime, to_runtime, committed_at, created_at, deadline_at, attention, outcome FROM seat_runtime_switches
      WHERE ${"nodeId" in where ? "node_id" : "canonical_session"} = ?
        AND (phase IN ('preparing', 'confirmed', 'committed') OR attention IS NOT NULL)
      ORDER BY created_at DESC LIMIT 1`).get("nodeId" in where ? where.nodeId : where.session) as
      { id: string; phase: string; from_runtime: string; to_runtime: string; committed_at: string | null; created_at: string; deadline_at: string; attention: string | null; outcome: string | null } | undefined;
    return row ? { id: row.id, phase: row.phase, from: row.from_runtime, to: row.to_runtime, committed: !!row.committed_at, startedAt: row.created_at,
      deadlineAt: row.deadline_at, attention: row.attention, outcome: row.outcome } : null;
  } catch { return null; }
}
