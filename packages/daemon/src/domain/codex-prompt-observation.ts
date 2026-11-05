import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { SeatIdentityStore } from "./seat-identity-store.js";
import { classifyPaneActivity, readInputBox, readSeatBeforePaste } from "./session-transport.js";
import { DEFAULT_STRUCTURAL_STALE_MS } from "./seat-structural-activity-service.js";
import type { NeedsInput } from "./activity-taxonomy.js";

/** The committed native occupant and physical capture target. Missing provenance is unknown. */
export interface CodexPromptBinding {
  nodeId: string;
  sessionName: string;
  sessionId: string;
  generation: string;
  nativeSessionId: string;
  pane: string;
  bindingId: string;
  bindingUpdatedAt: string;
  processId: number;
  paneProcessId: number;
  /** Begin/finish-only database change stamp; not part of the accepted identity key. */
  captureRevision: string;
}

export interface StructuralPromptCapture {
  text: string | null;
  captureStartedAt: string | null;
  observedAt: string;
}

export interface StructuralPromptAttempt {
  readonly pane: string;
  finish(capture: StructuralPromptCapture): void;
}

export type StructuralPromptObserver = (sessionName: string, runtime: string | null | undefined) => StructuralPromptAttempt | null;

export function codexPromptBindingKey(binding: CodexPromptBinding): string {
  return JSON.stringify([binding.nodeId, binding.sessionName, binding.sessionId, binding.generation,
    binding.nativeSessionId, binding.pane, binding.bindingId, binding.bindingUpdatedAt,
    binding.processId, binding.paneProcessId]);
}

/** A registry label alone is not a native identity observation. Require the current, ready session,
 * registered generation, matching native resume identity, physical binding and fresh verified process.
 * No table is written and no provider, process probe or capture is started here. */
export function readCodexPromptBinding(
  db: Database.Database,
  registry: SessionRegistry,
  identities: SeatIdentityStore,
  sessionName: string,
  now: Date,
): CodexPromptBinding | null {
  try { return db.transaction((): CodexPromptBinding | null => {
    const context = registry.findResumeContextByName(sessionName);
    if (!context || context.runtime !== "codex") return null;
    const session = db.prepare("SELECT id, session_name, status, startup_status, resume_token, resume_provenance FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(context.nodeId) as { id: string; session_name: string; status: string; startup_status: string; resume_token: string | null; resume_provenance: string | null } | undefined;
    const binding = registry.getBindingForNode(context.nodeId);
    const tenure = registry.currentOccupantTenure(context.nodeId);
    if (!session || session.id !== context.sessionId || session.session_name !== sessionName
        || session.status !== "running" || session.startup_status !== "ready"
        || !binding || binding.attachmentType !== "tmux" || !binding.tmuxPane
        || !/^%[0-9]+$/.test(binding.tmuxPane) || !binding.id || !binding.updatedAt
        || !tenure?.generationUuid || !session.resume_token
        || !["hook", "scrape", "launcher", "passed", "adoption"].includes(session.resume_provenance ?? "")
        || (tenure.nativeSessionIdAtBoot != null && tenure.nativeSessionIdAtBoot !== session.resume_token)
        || !registry.isOccupantGenerationRegistered(context.nodeId, tenure.generationUuid)) return null;
    const identity = identities.getForNode(context.nodeId);
    // migration060's UTC datetime('now') names a whole second, not the instant the tenure began.
    // Reject that entire ambiguous interval; a fresh verdict from the predecessor can otherwise
    // cross a same-name handover. The reconciler stamps observedAt before its awaited native probes.
    const bootUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tenure.bootAt)
      ? tenure.bootAt.replace(" ", "T") + "Z" : "";
    const bootMs = Date.parse(bootUtc);
    if (!Number.isFinite(bootMs) || new Date(bootMs).toISOString() !== bootUtc.replace("Z", ".000Z")) return null;
    const observedMs = Date.parse(identity?.observedAt ?? "");
    if (!identity || identity.verdict !== "verified" || identity.sessionName !== sessionName
        || identity.evidence.registeredPane !== binding.tmuxPane
        || !identity.evidence.observedPid || !identity.evidence.observedPanePid
        || !Number.isFinite(observedMs) || observedMs < bootMs + 1000 || observedMs > now.getTime()
        || now.getTime() - observedMs >= DEFAULT_STRUCTURAL_STALE_MS) return null;
    return { nodeId: context.nodeId, sessionName, sessionId: session.id, generation: tenure.generationUuid,
      nativeSessionId: session.resume_token, pane: binding.tmuxPane, bindingId: binding.id,
      bindingUpdatedAt: binding.updatedAt, processId: identity.evidence.observedPid,
      paneProcessId: identity.evidence.observedPanePid,
      captureRevision: JSON.stringify([
        (db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes,
        (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
      ]) };
  })(); } catch { return null; }
}

/** Inspect the actual bytes, never the structural cache's activity/idleFrame label. Codex's supported
 * complete native idle frame includes its finished-turn or fresh-session shape AND current empty
 * composer/footer. Running, queued input, drafts, unsupported/truncated frames and other runtimes
 * cannot supply a negative. Actual visible permission/selection remains positive. This is a bounded
 * layout contract (the transport's Codex 0.160 shapes), not a native-version discovery claim. */
export function codexPromptNeedsInput(text: string | null, sessionName: string): NeedsInput | null {
  if (!text?.trim()) return null;
  const activity = classifyPaneActivity(text, { runtime: "codex" });
  if (activity.state === "attention") return { count: 1, reason: activity.reason };
  if (activity.state !== "agent_idle" || readSeatBeforePaste(text, "codex", sessionName) !== "idle"
      || readInputBox(text, "codex", "") !== "empty") return null;
  return { count: 0, reason: null };
}
