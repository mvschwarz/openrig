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
import type { Node, RigWithRelations, Snapshot, SnapshotData } from "../domain/types.js";
import { defaultProbeRuntimes } from "../domain/kernel-boot.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../domain/restore-plan-preview.js";
import { assessCurrentStateRehydrateEligibility } from "../domain/rehydrate-eligibility.js";
import { currentRestoreSnapshot } from "../domain/current-restore-snapshot.js";
import { HISTORY_REF_RE, listSharedHistories } from "../domain/shared-history-selection.js";
import { deriveCanonicalSessionName, deriveSessionName } from "../domain/session-name.js";
import { observeSolePane } from "../domain/pane-binding-observation.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { verifyCodexPaneProcess, verifyPaneIdleShell, type NativeProcessLister } from "../domain/native-process-lineage.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { seatLifecycleService } from "./seat.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";
import { NativePermissionStore } from "../domain/native-permission-store.js";
import { readSeatEffort } from "../domain/seat-effort.js";

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
  return currentRestoreSnapshot(repo(c).db, dep<SnapshotRepository>(c, "snapshotRepo"), rig);
}

function sharedHistoryDeps(c: Context) {
  return { rigRepo: repo(c), snapshotRepo: dep<SnapshotRepository>(c, "snapshotRepo"),
    restoreOrchestrator: dep<RestoreOrchestrator>(c, "restoreOrchestrator") };
}

type HistoryRefs = { snapshotId: string; historySessionId: string };
type SelectedState = { review: string; native: string } | { permissionUnavailable: true };

/** The captured locator must still name the registry's same native history.
 * Status and verification freshness can change without changing that identity. */
function selectedSourceMatches(captured: SnapshotData["sessions"][number], live: Record<string, unknown>): boolean {
  return captured.resumeType === live.resume_type
    && captured.resumeToken === live.resume_token
    && (captured.resumeProvenance ?? null) === (live.resume_provenance ?? null)
    && (captured.restorePolicy ?? "resume_if_possible") === (live.restore_policy ?? "resume_if_possible")
    && (captured.communityHarness ?? null) === (live.agent_app ?? null);
}

/** The existing launch override is a pure persisted-settings resolution. It
 * includes member envelopes/rules as well as an explicit mode and defaults. */
function selectedPermissionFacts(c: Context, rigId: string, nodeId: string, runtime: string) {
  const store = new NativePermissionStore(repo(c).db);
  const choice = store.read(nodeId);
  const plannedOverride = store.launchOverride(nodeId, runtime);
  const resolved = store.resolve(nodeId, runtime);
  // Restore consumes the override first, then re-derives the policy posture
  // from its saved provenance. A readable custom policy can differ from the
  // persisted cache, so review exactly that pure decision as well.
  const plannedLaunchPosture = plannedOverride.codexPermissions || plannedOverride.permissionMode
    ? null : plannedOverride.launchPosture ?? dep<RestoreOrchestrator>(c, "restoreOrchestrator").resolveRestorePosture(nodeId, rigId);
  const mode = plannedOverride.codexPermissions ? null : plannedOverride.permissionMode
    ?? (plannedLaunchPosture === "auto" && runtime !== "claude-code" ? "floor"
      : plannedLaunchPosture === "floor" && runtime === "claude-code" ? "acceptEdits" : plannedLaunchPosture);
  return { mode,
    source: plannedOverride.codexPermissions ? "member_envelope" : choice ? "saved_choice" : resolved.source,
    plannedOverride, plannedLaunchPosture,
    ...(plannedOverride.claudePermissions ? { rulesSource: "member_rules" } : {}) };
}

function selectedFacts(c: Context, rigId: string, nodeId: string, refs: HistoryRefs) {
  const rig = repo(c).getRig(rigId);
  const node = rig?.nodes.find(item => item.id === nodeId);
  if (!rig || !node) return null;
  const snapshot = currentRestoreSnapshot(repo(c).db, dep<SnapshotRepository>(c, "snapshotRepo"), rig, nodeId);
  if (!snapshot || snapshot.id !== refs.snapshotId) return null;
  return { rig, node, snapshot };
}

/** Exact review inputs. Native checks omit expected changes to status/binding
 * made by this very launch, while still fencing source identity and settings. */
