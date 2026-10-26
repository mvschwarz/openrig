// The TUI's selection/consent boundary. State comes from existing repositories;
// effects remain owned by kernel materialization, restore, and seat lifecycle.
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { RuntimeAdapter } from "../domain/runtime-adapter.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import type { ResumeMetadataRefresher } from "../domain/resume-metadata-refresher.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { Node, RigWithRelations } from "../domain/types.js";
import { defaultProbeRuntimes } from "../domain/kernel-boot.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../domain/restore-plan-preview.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "../domain/rehydrate-eligibility.js";
import { deriveCanonicalSessionName, deriveSessionName } from "../domain/session-name.js";
import { observeSolePane } from "../domain/pane-binding-observation.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { verifyCodexPaneProcess, verifyPaneIdleShell, type NativeProcessLister } from "../domain/native-process-lineage.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { seatLifecycleService } from "./seat.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";

export const startupRoutes = new Hono();
startupRoutes.use("*", async (c, next) => {
  const response = await authBearerTokenMiddleware({
    expectedToken: dep<string | null>(c, "terminalBearerToken") ?? null,
  })(c, next);
  if (response?.status === 401) return c.json({ ok: false, code: "terminal_auth_unavailable", freshAllowed: false,
    message: "This TUI cannot authenticate to the selected daemon. Check the instance and its terminal-token access, then refresh. No seat was started." }, 401);
  return response;
});
const active = new WeakMap<Database.Database, Set<string>>();
function dep<T>(c: Context, key: string): T { return c.get(key as never) as T; }
function repo(c: Context) { return dep<RigRepository>(c, "rigRepo"); }
function sessions(c: Context) { return dep<SessionRegistry>(c, "sessionRegistry"); }
function tmux(c: Context) { return dep<TmuxAdapter>(c, "tmuxAdapter"); }

/** A consent version derived from consumed state, never a second owner ledger. */
export function startupRevision(db: Database.Database, node: Node): string {
  const currentNode = db.prepare("SELECT * FROM nodes WHERE id = ?").get(node.id);
  const history = db.prepare("SELECT id, status, resume_type, resume_token FROM sessions WHERE node_id = ? ORDER BY id").all(node.id);
  const context = db.prepare("SELECT runtime, projection_entries_json, resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?").get(node.id);
  return createHash("sha256").update(JSON.stringify({ node: currentNode, history, context })).digest("hex");
}

async function exclusive(c: Context, key: string, action: () => Promise<Response>): Promise<Response> {
  const db = repo(c).db;
  let locks = active.get(db);
  if (!locks) { locks = new Set(); active.set(db, locks); }
  if (locks.has(key)) return c.json({ ok: false, code: "operation_in_progress", message: "This operation is already running. Refresh to reconcile its result." }, 409);
  locks.add(key);
  try { return await action(); } finally { locks.delete(key); }
}

function currentSnapshot(c: Context, rig: RigWithRelations) {
  const snapshot = dep<SnapshotRepository>(c, "snapshotRepo").findLatestRestoreUsable(rig.rig.id);
  return snapshot && snapshotMatchesCurrentOccupants(repo(c).db, rig, snapshot) ? snapshot : null;
}

