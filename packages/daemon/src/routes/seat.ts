import { OutboxHandler } from "../domain/outbox-handler.js";
import { Hono, type Context } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { DiscoveryRepository } from "../domain/discovery-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { observeClaudePaneStartedAt } from "../domain/native-process-lineage.js";
import { SeatStatusService } from "../domain/seat-status-service.js";
import { SeatHandoverService } from "../domain/seat-handover-service.js";
import { SeatRuntimeSwitchService, runtimeSwitchSummary } from "../domain/seat-runtime-switch-service.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { OCCUPANT_GENERATION_HEADER, runtimeSwitchCustodyRefusal } from "./runtime-switch-custody.js";
import { SeatSwitchClientService } from "../domain/seat-switch-client-service.js";
import { SeatLifecycleService } from "../domain/seat-lifecycle-service.js";
import { makePredecessorRecapResolver } from "../domain/predecessor-recap-resolver.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthoredRecapPointer } from "../domain/context-packs/seat-recap-store.js";
import { buildRebuildPrimingChain } from "../domain/rebuild-priming-chain.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { transportSenderSession } from "./require-sender-identity.js";
import type { SessionTransport } from "../domain/session-transport.js";
import { DeliveryGuardError } from "../domain/seat-delivery-guard.js";

export const seatRoutes = new Hono();

// Slice 16: a runtime switch's retired predecessor, or its staged successor before commit, doesn't act as the seat here
// either (the queue and send's narrow check). Reads, other callers and requests without a generation go on as before;
// the staged successor's own confirmation and a recovery are exempt.
seatRoutes.use("*", async (c, next) => {
  if (c.req.method === "GET" || /\/set-runtime\/[^/]+\/(confirm|recover)$/.test(c.req.path)) return next();
  const rigRepo = c.get("rigRepo" as never) as RigRepository | undefined;
  const refusal = rigRepo ? runtimeSwitchCustodyRefusal(rigRepo.db, transportSenderSession(c), c.req.header(OCCUPANT_GENERATION_HEADER)) : null;
  if (refusal) return c.json(refusal.body, refusal.status);
  return next();
});

// S09 is an independent delivery preference, never a lifecycle or permission change.
seatRoutes.post("/set-typing-guard/:seatRef", async c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "Delivery guard unavailable" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.reason !== "string" || !body.reason.trim()
    || (body.enabled === undefined) === (body.mode === undefined)
    || body.enabled !== undefined && typeof body.enabled !== "boolean"
    || body.holdSeconds !== undefined || body.maxAttempts !== undefined) {
    return c.json({ error: "Supply exactly one enabled boolean or mode, and a reason" }, 400);
  }
  const actor = transportSenderSession(c);
  if (!actor) return c.json({ error: "Sender identity required for preference audit" }, 400);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const preference = await guard.set(target.nodeId, { mode: body.mode ?? (body.enabled ? "hold" : "off") }, actor, body.reason);
    return c.json({ ...preference, tradeoff: "Hold retains all automatic input. Each draft-aware request attempts input or immediately holds with the exact refusal reason; retrying is a new attempt. Off permits new sends. Changing mode does not flush earlier held messages." }, preference.pending ? 202 : 200);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: (error as { code?: string }).code }, error instanceof DeliveryGuardError && error.code === "invalid_typing_guard" ? 400 : 409);
  }
});

seatRoutes.get("/held-messages/:seatRef", c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "Delivery guard unavailable" }, 503);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const outbox = new OutboxHandler(guard.db);
    const guarded = (c.get("sessionTransport" as never) as SessionTransport | undefined)?.guardedDelivery;
    const id = c.req.query("id");
    if (id) {
      const entry = outbox.getById(id);
      if (entry?.guardBinding?.nodeId !== target.nodeId) return c.json({ error: "No retained history for this node and ID" }, 404);
      const delivery = guarded?.lookup(id);
      return c.json({ entry, ...(delivery ? { delivery } : {}) });
    }
    const page = outbox.heldForNode(target.nodeId, Number(c.req.query("limit") ?? 100), Number(c.req.query("offset") ?? 0));
    return c.json({ ...page, items: page.items.map(entry => {
      const delivery = guarded?.lookup(entry.outboxId);
      return delivery ? { ...entry, delivery } : entry;
    }) });
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

