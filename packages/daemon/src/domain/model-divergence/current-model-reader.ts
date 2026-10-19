import { realpathSync, statSync } from "node:fs";
import type { SessionRegistry } from "../session-registry.js";
import type { SeatIdentityStore } from "../seat-identity-store.js";
import type { ContextUsageStore } from "../context-usage-store.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import { ProcessCensus } from "../process-census.js";
import {
  resolveIdentityVerifiedClaudeRecord, resolveIdentityVerifiedPiRecord,
  resolveLiveCodexThreadId, readCurrentPiOccupantModel,
  type CurrentGenerationDeps, type PiOccupantRecordInput,
} from "./current-generation-record.js";
import {
  readClaudeEffectiveModel, readCodexEffectiveModel,
  readClaudeModelObservation, readCodexModelObservation, readPiModelObservation,
  type NativeModelObservation,
} from "./effective-model-readers.js";
import type { EffectiveModelRead, PinnedSeat } from "./model-divergence-monitor.js";

export interface ModelObservation {
  status: "observed" | "unknown";
  model: string | null;
  source: NativeModelObservation["source"] | null;
  observedAt: string | null;
  generation: string | null;
  reason: string | null;
}

/** Public reasons contain no transcript paths, record contents, process commands or errors. */
export function unknownModelObservation(reason: string, generation: string | null = null): ModelObservation {
  return { status: "unknown", model: null, source: null, observedAt: null, generation, reason };
}

interface Seat { nodeId: string; sessionName: string; runtime: string | null; generation: string | null }
interface Deps {
  sessions: Pick<SessionRegistry, "currentOccupantTenure" | "getBindingForNode" | "currentOccupantGenerationForSession">;
  identities: Pick<SeatIdentityStore, "getForNode">;
  context: Pick<ContextUsageStore, "readSidecar">;
  codexRollout: (threadId: string, sessionName: string, reporting: boolean) => string | null;
  piRunner: (sessionName: string) => PiOccupantRecordInput["runner"];
  native: CurrentGenerationDeps;
  census: ProcessCensus;
  now?: () => number;
}
type Selection = { ok: true; path: string; notBeforeMs?: number } | { ok: false; reason: string };

/** One current-record path for reporting and the existing divergence monitor. Reporting never
 * needs a configured pin, alias or comparator. Both share the same coalescing process census. */
export class CurrentModelReader {
  readonly processCensus: ProcessCensus;
  constructor(private readonly deps: Deps) { this.processCensus = deps.census; }

  private async select(seat: Seat, native: CurrentGenerationDeps, target = seat.sessionName, reporting = false): Promise<Selection> {
    if (seat.runtime === "codex") {
      const live = await resolveLiveCodexThreadId(target, native);
      if (!live.ok) return live;
      const path = this.deps.codexRollout(live.id, seat.sessionName, reporting);
      return path ? { ok: true, path } : { ok: false, reason: "no readable rollout for the live thread" };
    }
    const binding = this.deps.sessions.getBindingForNode(seat.nodeId);
    const common = {
      sessionName: seat.sessionName, generation: seat.generation,
      occupantBootAt: this.deps.sessions.currentOccupantTenure(seat.nodeId)?.bootAt ?? null,
      binding: binding ? { tmuxSession: binding.tmuxSession, tmuxPane: binding.tmuxPane } : null,
    };
    if (seat.runtime === "claude-code") {
      const sidecar = this.deps.context.readSidecar(seat.sessionName);
      return resolveIdentityVerifiedClaudeRecord({ ...common,
        identity: this.deps.identities.getForNode(seat.nodeId), sidecar: sidecar.ok ? sidecar.data : null,
      }, native, (path) => { try { return statSync(path).isFile(); } catch { return false; } });
    }
    if (seat.runtime === "pi") {
      const selection = await resolveIdentityVerifiedPiRecord({ ...common, runner: this.deps.piRunner(seat.sessionName) }, native,
        (path) => { try { return realpathSync(path); } catch { return null; } });
      return selection;
    }
    return { ok: false, reason: "runtime has no supported native model reader" };
  }

