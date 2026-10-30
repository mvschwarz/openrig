import { statSync } from "node:fs";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { ProcessCensus } from "./process-census.js";
import { CodexThreadIdResolver } from "./codex-thread-id.js";
import { resolveIdentityVerifiedClaudeRecord, resolveLiveCodexThreadId } from "./model-divergence/current-generation-record.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";

export interface ExpectedConversation {
  nodeId: string;
  sessionName: string;
  runtime: "claude-code" | "codex";
  nativeId: string;
}
const census = new ProcessCensus({ freshnessMs: 0 });
const threads = new CodexThreadIdResolver({ codexHome: process.env.CODEX_HOME || undefined });
function unavailable(message: string): never { throw new DeliveryGuardError("expected_identity_unavailable", message); }
function mismatch(message: string): never { throw new DeliveryGuardError("expected_identity_mismatch", message); }

export function expectedConversation(value: unknown): ExpectedConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeliveryGuardError("invalid_expected_identity", "An expected conversation identity is required.");
  const raw = value as Record<string, unknown>;
  for (const key of ["nodeId", "sessionName", "nativeId"]) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).length || (raw[key] as string).length > 256 || /\s/.test(raw[key] as string))
      throw new DeliveryGuardError("invalid_expected_identity", `Expected identity needs a nonempty ${key}, without whitespace.`);
  }
  if (raw.runtime !== "claude-code" && raw.runtime !== "codex") throw new DeliveryGuardError("invalid_expected_identity", "Expected identity supports claude-code or codex only.");
  return { nodeId: raw.nodeId as string, sessionName: raw.sessionName as string, runtime: raw.runtime, nativeId: raw.nativeId as string };
}
export function sameConversation(a: ExpectedConversation, b: ExpectedConversation): boolean {
  return a.nodeId === b.nodeId && a.sessionName === b.sessionName && a.runtime === b.runtime && a.nativeId === b.nativeId;
}

/** Opt-in consumer check; a registry resume token alone never authorizes the operation. */
export async function resolveExpectedConversation(expected: ExpectedConversation, registry: SessionRegistry, tmux: TmuxAdapter,
  store: ContextUsageStore | undefined): Promise<{ identity: ExpectedConversation; path: string; generation: string; pane: string; assertCurrent: () => void }> {
  if (!store) unavailable("No native record resolver is available; no conditional input or record is served.");
  const context = registry.findResumeContextByName(expected.sessionName);
  if (!context) unavailable("The expected seat has no registered conversation.");
  if (context.nodeId !== expected.nodeId || context.runtime !== expected.runtime) mismatch("The seat or runtime is no longer the expected one.");
  const occupant = registry.currentOccupantTenure(context.nodeId), binding = registry.getBindingForNode(context.nodeId);
  const proof = new SeatIdentityStore(registry.db).getForNode(context.nodeId);
  if (!occupant || !binding?.tmuxPane || binding.tmuxSession !== expected.sessionName || proof?.verdict !== "verified"
    || proof.sessionName !== expected.sessionName || proof.evidence.registeredPane !== binding.tmuxPane
    || !(Date.parse(proof.observedAt) >= parseSqliteUtcMs(occupant.bootAt))) unavailable("The current occupant/pane identity is unverified.");
  const pane = binding.tmuxPane, generation = occupant.generationUuid;
  const assertCurrent = () => {
    const current = registry.findResumeContextByName(expected.sessionName), bound = registry.getBindingForNode(expected.nodeId);
    if (current?.nodeId !== expected.nodeId || current.runtime !== expected.runtime || bound?.tmuxSession !== expected.sessionName
      || bound.tmuxPane !== pane || registry.currentOccupantTenure(expected.nodeId)?.generationUuid !== generation)
      mismatch("The occupant binding changed during the conditional operation.");
  };
  let nativeId: string, path: string | null, rootPid: number | null;
  try {
    rootPid = await tmux.getPanePid(pane);
    if (!rootPid || rootPid !== (proof.evidence.observedPanePid ?? proof.evidence.observedPid)) unavailable("The pane process no longer matches its verified occupant.");
    const deps = { getPanePid: () => tmux.getPanePid(pane), listProcesses: () => census.list(),
      readThreadIdByPid: async (pid: number, startedAt?: string) => startedAt ? threads.resolve(pid, startedAt) : undefined };
    if (expected.runtime === "claude-code") {
      const sidecar = store.readSidecar(expected.sessionName);
      const selected = await resolveIdentityVerifiedClaudeRecord({ sessionName: expected.sessionName, generation,
        occupantBootAt: occupant.bootAt, binding, identity: proof, sidecar: sidecar.ok ? sidecar.data : null }, deps,
        file => { try { return statSync(file).isFile(); } catch { return false; } });
      if (!selected.ok) unavailable(selected.reason);
      nativeId = selected.id; path = selected.path;
    } else {
      let verifiedThread: string | undefined;
      const selected = await resolveLiveCodexThreadId(pane, { ...deps, readThreadIdByPid: async (pid, startedAt) => {
        const id = await deps.readThreadIdByPid(pid, startedAt); if (pid === proof.evidence.observedPid) verifiedThread = id; return id;
      } });
      if (!selected.ok) unavailable(selected.reason);
      nativeId = selected.id; path = store.readCodexTranscriptPath(nativeId);
      if (proof.evidence.observedPanePid != null && verifiedThread !== nativeId) unavailable("The selected thread is not owned by the verified native process.");
    }
    assertCurrent();
    if (await tmux.getPanePid(pane) !== rootPid) mismatch("The pane process changed during native resolution.");
    assertCurrent();
  } catch (error) {
    if (error instanceof DeliveryGuardError) throw error;
    unavailable(`Native identity could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (nativeId! !== expected.nativeId) mismatch("The current native conversation differs from the expected original.");
  if (!path!) unavailable("The expected native record is unavailable.");
  return { identity: { ...expected }, path: path!, generation, pane, assertCurrent };
}