seatRoutes.post("/retire-held-message/:seatRef/:id", async c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "Delivery guard unavailable" }, 503);
  const body = await c.req.json<Record<string, unknown>>();
  const actor = transportSenderSession(c);
  if (!actor || typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "Sender identity and reason required" }, 400);
  try {
    const target = guard.target(c.req.param("seatRef"));
    const outbox = new OutboxHandler(guard.db); const id = c.req.param("id");
    if (outbox.getById(id)?.guardBinding?.nodeId !== target.nodeId) return c.json({ error: "No held message for this node and ID" }, 404);
    const entry = outbox.retire(id, actor, body.reason);
    return c.json({ entry, effect: "Retired from active quota; evidence preserved. No delivery, native consumption or work closure is asserted." });
  } catch (error) { return c.json({ error: (error as Error).message }, 409); }
});

seatRoutes.get("/status/:seatRef", (c) => {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatStatusService({ rigRepo });
  const result = service.getStatus(c.req.param("seatRef")!);

  if (result.ok) {
    const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter | undefined)?.deliveryGuard;
    const target = guard?.maybeTarget(c.req.param("seatRef")!);
    const nodeId = rigRepo.getRig(result.status.rig_id)?.nodes.find((node) => node.logicalId === result.status.logical_id)?.id;
    const runtimeSwitch = nodeId ? runtimeSwitchSummary(rigRepo.db, { nodeId }) : null;
    return c.json({ ...result.status, ...(runtimeSwitch ? { runtimeSwitch } : {}), ...(guard && target ? { typingGuard: {
      ...guard.preference(target.nodeId), heldCount: new OutboxHandler(guard.db).heldForNode(target.nodeId, 1).total,
    } } : {}) });
  }

  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  return c.json(result, 404);
});

