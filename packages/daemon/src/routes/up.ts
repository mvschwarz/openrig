import nodePath from "node:path";
import { Hono } from "hono";
import { bootstrapFailureResponse } from "./bootstrap-failure-response.js";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { UpCommandRouter } from "../domain/up-command-router.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { chooseRestoreSnapshot, joinAutomaticRestore, JOINED_AUTOMATIC_RESTORE_WARNING, runExistingRigRestore, type ExistingRigRestoreOutcome } from "../domain/existing-rig-restore.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";
import { loadTopologyManifest } from "../domain/topology/topology-manifest.js";
import { MultiRigLauncher } from "../domain/topology/multi-rig-launcher.js";
import { remoteUpLeaf } from "../domain/topology/remote-up-leaf.js";
import { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import type { HttpHostEntry } from "../domain/hosts/hosts-registry-reader.js";

export const upRoutes = new Hono();

/**
 * OPR.0.3.2.CT — assemble the 3-part error response body
 * (fact / consequence / action) when a bootstrap result carries an
 * import_rig stage with status='blocked' and detail.code ===
 * 'attention_required'. Returns null when the result is not in that
 * shape (caller falls through to the normal partial-success path).
 *
 * Exported for narrow unit tests so the HG-4 shape is pinned without
 * needing the full daemon harness. Pure on the result shape.
 */
export function buildAttentionResponse(result: {
  rigId?: string;
  stages: Array<{ stage: string; status: string; detail?: unknown }>;
}): {
  error: { fact: string; consequence: string; action: string };
  attentionNodes: import("../domain/types.js").AttentionNode[];
} | null {
  const attentionStage = result.stages.find(
    (s) => s.stage === "import_rig"
      && s.status === "blocked"
      && (s.detail as { code?: string } | undefined)?.code === "attention_required",
  );
  if (!attentionStage) return null;
  const detail = attentionStage.detail as {
    code: string;
    message: string;
    attentionNodes: import("../domain/types.js").AttentionNode[];
  };
  const nodeCount = detail.attentionNodes.length;
  const sessionAttachHints = detail.attentionNodes
    .filter((n) => n.sessionName)
    .map((n) => `tmux attach -t ${n.sessionName}`)
  const visibleAttachHints = sessionAttachHints.slice(0, 3).join(" ; ");
  const remainingAttachHintCount = Math.max(0, sessionAttachHints.length - 3);
  const attachHintText = visibleAttachHints
    ? `${visibleAttachHints}${remainingAttachHintCount > 0 ? ` ; plus ${remainingAttachHintCount} more listed in attentionNodes` : ""}`
    : "see `rig ps`";
  const rigIdDisplay = result.rigId ?? "(rigId unavailable)";
  return {
    error: {
      fact: detail.message,
      consequence: `Rig ${rigIdDisplay} is created and listable via \`rig ps\`. Members marked attention_required have not been proven interactive; a runtime may be waiting for input or may have exited.`,
      action: nodeCount === 1
        ? `Inspect the affected session and its reported reason before choosing recovery: ${attachHintText}.`
        : `Inspect each affected session listed in attentionNodes and its reported reason before choosing recovery: ${attachHintText}.`,
    },
    attentionNodes: detail.attentionNodes,
  };
}

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    upRouter: c.get("upRouter" as never) as UpCommandRouter,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    snapshotCapture: c.get("snapshotCapture" as never) as SnapshotCapture,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined,
    runtimeAdapters: c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined,
  };
}

/**
 * Restore a rig by ID from its latest restore-usable snapshot.
 *
 * L3b: prefers `auto-pre-down` when present (existing behavior preserved as a
 * preference signal) but falls back to the latest manual snapshot whose
 * structural metadata satisfies `RestoreOrchestrator.restore`'s pre-validation.
 * The response payload echoes `snapshotKind` so the operator/CLI can surface
 * which snapshot was used.
 *
 * Used by /api/up (rig_name). The Explorer's /api/rigs/:rigId/up keeps its own request and response
 * contract and shares joinAutomaticRestore.
 */