function selectedState(c: Context, rigId: string, nodeId: string, refs: HistoryRefs, snapshot: Snapshot): SelectedState | null {
  const db = repo(c).db;
  const one = (sql: string, ...args: string[]) => db.prepare(sql).get(...args);
  const rig = one("SELECT * FROM rigs WHERE id = ?", rigId);
  const node = one("SELECT * FROM nodes WHERE id = ? AND rig_id = ?", nodeId, rigId);
  const source = one("SELECT * FROM sessions WHERE id = ? AND node_id = ?", refs.historySessionId, nodeId) as Record<string, unknown> | undefined;
  const saved = one("SELECT id, data, status, kind FROM snapshots WHERE id = ? AND rig_id = ?", refs.snapshotId, rigId) as
    { id: string; data: string; status: string; kind: string } | undefined;
  if (!rig || !node || !source || !saved) return null;
  let data: SnapshotData;
  try { data = JSON.parse(saved.data) as SnapshotData; } catch { return null; }
  const selectedRows = data.sessions?.filter(row => row.nodeId === nodeId && row.id === refs.historySessionId) ?? [];
  const savedNode = data.nodes?.find(item => item.id === nodeId);
  if (!savedNode || selectedRows.length !== 1 || !selectedSourceMatches(selectedRows[0]!, source)) return null;
  const savedSelection = { id: saved.id, status: saved.status, kind: saved.kind,
    node: savedNode, source: selectedRows[0], startupContext: data.nodeStartupContext?.[nodeId] ?? null,
    activeOccupant: data.activeOccupantsByNode?.[nodeId] ?? null,
    legacyOccupant: data.activeSessionIdByNode?.[nodeId] ?? null,
    rosterIncludes: data.topologyRoster?.intendedNodeIds.includes(nodeId) ?? null };
  const { status: _status, last_seen_at: _seen, startup_status: _startup, ...stableSource } = source;
  const context = one("SELECT * FROM node_startup_context WHERE node_id = ?", nodeId);
  const permissions = one("SELECT * FROM node_permission_selections WHERE node_id = ?", nodeId);
  let permissionPlan: ReturnType<typeof selectedPermissionFacts>;
  try { permissionPlan = selectedPermissionFacts(c, rigId, nodeId, savedNode.runtime ?? ""); }
  catch { return { permissionUnavailable: true }; }
  const stable = { rig, node, savedSelection, stableSource, context, permissions, permissionPlan };
  const native = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  const histories = db.prepare("SELECT id, status, resume_type, resume_token, restore_policy FROM sessions WHERE node_id = ? ORDER BY id").all(nodeId);
  const binding = one("SELECT * FROM bindings WHERE node_id = ?", nodeId);
  const occupancy = readFreshOccupantRelations(db, rigId)[nodeId] ?? null;
  const review = createHash("sha256").update(JSON.stringify({ stable, histories, binding, occupancy,
    snapshotId: snapshot.id, historySessionId: refs.historySessionId })).digest("hex");
  return { review, native };
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

startupRoutes.get("/:rigId/nodes/:nodeId/history", (c) => {
  if (new URL(c.req.url).search) return c.json({ ok: false, code: "invalid_request", message: "This list takes no query fields." }, 400);
  const result = listSharedHistories(sharedHistoryDeps(c), c.req.param("rigId"), c.req.param("nodeId"));
  return c.json(result, result.ok ? 200 : result.code === "seat_unavailable" ? 404 : 409);
});

startupRoutes.post("/:rigId/nodes/:nodeId/history/validate", async (c) => {
  if (new URL(c.req.url).search) return c.json({ ok: false, code: "invalid_request", message: "Validation takes no query fields." }, 400);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).sort().join(",") !== "historySessionId,snapshotId"
    || typeof (body as Record<string, unknown>).snapshotId !== "string"
    || typeof (body as Record<string, unknown>).historySessionId !== "string"
    || !HISTORY_REF_RE.test((body as { snapshotId: string }).snapshotId)
    || !HISTORY_REF_RE.test((body as { historySessionId: string }).historySessionId)) {
    return c.json({ ok: false, code: "invalid_request", message: "Supply one snapshotId and historySessionId from the history list." }, 400);
  }
  const refs = body as { snapshotId: string; historySessionId: string };
  const result = listSharedHistories(sharedHistoryDeps(c), c.req.param("rigId"), c.req.param("nodeId"), refs);
  if (!result.ok) return c.json(result, result.code === "seat_unavailable" ? 404 : 409);
  return c.json({ ok: true, rigId: result.rigId, nodeId: result.nodeId, logicalId: result.logicalId,
    snapshotId: result.snapshotId, history: result.histories[0], eligibleForAttempt: true, mutated: false });
});

function selectedRefs(value: unknown, apply = false): (HistoryRefs & { revision?: string }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (keys !== (apply ? "action,historySessionId,revision,snapshotId" : "historySessionId,snapshotId")
    || !HISTORY_REF_RE.test(String(body.snapshotId)) || !HISTORY_REF_RE.test(String(body.historySessionId))
    || typeof body.snapshotId !== "string" || typeof body.historySessionId !== "string") return null;
  if (apply && (body.action !== "resume" || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision))) return null;
  return { snapshotId: body.snapshotId, historySessionId: body.historySessionId,
    ...(apply ? { revision: body.revision as string } : {}) };
}