  /** Preserve the monitor's established read/comparison behavior, including Pi pin readings. */
  async readEffectiveModel(seat: PinnedSeat, cycle?: { listProcesses: CurrentGenerationDeps["listProcesses"] }): Promise<EffectiveModelRead> {
    const native = cycle ? { ...this.deps.native, listProcesses: cycle.listProcesses } : this.deps.native;
    if (seat.runtime === "pi") {
      const binding = this.deps.sessions.getBindingForNode(seat.nodeId);
      return readCurrentPiOccupantModel({
        sessionName: seat.sessionName, pinnedModel: seat.pinnedModel, generation: seat.generation,
        occupantBootAt: this.deps.sessions.currentOccupantTenure(seat.nodeId)?.bootAt ?? null,
        binding: binding ? { tmuxSession: binding.tmuxSession, tmuxPane: binding.tmuxPane } : null,
        runner: this.deps.piRunner(seat.sessionName),
      }, native, (path) => { try { return realpathSync(path); } catch { return null; } });
    }
    const selected = await this.select(seat, native);
    if (!selected.ok) return selected;
    const model = seat.runtime === "claude-code" ? readClaudeEffectiveModel(selected.path) : readCodexEffectiveModel(selected.path);
    return model ? { ok: true, model } : { ok: false, reason: "no model signal in the bounded current occupant record" };
  }

  /** No caching of model facts across occupants. A request shares one lazy census for all seats. */
  async observe(node: { nodeId: string; canonicalSessionName: string | null; runtime: string | null; sessionStatus: string | null },
    listProcesses = this.processCensus.cycleLister()): Promise<ModelObservation> {
    const tenure = this.deps.sessions.currentOccupantTenure(node.nodeId);
    const generation = tenure?.generationUuid ?? null;
    const unknown = (reason: string) => unknownModelObservation(reason, generation);
    if (node.sessionStatus !== "running" || !node.canonicalSessionName) return unknown("seat-not-running");
    if (!["claude-code", "codex", "pi"].includes(node.runtime ?? "")) return unknown("unsupported-runtime");
    const boot = tenure ? parseSqliteUtcMs(tenure.bootAt) : NaN;
    if (!generation || !Number.isFinite(boot) || this.deps.sessions.currentOccupantGenerationForSession(node.canonicalSessionName) !== generation) return unknown("occupant-unknown");
    const binding = this.deps.sessions.getBindingForNode(node.nodeId);
    if (!binding?.tmuxPane || binding.tmuxSession !== node.canonicalSessionName) return unknown("canonical-pane-unknown");
    try {
      const pid = await this.deps.native.getPanePid(binding.tmuxPane);
      if (!pid) return unknown("pane-unavailable");
      // Codex uses the exact registered pane rather than a same-name target. Claude/Pi additionally
      // apply their existing identity/sidecar checks inside select().
      const native = { ...this.deps.native, listProcesses,
        // Reporting never uses the monitor's explicitly legacy, identity-less thread lookup.
        readThreadIdByPid: (pid: number, identity?: string) => identity
          ? this.deps.native.readThreadIdByPid(pid, identity) : undefined,
      };
      const seat = { ...node, sessionName: node.canonicalSessionName, generation };
      const selected = await this.select(seat, native, binding.tmuxPane, true);
      if (!selected.ok) return unknown("record-identity-missing-or-ambiguous");
      const fact = node.runtime === "claude-code" ? readClaudeModelObservation(selected.path)
        : node.runtime === "codex" ? readCodexModelObservation(selected.path)
        : readPiModelObservation(selected.path, { notBeforeMs: selected.notBeforeMs! });
      const current = this.deps.sessions.currentOccupantTenure(node.nodeId);
      const currentBinding = this.deps.sessions.getBindingForNode(node.nodeId);
      if (current?.generationUuid !== generation || this.deps.sessions.currentOccupantGenerationForSession(node.canonicalSessionName) !== generation || currentBinding?.tmuxPane !== binding.tmuxPane
        || currentBinding?.tmuxSession !== binding.tmuxSession || await native.getPanePid(binding.tmuxPane) !== pid) return unknown("occupant-changed-during-read");
      if (!fact || !("model" in fact)) return unknown("model-record-unavailable");
      // Copy only a model identifier, never arbitrary record text or a diagnostic containing paths.
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]{0,199}$/.test(fact.model)) return unknown("model-identifier-unreadable");
      if (!fact.observedAt) return unknown("record-time-unknown");
      const at = Date.parse(fact.observedAt);
      if (at <= boot) return unknown("record-predates-current-occupant");
      if (at > (this.deps.now ?? Date.now)()) return unknown("record-time-in-future");
      return { status: "observed", model: fact.model, source: fact.source, observedAt: fact.observedAt, generation, reason: null };
    } catch { return unknown("native-read-unavailable"); }
  }
}