async function restoreByRigId(rigId: string, rigName: string | null, deps: ReturnType<typeof getDeps>, c: { json: (data: unknown, status?: number) => Response }, freshLogicalIds?: string[], plan?: boolean, nonInterruptive?: boolean) {
  const { snapshotRepo } = deps;
  // Daemon start restores a kernel a reboot left down. A request for that same restore, made while it
  // runs or just after, gets its outcome instead of a second launch or a refusal; see
  // joinAutomaticRestore for when the seats still count as that restore's. A request for something
  // else (--fresh seats, a non-interruptive choice, a plan) takes the ordinary path.
  if (!plan && !freshLogicalIds?.length && nonInterruptive === undefined) {
    const joined = await joinAutomaticRestore(deps, rigId);
    if (joined) return renderExistingRestore(rigId, rigName, deps, c, joined, true);
  }
  const choice = chooseRestoreSnapshot(deps, rigId);
  if (!choice.ok) return c.json(choice.body, choice.status);
  const { rig } = choice;

  // OPR.0.3.4.4 — read-only plan gate, BEFORE any restore mutation. The
  // rig_name path previously early-returned past the bootstrap plan gate, so
  // `rig up --existing <rig> --plan` mutated (the outage-01 bypass). Plan
  // mode never reaches restoreOrchestrator.restore(), and the auto-rehydrate
  // snapshot capture (itself a mutation) is reported as would-happen, never
  // performed.
  if (plan) {
    return c.json(buildRestorePlanPreview(rig, choice.snapshot ?? null, collectPreviewSessionRows(snapshotRepo.db, rig, choice.snapshot ?? null), freshLogicalIds, Date.now(), readFreshOccupantRelations(snapshotRepo.db, rig.rig.id)), 200);
  }

  const fs = await import("node:fs");
  const run = await runExistingRigRestore(deps, choice, {
    freshLogicalIds,
    nonInterruptive,
    exists: (p: string) => fs.existsSync(p),
  });
  return renderExistingRestore(rigId, rigName, deps, c, { ok: true, staleSnapshot: choice.staleSnapshot, ...run }, false);
}

async function renderExistingRestore(
  rigId: string, rigName: string | null, deps: ReturnType<typeof getDeps>,
  c: { json: (data: unknown, status?: number) => Response }, outcome: ExistingRigRestoreOutcome, joined: boolean,
) {
  if (!outcome.ok) return c.json(outcome.choice.body, outcome.choice.status);
  const { snapshot, capturedCurrentState, result, staleSnapshot } = outcome;
  const joinedWarning = joined ? [JOINED_AUTOMATIC_RESTORE_WARNING] : [];
  if (!result.ok && result.code === "restore_unavailable") {
    return c.json({ error: result.message }, 500);
  }
  if (!result.ok) {
    if (result.code === "pre_restore_validation_failed") {
      return c.json({
        status: "not_attempted",
        rigId,
        rigName,
        error: result.message,
        code: result.code,
        snapshotKind: snapshot.kind,
        ...result.result,
        remediation: result.result.blockers?.map((blocker) => blocker.remediation) ?? [],
      }, 409);
    }
    return c.json({ error: result.message, code: result.code, ...(joined ? { warnings: joinedWarning } : {}) }, result.code === "rig_not_stopped" ? 409 : 400);
  }

  // Compute attach command from first running node (same logic as /api/rigs/:id/up)
  const { getNodeInventory } = await import("../domain/node-inventory.js");
  const inventory = getNodeInventory(deps.snapshotRepo.db, rigId);
  const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
  const attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;

  return c.json({
    status: "restored",
    rigId,
    rigName,
    snapshotId: snapshot.id,
    snapshotKind: snapshot.kind,
    rigResult: result.result.rigResult,
    nodes: result.result.nodes,
    warnings: [...joinedWarning, ...(capturedCurrentState
      ? [staleSnapshot
          ? "Existing restore snapshots named an older occupant; captured current DB state as auto-rehydrate snapshot for reboot recovery."
          : "No restore-usable snapshot existed; captured current DB state as auto-rehydrate snapshot for reboot recovery.", ...result.result.warnings]
      : result.result.warnings)],
    attachCommand,
  }, 200);
}