/** The handover's dependencies, which a runtime switch's successor launch shares. */
function handoverDeps(c: Context): ConstructorParameters<typeof SeatHandoverService>[0] {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  return {
    codexPermissions: (c.get("currentModelReader" as never) as import("../domain/model-divergence/current-model-reader.js").CurrentModelReader | undefined) ?? undefined,
    db: rigRepo.db,
    rigRepo,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    discoveryRepo: c.get("discoveryRepo" as never) as DiscoveryRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    sessionEnv: (c.get("sessionEnv" as never) as Record<string, string | undefined> | undefined) ?? undefined,
    runtimeSessionEnv: (c.get("runtimeSessionEnv" as never) as Record<string, Record<string, string | undefined>> | undefined) ?? undefined,
    // B1 — launch a fresh successor into a live agent via the runtime adapters.
    runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? undefined,
    // OPR.0.4.6.02 S1 — the shared tmux option-defaults applier, so a FRESH
    // handover successor gets the same mouse/status/clipboard defaults as a
    // launched seat (orch C1 scope ruling).
    tmuxOptionDefaults: (c.get("tmuxOptionDefaults" as never) as import("../domain/tmux-option-defaults.js").TmuxOptionDefaultsApplier | undefined) ?? undefined,
    // B2 — discovered-mode resume-token capture derive-helper deps.
    contextUsageStore: (c.get("contextUsageStore" as never) as import("../domain/resume-token-capture.js").ResumeTokenCaptureDeps["contextUsageStore"]) ?? undefined,
    resumeTokenCapturer: (c.get("resumeMetadataRefresher" as never) as import("../domain/resume-token-capture.js").ResumeTokenCaptureDeps["resumeTokenCapturer"]) ?? undefined,
    // #421 — the pane's current Claude process start time, so capture skips an older sidecar.
    claudeProcessStartedAt: (sessionName: string) => observeClaudePaneStartedAt({ target: sessionName, tmux: c.get("tmuxAdapter" as never) as TmuxAdapter }),
    // Wire the predecessor-recap resolver so the successor boot packet fires
    // with a bounded from-record recap. Reuses the full ContextUsageStore from context (readAndNormalize
    // = claude transcript_path; readCodexAndNormalize = codex rollout_path) + a resume-token lookup for
    // the codex thread id; parseJsonlExchanges is the resolver's default. Absent store → resolver omitted
    // (recap sections omitted honestly). Firing proven live in the money-proof e2e.
    predecessorRecapResolver: (() => {
      const store = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
      if (!store) return undefined;
      const db = rigRepo.db;
      return makePredecessorRecapResolver({
        // B16 — session_id rides the read so the resolver can verify the name-keyed sidecar is the
        // PREDECESSOR's (canonical-name reuse means a booted successor overwrites it).
        readClaudeRecord: (sessionName) => {
          const usage = store.readAndNormalize(sessionName);
          return { transcriptPath: usage.transcriptPath, sessionId: usage.sessionId ?? null };
        },
        readCodexTranscriptPath: (args) => store.readCodexAndNormalize(args).transcriptPath,
        lookupResumeToken: (nodeId, sessionName) => {
          const row = db
            .prepare("SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1")
            .get(nodeId, sessionName) as { resume_token: string | null } | undefined;
          return row?.resume_token ?? null;
        },
      });
    })(),
    // OPR.0.5.3.5 mini-req 7 — the AUTHORED recap pointer for the successor
    // packet: seat dir from topology.root CONFIG (slice-06 D1 layout); every
    // outcome labeled — present with chain depth, or a named absence carrying
    // the path tried (a seat-id/directory mapping gap surfaces loudly at the
    // door drive instead of silently).
    authoredRecapResolver: (seatRef: string) => {
      const topologyRoot = String(new SettingsStore().resolveOne("topology.root").value);
      return resolveAuthoredRecapPointer(seatRef, topologyRoot);
    },
    // OPR.0.5.5.5 (fix B3) — the ONE production rebuild priming chain builder
    // (rebuild-priming-chain.ts): RECAP.md, LEARNED.md, latest restore packet
    // when the seat's restore-pending marker names one, superseded recaps
    // newest-first. Declares only; the service existence-filters (named gaps).
    rebuildPrimingResolver: (seatRef: string) => buildRebuildPrimingChain(seatRef, {
      topologyRoot: String(new SettingsStore().resolveOne("topology.root").value),
      openrigHome: OPENRIG_HOME,
    }),
    // OPR.0.4.6.PI1 FR-6 — the Pi adapter in the runtime-adapter map exposes
    // the pi-runner sidecar reader; reuse it structurally (no new context var).
    piRunnerStateStore: (() => {
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const pi = adapters?.["pi"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      return typeof pi?.readSessionFile === "function"
        ? { readSessionFile: pi.readSessionFile.bind(pi) as (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } }
        : undefined;
    })(),
    ompRunnerStateStore: (() => {
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const omp = adapters?.["omp"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      return typeof omp?.readSessionFile === "function"
        ? { readSessionFile: omp.readSessionFile.bind(omp) }
        : undefined;
    })(),
    // GHOST-STAGE (e/Class-B) — the canonical OccupantInvalidator so commit()'s re-key call fires
    // (invalidate the retiring occupant's seat-name-keyed stores before the successor accumulates any).
    occupantInvalidator: (c.get("occupantInvalidator" as never) as import("../domain/occupant-invalidator.js").OccupantInvalidator | undefined) ?? undefined,
    // WAVE-O B1 (R2 508e383d) — the daemon's ONE SeatActivityService rides every
    // production handover construction, so a real committed swap reaches
    // declareOccupantSwap and the successor never inherits the retiree's evidence or
    // promoted rung authority. Optional in the deps contract; ALWAYS wired here.
    activityOracle: (c.get("seatActivityService" as never) as import("../domain/seat-activity-service.js").SeatActivityService | undefined) ?? undefined,
  };
}

/** Slice 16: the live runtime switch, sharing the handover's dependencies. */
function runtimeSwitchService(c: Context): SeatRuntimeSwitchService {
  const instantiator = c.get("podInstantiator" as never) as { runtimeSwitchMaterialContext?: () => { skillsRoot?: string; systemSkills?: string[]; systemWorldError?: string } } | undefined;
  return new SeatRuntimeSwitchService({ ...handoverDeps(c), queueRepo: c.get("queueRepo" as never) as QueueRepository | undefined,
    materialResolution: instantiator?.runtimeSwitchMaterialContext?.(), openrigHome: OPENRIG_HOME });
}

const RUNTIME_SWITCH_STATUS: Record<string, number> = {
  invalid_runtime_settings: 400, seat_ref_required: 400, seat_not_found: 404, runtime_target_unavailable: 422,
};

seatRoutes.post("/set-runtime/:seatRef", async (c) => {
  const parsed: unknown = await c.req.json().catch(() => ({}));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return c.json({ ok: false, code: "invalid_runtime_settings", message: "The request must be a JSON object." }, 400);
  }
  const body = parsed as Record<string, unknown>;
  const text = (key: string): string | undefined | null => body[key] === undefined ? undefined : typeof body[key] === "string" ? body[key] as string : null;
  const fields = { runtime: text("runtime"), reason: text("reason"), model: text("model"), effort: text("effort"),
    codexConfigProfile: text("codexConfigProfile"), permissionMode: text("permissionMode") };
  const wrong = Object.entries(fields).find(([, value]) => value === null);
  if (wrong) return c.json({ ok: false, code: "invalid_runtime_settings", message: `${wrong[0]} must be a string.` }, 400);
  if (body["dryRun"] !== undefined && typeof body["dryRun"] !== "boolean") {
    return c.json({ ok: false, code: "invalid_runtime_settings", message: "dryRun must be true or false." }, 400);
  }
  const timeout = body["confirmTimeoutSeconds"];
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 10 || timeout > 3600)) {
    return c.json({ ok: false, code: "invalid_runtime_settings", message: "confirmTimeoutSeconds must be a whole number from 10 to 3600." }, 400);
  }
  const result = await runtimeSwitchService(c).setRuntime({
    seatRef: c.req.param("seatRef")!, runtime: fields.runtime ?? "", reason: fields.reason ?? "",
    requestedBy: transportSenderSession(c) ?? null, dryRun: body["dryRun"] === true,
    ...(fields.model ? { model: fields.model } : {}), ...(fields.effort ? { effort: fields.effort } : {}),
    ...(fields.codexConfigProfile ? { codexConfigProfile: fields.codexConfigProfile } : {}),
    ...(fields.permissionMode ? { permissionMode: fields.permissionMode } : {}),
    ...(typeof timeout === "number" ? { confirmTimeoutMs: timeout * 1000 } : {}),
  });
  if (result.ok) return c.json(result, "recoveryPending" in result && result.recoveryPending ? 202 : 200);
  return c.json(result, (RUNTIME_SWITCH_STATUS[result.code] ?? 409) as 400);
});