async function observeSeat(c: Context, rig: RigWithRelations, node: Node) {
  const dot = node.logicalId.indexOf(".");
  const name = sessions(c).getBindingForNode(node.id)?.tmuxSession ?? (node.podId && dot > 0
    ? deriveCanonicalSessionName(node.logicalId.slice(0, dot), node.logicalId.slice(dot + 1), rig.rig.name)
    : deriveSessionName(rig.rig.name, node.logicalId));
  try {
    const presence = await tmux(c).probeSession(name);
    if (presence.state === "absent") return { state: "stopped", detail: "No live terminal", sessionName: name };
    if (presence.state === "transport_unavailable") return { state: "transport_unavailable",
      detail: "The terminal server is unavailable. Start/resume can attempt atomic creation; it cannot overwrite an existing terminal.", sessionName: name };
    const pane = await observeSolePane(tmux(c), name);
    if (!pane.ok) return { state: "unverified", detail: pane.detail, sessionName: name };
    if (node.runtime === "terminal") return { state: "running", detail: "Terminal is available", sessionName: name };
    const paneCommand = await tmux(c).getPaneCommand(pane.pane);
    const paneContent = (tmux(c).capturePaneScreen ? await tmux(c).capturePaneScreen(pane.pane) : await tmux(c).capturePaneContent(pane.pane, 40)) ?? "";
    const listProcesses = dep<NativeProcessLister | undefined>(c, "listProcesses");
    let probe = assessNativeResumeProbe({ runtime: node.runtime, paneCommand, paneContent });
    if (node.runtime === "codex" && (probe.code === "returned_to_shell" || probe.code === "awaiting_runtime")) {
      const process = await verifyCodexPaneProcess({ target: pane.pane, tmux: tmux(c), listProcesses });
      if (process) {
        const currentPaneCommand = await tmux(c).getPaneCommand(pane.pane);
        const currentPaneContent = (tmux(c).capturePaneScreen ? await tmux(c).capturePaneScreen(pane.pane) : await tmux(c).capturePaneContent(pane.pane, 40)) ?? "";
        probe = assessNativeResumeProbe({ runtime: node.runtime, paneCommand: currentPaneCommand,
          paneContent: currentPaneContent, codexProcessVerified: true });
      }
    }
    // A script-launched runtime reads as `sh` until the script hands over the foreground: name a shell only when proven idle.
    if (probe.code === "returned_to_shell" && !await verifyPaneIdleShell({ target: pane.pane, tmux: tmux(c),
      listProcesses })) {
      return { state: "attention_required", sessionName: name,
        detail: `The pane shows a shell that is not a proven idle shell; a launch script may still be starting ${node.runtime === "claude-code" ? "Claude" : "Codex"}.` };
    }
    return { state: probe.status === "resumed" ? "running" : "attention_required", detail: probe.detail, sessionName: name };
  } catch (error) {
    return { state: "unverified", detail: error instanceof Error ? error.message : String(error), sessionName: name };
  }
}

async function refreshNativeMetadata(c: Context, rigId: string) {
  const refresher = dep<ResumeMetadataRefresher | undefined>(c, "resumeMetadataRefresher");
  if (refresher) await refresher.refresh(sessions(c).getLatestLiveSessions(rigId), { fillNullOnly: true });
}

startupRoutes.get("/prerequisites", async (c) => c.json(await defaultProbeRuntimes()));
startupRoutes.post("/terminal", (c) => exclusive(c, "terminal", async () => {
  const result = await tmux(c).startServer();
  return c.json(result, result.ok ? 200 : 409);
}));

// First setup materializes the builtin topology only. No occupant is launched.
startupRoutes.post("/kernel", (c) => exclusive(c, "kernel", async () => {
  const body = await c.req.json().catch(() => ({}));
  if (body.runtime !== "codex" && body.runtime !== "claude-code") return c.json({ ok: false, message: "Choose an authenticated runtime for the new kernel." }, 400);
  const existing = repo(c).findRigsByName("kernel");
  if (existing.length > 1) return c.json({ ok: false, message: "More than one kernel exists; select an exact rig before continuing." }, 409);
  if (existing.length === 1) return c.json({ ok: true, rigId: existing[0]!.id, reused: true });
  const auth = await defaultProbeRuntimes();
  if ((body.runtime === "codex" ? auth.codex : auth.claudeCode) !== "ok") return c.json({ ok: false, code: "provider_prerequisite", message: "The selected runtime is unavailable or unauthenticated. Repair that prerequisite and retry; fresh history will not fix it." }, 409);
  const root = kernelRoot();
  const source = readFileSync(root + (body.runtime === "codex" ? "rig-codex-only.yaml" : "rig-claude-only.yaml"), "utf8");
  const result = await dep<PodRigInstantiator>(c, "podInstantiator").materialize(source, root, {
    cwdOverride: new SettingsStore().resolveConfig().workspaceRoot,
  });
  return c.json(result.ok ? { ok: true, rigId: result.result.rigId, message: "Kernel prepared. Choose the seats to start." } : result, result.ok ? 200 : 409);
}));