function redactDiagnostic(value: string | null | undefined, tokens: readonly string[]): string | null {
  if (value == null) return null;
  return tokens.reduce((text, token) => text.replaceAll(token, "[redacted]"), value);
}

// The list/validate contract supplies both references. This review adds the
// consent revision for precisely one captured row, without native preparation.
startupRoutes.get("/:rigId/nodes/:nodeId", async (c) => {
  const query = new URL(c.req.url).searchParams;
  const refs = selectedRefs(Object.fromEntries(query.entries()));
  if (!refs || [...query.keys()].length !== 2) return c.json({ ok: false, code: "invalid_request", message: "Supply snapshotId and historySessionId from the history list." }, 400);
  const rigId = c.req.param("rigId"), nodeId = c.req.param("nodeId");
  const selection = listSharedHistories(sharedHistoryDeps(c), rigId, nodeId, refs);
  if (!selection.ok) return c.json(selection, selection.code === "seat_unavailable" ? 404 : 409);
  const facts = selectedFacts(c, rigId, nodeId, refs);
  const state = facts && selectedState(c, rigId, nodeId, refs, facts.snapshot);
  if (state && "permissionUnavailable" in state) return c.json({ ok: false, code: "permission_unavailable",
    message: "The selected seat's saved permission choice needs repair before launch." }, 409);
  if (!facts || !state) return c.json({ ok: false, code: "selection_changed", message: "The selected source changed. Refresh the history list." }, 409);
  const forecast = buildRestorePlanPreview({ ...facts.rig, nodes: [facts.node] }, facts.snapshot,
    collectPreviewSessionRows(repo(c).db, { ...facts.rig, nodes: [facts.node] }, facts.snapshot), undefined, Date.now(), {},
    { nodeId, historySessionId: refs.historySessionId }).nodes[0]!;
  const observed = await observeSeat(c, facts.rig, facts.node);
  const checked = selectedState(c, rigId, nodeId, refs, facts.snapshot);
  if (checked && "permissionUnavailable" in checked) return c.json({ ok: false, code: "permission_unavailable",
    message: "The selected seat's saved permission choice needs repair before launch." }, 409);
  if (!checked || checked.review !== state.review) return c.json({ ok: false, code: "selection_changed", message: "The selected source changed during review. Refresh." }, 409);
  const capturedNode = facts.snapshot.data.nodes.find(node => node.id === nodeId);
  let permission: ReturnType<typeof selectedPermissionFacts>;
  try { permission = selectedPermissionFacts(c, rigId, nodeId, facts.node.runtime ?? ""); }
  catch { return c.json({ ok: false, code: "permission_unavailable", message: "The selected seat's saved permission choice needs repair before launch." }, 409); }
  const effort = readSeatEffort(repo(c).db, nodeId);
  return c.json({ ok: true, contract: "startup-history.v1", rigId, nodeId, logicalId: facts.node.logicalId,
    snapshotId: refs.snapshotId, historySessionId: refs.historySessionId, history: selection.histories[0],
    forecast, observed: { state: observed.state, sessionName: observed.sessionName },
    settingsSource: { model: { value: capturedNode?.model ?? null, source: "snapshot" },
      effort: { value: effort?.choice ?? capturedNode?.effort ?? null,
        source: effort?.choice ? "saved_choice" : "snapshot" },
      permission,
      codexProfile: { value: facts.node.codexConfigProfile ?? null, source: "current_node" } },
    revision: state.review, mutated: false });
});