// The staged successor's confirmation: only its own reserved generation (the caller's X-OpenRig-Occupant-Generation).
seatRoutes.post("/set-runtime/:seatRef/confirm", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const result = runtimeSwitchService(c).confirm({
    seatRef: c.req.param("seatRef")!, switchId: typeof body["switchId"] === "string" ? body["switchId"] : "",
    note: typeof body["note"] === "string" ? body["note"] : "", actorSession: transportSenderSession(c) ?? null,
    generation: c.req.header(OCCUPANT_GENERATION_HEADER) ?? null,
  });
  return result.ok ? c.json(result) : c.json(result, 409);
});

seatRoutes.post("/set-runtime/:seatRef/recover", async (c) => {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const status = new SeatStatusService({ rigRepo }).getStatus(c.req.param("seatRef")!);
  if (!status.ok) return c.json(status, status.code === "seat_ambiguous" ? 409 : status.code === "seat_ref_required" ? 400 : 404);
  const nodeId = rigRepo.getRig(status.status.rig_id)?.nodes.find((node) => node.logicalId === status.status.logical_id)?.id;
  if (!nodeId) return c.json({ ok: false, code: "seat_not_found", message: `No seat ${c.req.param("seatRef")}.` }, 404);
  const result = await runtimeSwitchService(c).recover(nodeId);
  return result.ok ? c.json(result) : c.json(result, 409);
});