function kernelRoot() { return fileURLToPath(new URL("../../specs/rigs/launch/kernel/", import.meta.url)); }

startupRoutes.get("/:rigId", async (c) => {
  const rig = repo(c).getRig(c.req.param("rigId"));
  if (!rig) return c.json({ ok: false, message: "Rig is no longer available." }, 404);
  const snapshot = currentSnapshot(c, rig);
  const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(repo(c).db, rig, snapshot), undefined, Date.now(), readFreshOccupantRelations(repo(c).db, rig.rig.id));
  const auth = await defaultProbeRuntimes();
  const history = sessions(c).getSessionsForRig(rig.rig.id);
  const seats = [];
  for (const node of rig.nodes) {
    const forecast = plan.nodes.find((entry) => entry.logicalId === node.logicalId)!;
    const hasHistory = history.some((session) => session.nodeId === node.id);
    const available = node.runtime === "codex" ? auth.codex === "ok" : node.runtime === "claude-code" ? auth.claudeCode === "ok" : true;
    const observed = await observeSeat(c, rig, node);
    seats.push({ ...forecast, hasHistory, nodeId: node.id, runtime: node.runtime, model: node.model,
      revision: startupRevision(repo(c).db, node), observed,
      contextPending: history.some((session) => session.nodeId === node.id && dep<import("../domain/startup-orchestrator.js").StartupOrchestrator>(c, "startupOrchestrator")?.canContinueStartup(node.id, session.id)),
      freshAllowed: available && observed.state === "stopped",
      ...(!available ? { prerequisite: `${node.runtime} is unavailable or unauthenticated. Repair it and retry; fresh history cannot repair this prerequisite.` } : {}) });
  }
  return c.json({ rigId: rig.rig.id, rigName: rig.rig.name, seats });
});