startupRoutes.post("/:rigId/nodes/:nodeId", async (c) => {
  if (new URL(c.req.url).search) return c.json({ ok: false, code: "invalid_request", message: "Apply takes no query fields." }, 400);
  const refs = selectedRefs(await c.req.json().catch(() => null), true);
  if (!refs) return c.json({ ok: false, code: "invalid_request", message: "Apply requires action resume, snapshotId, historySessionId and the selected review revision." }, 400);
  const rigId = c.req.param("rigId"), nodeId = c.req.param("nodeId");
  return exclusive(c, nodeId, async () => {
    const selection = listSharedHistories(sharedHistoryDeps(c), rigId, nodeId, refs);
    if (!selection.ok) return c.json(selection, selection.code === "seat_unavailable" ? 404 : 409);
    const facts = selectedFacts(c, rigId, nodeId, refs);
    const state = facts && selectedState(c, rigId, nodeId, refs, facts.snapshot);
    if (state && "permissionUnavailable" in state) return c.json({ ok: false, code: "permission_unavailable",
      message: "The selected seat's saved permission choice needs repair before launch." }, 409);
    if (!facts || !state || refs.revision !== state.review) return c.json({ ok: false, code: "selection_changed", message: "The selected seat or history changed. Refresh the review." }, 409);
    const observed = await observeSeat(c, facts.rig, facts.node);
    if (observed.state !== "stopped") return c.json({ ok: false, code: observed.state, message: "The selected seat is running or its terminal state is uncertain. No resume was started." }, 409);
    const prerequisites = await defaultProbeRuntimes();
    if ((facts.node.runtime === "codex" ? prerequisites.codex : prerequisites.claudeCode) !== "ok") return c.json({ ok: false, code: "provider_prerequisite", message: "The selected provider is unavailable or unauthenticated. No resume was started." }, 409);
    const beforeEffect = () => {
      const again = listSharedHistories(sharedHistoryDeps(c), rigId, nodeId, refs);
      const current = selectedFacts(c, rigId, nodeId, refs);
      const revision = current && selectedState(c, rigId, nodeId, refs, current.snapshot);
      return again.ok && !!revision && "review" in revision && revision.review === state.review;
    };
    if (!beforeEffect()) return c.json({ ok: false, code: "selection_changed", message: "The selected seat or history changed during prerequisites. No resume was started." }, 409);
    let launchedBindingId: string | undefined;
    const beforeNative = (resultSessionId?: string, bindingId?: string) => {
      const rig = repo(c).getRig(rigId);
      if (!rig?.nodes.some(node => node.id === nodeId && node.logicalId === facts.node.logicalId)) return false;
      if (dep<SnapshotRepository>(c, "snapshotRepo").findLatestRestoreUsable(rigId)?.id !== refs.snapshotId) return false;
      const current = selectedState(c, rigId, nodeId, refs, facts.snapshot);
      if (!current || !("native" in current) || current.native !== state.native) return false;
      if (!resultSessionId) return true;
      const result = repo(c).db.prepare("SELECT node_id, session_name, status FROM sessions WHERE id = ?").get(resultSessionId) as
        { node_id: string; session_name: string; status: string } | undefined;
      const binding = sessions(c).getBindingForNode(nodeId);
      const running = repo(c).db.prepare("SELECT id FROM sessions WHERE node_id = ? AND status = 'running'").all(nodeId) as Array<{ id: string }>;
      const owned = !!bindingId && result?.node_id === nodeId && result.status === "running" && binding?.id === bindingId
        && binding?.tmuxSession === result.session_name && running.length === 1 && running[0]?.id === resultSessionId
        && (!launchedBindingId || launchedBindingId === bindingId);
      if (owned) launchedBindingId = bindingId;
      return owned;
    };
    const beforeRegistration = () => {
      if (!beforeNative()) return false;
      if (sessions(c).getBindingForNode(nodeId)) return false;
      const running = repo(c).db.prepare("SELECT id FROM sessions WHERE node_id = ? AND status = 'running'").all(nodeId);
      return running.length === 0;
    };
    const result = await dep<RestoreOrchestrator>(c, "restoreOrchestrator").launchSingleNode(rigId, facts.node.logicalId, {
      snapshotId: refs.snapshotId, adapters: dep<Record<string, RuntimeAdapter>>(c, "runtimeAdapters"), fsOps: { exists: existsSync },
      selectedHistory: { nodeId, historySessionId: refs.historySessionId, beforeEffect, beforeRegistration, beforeNative },
    });
    const outcome = result.launched?.[0];
    const ok = result.ok && outcome?.status === "resumed" && outcome.sourceSessionId === refs.historySessionId
      && !!outcome.resultSessionId && !!launchedBindingId && beforeNative(outcome.resultSessionId, launchedBindingId);
    const tokens = new Set<string>(facts.snapshot.data.sessions.filter(row => row.nodeId === nodeId)
      .map(row => row.resumeToken).filter((token): token is string => !!token));
    for (const row of repo(c).db.prepare("SELECT resume_token FROM sessions WHERE node_id = ?").all(nodeId) as Array<{ resume_token: string | null }>) {
      if (row.resume_token) tokens.add(row.resume_token);
    }
    const diagnosticTokens = [...tokens];
    const response = { ok, rigId, nodeId, snapshotId: refs.snapshotId, historySessionId: refs.historySessionId,
      code: !ok && outcome?.status === "resumed" ? "resume_unconfirmed" : outcome?.status ?? result.code ?? "resume_unconfirmed",
      sourceSessionId: refs.historySessionId, resultSessionId: outcome?.resultSessionId ?? null,
      message: redactDiagnostic(outcome?.error ?? result.message ?? (ok ? "Selected native history resumed and joined." : "Selected resume was not confirmed; inspect this seat before retrying."), diagnosticTokens),
      warnings: result.warnings?.map(warning => redactDiagnostic(warning, diagnosticTokens)),
      attentionEvidence: redactDiagnostic(outcome?.attentionEvidence, diagnosticTokens) };
    return c.json(response, ok ? 200 : 409);
  });
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