seatRoutes.post("/handover/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const service = new SeatHandoverService(handoverDeps(c));
  const result = await service.handover({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : null,
    source: typeof body["source"] === "string" ? body["source"] : null,
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
    dryRun: body["dryRun"] === true,
  });

  if (result.ok) {
    return c.json("plan" in result ? result.plan : result.result);
  }

  if (result.code === "missing_reason" || result.code === "invalid_source") {
    return c.json(result, 400);
  }
  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "successor_creation_not_implemented" ||
    result.code === "source_not_supported") {
    return c.json(result, 501);
  }
  if (result.code === "tmux_probe_failed") {
    return c.json(result, 502);
  }
  if (result.code === "address_conflict" || result.code === "current_occupant_required" ||
    result.code === "discovered_not_active" ||
    result.code === "successor_tmux_absent" ||
    result.code === "successor_already_managed" ||
    result.code === "successor_is_current" ||
    result.code === "runtime_mismatch") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  if (result.code === "handover_commit_failed" ||
    result.code === "successor_create_failed" ||
    result.code === "context_delivery_failed") {
    return c.json(result, 500);
  }
  return c.json(result, 404);
});

// S5 (OPR.0.5.4.7) — the seat-lifecycle verb surface: set-model / stop / clean.
// One service, one resolution path, one status mapping shared by all three verbs.
export function seatLifecycleService(c: { get(key: never): unknown }): SeatLifecycleService {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  return new SeatLifecycleService({
    db: rigRepo.db,
    rigRepo,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    eventBus: c.get("eventBus" as never) as EventBus,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    nodeLauncher: c.get("nodeLauncher" as never) as import("../domain/node-launcher.js").NodeLauncher,
    startupOrchestrator: (c.get("startupOrchestrator" as never) as import("../domain/startup-orchestrator.js").StartupOrchestrator | undefined) ?? undefined,
    runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? undefined,
    occupantInvalidator: (c.get("occupantInvalidator" as never) as import("../domain/occupant-invalidator.js").OccupantInvalidator | undefined) ?? undefined,
    activityOracle: (c.get("seatActivityService" as never) as import("../domain/seat-activity-service.js").SeatActivityService | undefined) ?? undefined,
    transcripts: (c.get("contextUsageStore" as never) as ContextUsageStore | undefined) ?? undefined,
    piRecords: (c.get("currentModelReader" as never) as import("../domain/model-divergence/current-model-reader.js").CurrentModelReader | undefined) ?? undefined,
  });
}