startupRoutes.post("/:rigId/:logicalId", async (c) => {
  const rig = repo(c).getRig(c.req.param("rigId"));
  const node = rig?.nodes.find((entry) => entry.logicalId === c.req.param("logicalId"));
  if (!rig || !node) return c.json({ ok: false, message: "Selected seat is no longer available." }, 404);
  return exclusive(c, node.id, async () => {
    const body = await c.req.json().catch(() => ({}));
    if (!["resume", "start", "fresh", "continue"].includes(body.action) || typeof body.revision !== "string") return c.json({ ok: false, message: "A named action and current seat revision are required." }, 400);
    if (body.revision !== startupRevision(repo(c).db, node)) return c.json({ ok: false, code: "selection_changed", message: "The seat changed since this choice was displayed. Refresh and make a new decision." }, 409);
    const observed = await observeSeat(c, rig, node);
    if (body.action === "continue") {
      const result = await seatLifecycleService(c).continueStartup(observed.sessionName);
      await refreshNativeMetadata(c, rig.rig.id);
      return c.json(result, result.ok ? 200 : 409);
    }
    // A present or unprobeable pane is never overwritten, even on explicit fresh.
    if (observed.state !== "stopped" && !(observed.state === "transport_unavailable" && body.action !== "fresh")) return c.json({ ok: observed.state === "running", code: observed.state,
      message: observed.detail, sessionName: observed.sessionName }, observed.state === "running" ? 200 : 409);
    if (node.runtime === "codex" || node.runtime === "claude-code") {
      const auth = await defaultProbeRuntimes();
      if ((node.runtime === "codex" ? auth.codex : auth.claudeCode) !== "ok") return c.json({ ok: false, code: "provider_prerequisite", freshAllowed: false,
        message: `${node.runtime} is unavailable or unauthenticated. Repair it and retry. Starting a fresh conversation cannot repair authentication.` }, 409);
    }
    if (body.revision !== startupRevision(repo(c).db, node)) return c.json({ ok: false, code: "selection_changed",
      message: "The seat changed while prerequisites were checked. Refresh before making a new decision." }, 409);
    const history = sessions(c).getSessionsForRig(rig.rig.id).filter((session) => session.nodeId === node.id);
    if (body.action === "start" && history.length > 0) return c.json({ ok: false, code: "history_present", message: "This seat has prior history. Choose resume, or explicitly confirm a fresh conversation." }, 409);
    if (body.action === "fresh") {
      const result = await seatLifecycleService(c).launchFresh({ seatRef: observed.sessionName, fresh: true,
        reason: `TUI explicit fresh consent for ${node.logicalId}, observed revision ${body.revision}`, stop: false });
      await refreshNativeMetadata(c, rig.rig.id);
      if (result.ok) dep<SnapshotCapture>(c, "snapshotCapture").captureSnapshot(rig.rig.id, "auto-rehydrate");
      return c.json(result, result.ok ? 200 : 409);
    }
    // Never-occupied builtin seats reuse materialization's existing launch effect.
    if (history.length === 0 && rig.rig.name === "kernel") {
      const root = kernelRoot();
      const raw = RigSpecCodec.parse(readFileSync(root + (node.runtime === "codex" ? "rig-codex-only.yaml" : "rig-claude-only.yaml"), "utf8"));
      const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
      const pod = spec.pods.find((entry) => entry.id === node.logicalId.split(".")[0]);
      const member = pod?.members.find((entry) => `${pod.id}.${entry.id}` === node.logicalId);
      if (!pod || !member || member.agentRef !== node.agentRef || member.runtime !== node.runtime) return c.json({ ok: false, message: "This kernel seat differs from the installed definition; its owner must repair the startup source." }, 409);
      const result = await dep<PodRigInstantiator>(c, "podInstantiator").launchBinding({ rigId: rig.rig.id, rigSpec: spec, rigRoot: root, pod,
        member: { ...member, ...(node.model ? { model: node.model } : {}) }, qualifiedId: node.logicalId, nodeId: node.id, cwdOverride: node.cwd ?? undefined });
      await refreshNativeMetadata(c, rig.rig.id);
      dep<SnapshotCapture>(c, "snapshotCapture").captureSnapshot(rig.rig.id, "auto-rehydrate");
      const after = await observeSeat(c, rig, node);
      const ok = result.status === "launched" && after.state === "running";
      return c.json({ ...result, ok, observed: after, ...(!ok ? { message: after.detail, freshAllowed: false } : {}) }, ok ? 200 : 409);
    }
    const selectedRig = { ...rig, nodes: [node] };
    let snapshot = currentSnapshot(c, selectedRig);
    if (!snapshot) {
      const eligibility = assessCurrentStateRehydrateEligibility(repo(c).db, selectedRig);
      if (!eligibility.ok) return c.json({ ok: false, code: "startup_source_unavailable", message: eligibility.blockers.join("; ") }, 409);
      snapshot = dep<SnapshotCapture>(c, "snapshotCapture").captureSnapshot(rig.rig.id, "auto-rehydrate");
    }
    const forecast = buildRestorePlanPreview(selectedRig, snapshot, collectPreviewSessionRows(repo(c).db, selectedRig, snapshot)).nodes[0]!;
    if (history.length > 0 && forecast.intendedAction !== "resume-original") return c.json({ ok: false, code: "resume_unavailable", freshAllowed: forecast.freshRequired,
      message: forecast.reason ?? "The prior conversation cannot be resumed under this seat's configured policy. A fresh conversation needs a separate decision." }, 409);
    const result = await dep<RestoreOrchestrator>(c, "restoreOrchestrator").launchSingleNode(rig.rig.id, node.logicalId, {
      snapshotId: snapshot.id, adapters: dep<Record<string, RuntimeAdapter>>(c, "runtimeAdapters"), fsOps: { exists: existsSync },
    });
    const outcome = result.launched?.[0];
    const ok = result.ok && (!outcome || ["resumed", "fresh-primed"].includes(outcome.status));
    await refreshNativeMetadata(c, rig.rig.id);
    return c.json({ ...result, ok, code: outcome?.status ?? result.code,
      message: outcome?.error ?? result.message ?? (outcome?.status === "resumed" ? "Previous conversation resumed." : "Seat launch reconciled.") }, ok ? 200 : 409);
  });
});