// POST /api/up — the hero route
upRoutes.post("/", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, upRouter } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const nonInterruptive = typeof body["nonInterruptive"] === "boolean" ? body["nonInterruptive"] : undefined;
  const cwdOverride = typeof body["cwdOverride"] === "string" ? body["cwdOverride"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;

  if (!sourceRef) {
    return c.json({ error: "sourceRef is required" }, 400);
  }

  // Route source — classify raw sourceRef first, only resolve path for file-based kinds
  let sourceKind: string;
  let resolvedSourceRef = sourceRef;
  try {
    const route = upRouter.route(sourceRef);
    sourceKind = route.sourceKind;

    // Rig name: restore from latest auto-pre-down snapshot
    if (sourceKind === "rig_name") {
      const { rigRepo } = getDeps(c);
      const activeRigs = rigRepo.findUnarchivedRigsByName(sourceRef);
      const rigs = activeRigs.length > 0 ? activeRigs : rigRepo.findRigsByName(sourceRef);
      if (rigs.length === 0) {
        return c.json({ error: `No rig found named "${sourceRef}". Provide a .yaml spec path to create a new rig.`, code: "rig_not_found" }, 404);
      }
      if (rigs.length > 1) {
        const ids = rigs.map((r) => r.id).join(", ");
        return c.json({ error: `Multiple rigs named "${sourceRef}" found (IDs: ${ids}). Use rig restore --rig <rigId> with a specific rig ID.`, code: "ambiguous_name" }, 409);
      }
      const freshLogicalIds = Array.isArray(body["freshLogicalIds"])
        ? (body["freshLogicalIds"] as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      return restoreByRigId(rigs[0]!.id, sourceRef, getDeps(c), c, freshLogicalIds, plan, nonInterruptive) as any;
    }

    // File-based: resolve path now
    resolvedSourceRef = nodePath.resolve(sourceRef);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // ── OPR.0.4.4.11 — topology branch (FR-2..FR-5) ──────────────────────────
  if (sourceKind === "topology") {
    // R11-2 daemon side (arch ruling 4 — enforcement on the public write
    // path so every client inherits): a placement flag combined with a
    // topology source is rejected; per-entry `host:` is the ONLY topology
    // placement mechanism.
    if (typeof body["host"] === "string" && (body["host"] as string).trim() !== "") {
      return c.json(
        {
          error:
            "a topology source cannot take a host placement flag: per-entry 'host:' in the manifest is the ONLY placement mechanism for topologies (two placement mechanisms must not coexist). Put 'host: <id>' on the entries to place remotely.",
          code: "host_flag_topology",
        },
        400,
      );
    }
    if (plan) {
      return c.json({ error: "plan mode is not supported for topology sources in v0 — validate the manifest with a dry read or run the up directly", code: "topology_plan_unsupported" }, 400);
    }

    const manifestRes = loadTopologyManifest(resolvedSourceRef);
    if (!manifestRes.ok) {
      return c.json({ error: manifestRes.errors.join("\n"), errors: manifestRes.errors, code: "invalid_topology_manifest" }, 400);
    }

    // Path-form entry sources resolve against the MANIFEST's directory — the
    // manifest is the portable artifact (FR-1: same file, second
    // environment, same topology). Bare names pass through untouched.
    const manifestDir = nodePath.dirname(resolvedSourceRef);
    const resolveEntrySource = (source: string): string =>
      source.includes("/") || /\.(ya?ml|rigbundle|rigtopology)$/i.test(source)
        ? nodePath.resolve(manifestDir, source)
        : source;

    const launcher = new MultiRigLauncher({
      // The SAME public lock pair this route uses for single-rig ups
      // (guard G-2): the launcher participates in the route-side lock set.
      // resolveLocalRef makes the lock key IDENTICAL to the launch ref
      // (guard F1) — launchLocal receives the already-resolved ref.
      resolveLocalRef: resolveEntrySource,
      tryAcquire: (ref) => bootstrapOrchestrator.tryAcquire(ref),
      release: (ref) => bootstrapOrchestrator.release(ref),
      launchLocal: async (entryRef) => {
        let entryKind: string;
        try {
          entryKind = upRouter.route(entryRef).sourceKind;
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
        // Defense-in-depth only: the parse-time v0 source-form boundary in
        // the manifest validator (spec paths ONLY) rejects these before the
        // walk starts; these guards keep the leaf honest if a future caller
        // bypasses validation.
        if (entryKind === "topology") {
          return { ok: false, error: `entry '${entryRef}' is itself a topology — nested topologies are not supported; entries must be single-rig spec paths` };
        }
        if (entryKind === "rig_name") {
          return {
            ok: false,
            error: `entry '${entryRef}' resolves as an existing-rig name; v0 topology entries are spec paths only — restore existing rigs directly with 'rig up ${entryRef}'`,
          };
        }
        // The EXISTING single-rig leaf: the same public bootstrap() entry
        // this route calls — stages/locks/provenance untouched (FR-3).
        const result = await bootstrapOrchestrator.bootstrap({
          mode: "apply",
          sourceRef: entryRef,
          sourceKind: entryKind as "rig_spec" | "rig_bundle",
          autoApprove,
          nonInterruptive,
        });
        if (result.status === "completed") {
          eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef: entryRef });
          return { ok: true };
        }
        eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: entryRef, error: result.errors[0] ?? result.status });
        return { ok: false, error: result.errors[0] ?? `bootstrap ${result.status}` };
      },
      // The SHIPPED remote single-rig leaf (POST {host}/api/up). Path-form
      // refs resolve on the REMOTE daemon's filesystem — the shipped
      // remote-up semantics, unchanged.
      launchRemote: (source, host) => remoteUpLeaf({ sourceRef: source, autoApprove, nonInterruptive }, host as HttpHostEntry),
      loadRegistry: () => loadHostRegistry(),
    });

    const aggregate = await launcher.launch(manifestRes.manifest);
    // Honest aggregate either way: 200 only when EVERY entry is ok (FR-5).
    return c.json({ topology: sourceRef, ...aggregate }, aggregate.ok ? 200 : 500);
  }

  // Bundle apply requires targetRoot
  if (sourceKind === "rig_bundle" && !plan && !targetRoot) {
    return c.json({ error: "targetRoot is required for bundle apply mode" }, 400);
  }

  // Concurrency lock
  if (!bootstrapOrchestrator.tryAcquire(sourceRef)) {
    return c.json({ error: "Already in progress for this source", code: "conflict" }, 409);
  }

  try {
    if (plan) {
      // Plan mode — no run lifecycle
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "plan",
        sourceRef: resolvedSourceRef,
        sourceKind,
        cwdOverride,
        targetRoot,
      });

      if (result.status === "planned") {
        eventBus.emit({ type: "bootstrap.planned", runId: result.runId, sourceRef, stages: result.stages.length });
        return c.json(result, 200);
      }
      // Plan failed
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "plan failed" });
      const failure = bootstrapFailureResponse(result, "plan");
      return c.json(failure.body, failure.status);
    }

    // Apply mode — full lifecycle
    const run = bootstrapRepo.createRun(sourceKind, sourceRef);
    bootstrapRepo.updateRunStatus(run.id, "running");
    eventBus.emit({ type: "bootstrap.started", runId: run.id, sourceRef });

    try {
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "apply",
        sourceRef: resolvedSourceRef,
        sourceKind,
        autoApprove,
        nonInterruptive,
        cwdOverride,
        targetRoot,
        runId: run.id,
      });

      if (result.status === "completed") {
        eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef });

        // Compute attach command from first running node
        let attachCommand: string | null = null;
        if (result.rigId) {
          const { getNodeInventory } = await import("../domain/node-inventory.js");
          const inventory = getNodeInventory(bootstrapRepo.db, result.rigId);
          const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
          attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
        }

        return c.json({ ...result, attachCommand }, 201);
      }
      if (result.status === "partial") {
        const ok = result.stages.filter((s) => s.status === "ok").length;
        const fail = result.stages.filter((s) => s.status === "failed" || s.status === "blocked").length;
        eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef, rigId: result.rigId, completed: ok, failed: fail });

        // Compute attach command from first running node
        let attachCommand: string | null = null;
        if (result.rigId) {
          const { getNodeInventory } = await import("../domain/node-inventory.js");
          const inventory = getNodeInventory(bootstrapRepo.db, result.rigId);
          const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
          attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
        }

        // OPR.0.3.2.CT — when the partial outcome carries an
        // attention_required import_rig stage (either the all-attention
        // path from the instantiator's new outcome variant OR the
        // mixed launched+attention path the orchestrator routes the
        // same way), surface a 3-part error so the operator sees the
        // affected sessions and inspect their actual state. The rig + sessions are
        // PRESERVED on disk; `rig ps` lists them. PRD HG-4.
        const attentionResponse = buildAttentionResponse(result);
        if (attentionResponse) {
          return c.json({ ...result, attachCommand, ...attentionResponse }, 409);
        }

        return c.json({ ...result, attachCommand }, 200);
      }
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "failed" });
      const failure = bootstrapFailureResponse(result, "apply");
      return c.json(failure.body, failure.status);
    } catch (err) {
      bootstrapRepo.updateRunStatus(run.id, "failed");
      eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef, error: (err as Error).message });
      return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
    }
  } finally {
    bootstrapOrchestrator.release(sourceRef);
  }
});