function seatLifecycleStatus(code: string): 400 | 404 | 409 | 500 | 502 {
  if (code === "seat_ref_required" || code === "missing_model" || code === "missing_reason" || code === "fresh_required"
    || code === "missing_effort" || code === "invalid_effort" || code === "invalid_policy"
    || code === "missing_cwd" || code === "invalid_cwd" || code === "invalid_stop_precondition") return 400;
  if (code === "seat_not_found") return 404;
  if (code === "tmux_probe_failed") return 502;
  if (code === "launch_unavailable" || code === "runtime_adapter_missing" || code === "launch_failed" || code === "startup_failed"
    || code === "effort_unavailable" || code === "cwd_check_failed" || code === "cwd_persistence_failed") return 500;
  // seat_ambiguous / session_live / session_not_live / no_session / claimed_session /
  // nothing_to_clean — state conflicts, not client syntax errors.
  return 409;
}

seatRoutes.post("/set-terminal-policy/:seatRef", async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = transportSenderSession(c) ?? (typeof body.operator === "string" ? body.operator : "");
  if (body.rigDefault !== undefined && typeof body.rigDefault !== "boolean") return c.json({ error: "rigDefault must be boolean" }, 400);
  const result = seatLifecycleService(c).setTerminalPolicy({ seatRef: c.req.param("seatRef"),
    preset: body.preset, helpers: body.helpers, exceptions: body.exceptions,
    reason: typeof body.reason === "string" ? body.reason : "", actor, rigDefault: body.rigDefault === true });
  return c.json(result, result.ok ? 200 : result.code === "invalid_terminal_policy" || result.code === "actor_required" ? 400 : seatLifecycleStatus(result.code));
});

seatRoutes.post("/set-permissions/:seatRef", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = transportSenderSession(c) ?? (typeof body?.operator === "string" ? body.operator.trim() : undefined);
  if (!actor) return c.json({ error: "Sender identity is required; pass --operator <address> when running outside a managed seat." }, 400);
  if (!body || Array.isArray(body) || typeof body.mode !== "string") return c.json({ error: "mode is required" }, 400);
  if (typeof body.reason !== "string") return c.json({ error: "reason is required" }, 400);
  const result = await seatLifecycleService(c).setPermissions({
    seatRef: c.req.param("seatRef"), mode: body.mode, reason: body.reason, actor,
  });
  return c.json(result, result.ok ? 200 : seatLifecycleStatus(result.code));
});

// `rig policy apply <name> --seat`: re-point an existing seat's stored permission_policy; the running process is unchanged.
seatRoutes.post("/set-policy/:seatRef", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = transportSenderSession(c) ?? (typeof body?.operator === "string" ? body.operator.trim() : undefined);
  if (!actor) return c.json({ error: "Sender identity is required; pass --operator <address> when running outside a managed seat." }, 400);
  if (!body || Array.isArray(body) || typeof body.ref !== "string") return c.json({ error: "ref is required" }, 400);
  const result = await seatLifecycleService(c).setPolicy({
    seatRef: c.req.param("seatRef"), ref: body.ref, reason: typeof body.reason === "string" ? body.reason : "", actor,
  });
  return c.json(result, result.ok ? 200 : seatLifecycleStatus(result.code));
});

seatRoutes.post("/set-model/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).setModel({
    seatRef: c.req.param("seatRef")!,
    model: typeof body["model"] === "string" ? body["model"] : "",
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: transportSenderSession(c) ?? (typeof body["operator"] === "string" ? body["operator"] : null),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/set-cwd/:seatRef", async (c) => {
  const value: unknown = await c.req.json().catch(() => null);
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = await seatLifecycleService(c).setCwd({
    seatRef: c.req.param("seatRef"),
    cwd: typeof body.cwd === "string" ? body.cwd : "",
    reason: typeof body.reason === "string" ? body.reason : "",
    operator: transportSenderSession(c) ?? (typeof body.operator === "string" ? body.operator : null),
  });
  return c.json(result, result.ok ? 200 : seatLifecycleStatus(result.code));
});

// OPR.0.7.0.7 — save (or, with clear: true, remove) one seat's effort choice for its next
// managed continuation. A distinct route fails closed against daemons without it.
seatRoutes.post("/set-effort/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const clear = body["clear"] === true;
  if (clear && body["effort"] !== undefined) return c.json({ ok: false, code: "invalid_effort", message: "Pass an effort level or clear, not both." }, 400);
  const result = await seatLifecycleService(c).setEffort({
    seatRef: c.req.param("seatRef")!,
    effort: clear ? null : typeof body["effort"] === "string" ? body["effort"] : "",
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: transportSenderSession(c) ?? (typeof body["operator"] === "string" ? body["operator"] : null),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.7.0.7 — read one seat's effort four ways: requested, saved, emitted at launch, observed natively.
seatRoutes.get("/effort/:seatRef", async (c) => {
  const result = await seatLifecycleService(c).effortReport(c.req.param("seatRef")!);
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// A distinct route fails closed against older daemons that do not support previews.
seatRoutes.post("/launch-plan/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).planFresh({
    seatRef: c.req.param("seatRef")!, fresh: body["fresh"] === true, stop: body["stop"] === true,
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/launch/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).launchFresh({
    seatRef: c.req.param("seatRef")!,
    fresh: body["fresh"] === true,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    stop: body["stop"] === true,
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.7.0.5 — in-place restart. A refusal (nothing was stopped) is an error status; once a restart ran,
// the reply is 200 and its `outcome` says what happened, so a not-started/incomplete/unknown result is
// reported, never retried by the transport.
seatRoutes.post("/restart-plan/:seatRef", async (c) => {
  const result = await seatLifecycleService(c).restartInPlace({ seatRef: c.req.param("seatRef")!, plan: true });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/restart/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).restartInPlace({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/restart-verify/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).verifyRestartInPlace({
    seatRef: c.req.param("seatRef")!,
    expectAccount: typeof body["expectAccount"] === "string" ? body["expectAccount"] : null,
  });
  return result.ok ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/continue/:seatRef", async (c) => {
  const result = await seatLifecycleService(c).continueStartup(c.req.param("seatRef"));
  return c.json(result, result.ok ? 200 : 409);
});

seatRoutes.get("/stop-precondition/:seatRef", c => {
  const result = seatLifecycleService(c).stopPrecondition(c.req.param("seatRef")!);
  return "contract" in result ? c.json(result) : c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/stop/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).stopSeat({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
    ...(Object.prototype.hasOwnProperty.call(body, "expected") ? { expected: body["expected"] } : {}),
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/clean/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).cleanSeat({
    seatRef: c.req.param("seatRef")!,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.4.3.26 — seat-recovery VIEW retarget. Points an attached tmux client at
// the seat's canonical session/window. VIEW-ONLY: it resolves the seat READ-ONLY
// (SeatStatusService) and only probes/switches via the tmux adapter (already in
// context). It does NOT construct SeatHandoverService / SessionRegistry writes /
// ClaimService and never routes through converge/reconcile — no routing,
// binding, session, transcript, or identity mutation is possible here.
seatRoutes.post("/switch-client/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatSwitchClientService({
    rigRepo,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
  });

  const rawWindow = body["toWindow"];
  const toWindow = typeof rawWindow === "number" && Number.isInteger(rawWindow) ? rawWindow : null;

  const result = await service.switchClient({
    seatRef: c.req.param("seatRef")!,
    client: typeof body["client"] === "string" && body["client"] !== "" ? body["client"] : null,
    toWindow,
  });

  if (result.ok) {
    return c.json(result.result);
  }

  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  if (result.code === "seat_not_found" ||
    result.code === "client_not_found" ||
    result.code === "window_not_found") {
    return c.json(result, 404);
  }
  if (result.code === "seat_ambiguous" ||
    result.code === "missing_canonical_session" ||
    result.code === "session_not_found" ||
    result.code === "no_client" ||
    result.code === "ambiguous_client") {
    return c.json(result, 409);
  }
  // switch_failed / tmux_probe_failed — a tmux-layer failure, not a client error.
  return c.json(result, 502);
});
