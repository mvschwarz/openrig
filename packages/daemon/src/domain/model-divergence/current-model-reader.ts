import { observeCodexRebuildPermissions } from "../codex-rebuild-permissions.js";
import { realpathSync, statSync } from "node:fs";
import type { SessionRegistry } from "../session-registry.js";
import type { SeatIdentityStore } from "../seat-identity-store.js";
import type { ContextUsageStore } from "../context-usage-store.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import { ProcessCensus } from "../process-census.js";
import {
  resolveIdentityVerifiedClaudeRecord, resolveIdentityVerifiedPiRecord,
  resolveLiveCodexThreadId, readCurrentPiOccupantModel,
  type CurrentGenerationDeps, type PiOccupantRecordInput, type PiRecordSelection,
} from "./current-generation-record.js";
import {
  readClaudeEffectiveModel, readCodexEffectiveModel,
  readClaudeModelObservation, readCodexModelObservation, readPiModelObservation,
  type NativeModelObservation, type PiModelObservation,
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
  readAllPaneProcesses?: () => Promise<Map<string, { pid: number | null }> | null>;
  now?: () => number;
}
type InventoryNode = { nodeId: string; canonicalSessionName: string | null; runtime: string | null; sessionStatus: string | null };
type PendingObservation = { pane: string; finish: (pid: number | null, unavailableReason?: string) => ModelObservation };
type Selection = { ok: true; path: string; notBeforeMs?: number } | { ok: false; reason: string };
type Binding = { tmuxSession: string | null; tmuxPane: string | null };
/** The verified current Pi runner plus its newest own turn, read with the occupant unchanged throughout. */
export type CurrentPiRecord = (PiRecordSelection & { ok: true; observation: PiModelObservation }) | { ok: false; reason: string };

/** One current-record path for reporting and the existing divergence monitor. Reporting never
 * needs a configured pin, alias or comparator. Both share the same coalescing process census. */
export class CurrentModelReader {
  readonly processCensus: ProcessCensus;
  private readonly facts = new Map<string, { key: string; signature: string; fact: NativeModelObservation | null }>();
  constructor(private readonly deps: Deps) { this.processCensus = deps.census; }

  /** Rebuild continuity uses a fresh process read before and after the bounded native record read. */
  currentCodexPermissions(nodeId: string, sessionName: string, cwd: string) {
    return observeCodexRebuildPermissions({ nodeId, sessionName, cwd, sessions: this.deps.sessions,
      tmux: this.deps.native, readThreadId: this.deps.native.readThreadIdByPid,
      rollout: thread => this.deps.codexRollout(thread, sessionName, true) });
  }

  private async select(seat: Seat, native: CurrentGenerationDeps, target = seat.sessionName, reporting = false): Promise<Selection> {
    if (seat.runtime === "codex") {
      const live = await resolveLiveCodexThreadId(target, native);
      if (!live.ok) return live;
      const path = this.deps.codexRollout(live.id, seat.sessionName, reporting);
      return path ? { ok: true, path } : { ok: false, reason: "no readable rollout for the live thread" };
    }
    if (seat.runtime === "claude-code") {
      const sidecar = this.deps.context.readSidecar(seat.sessionName);
      return resolveIdentityVerifiedClaudeRecord({ ...this.occupant(seat),
        identity: this.deps.identities.getForNode(seat.nodeId), sidecar: sidecar.ok ? sidecar.data : null,
      }, native, (path) => { try { return statSync(path).isFile(); } catch { return false; } });
    }
    if (seat.runtime === "pi") return this.selectPi(seat, native);
    return { ok: false, reason: "runtime has no supported native model reader" };
  }

  private occupant(seat: Seat) {
    const binding = this.deps.sessions.getBindingForNode(seat.nodeId);
    return {
      sessionName: seat.sessionName, generation: seat.generation,
      occupantBootAt: this.deps.sessions.currentOccupantTenure(seat.nodeId)?.bootAt ?? null,
      binding: binding ? { tmuxSession: binding.tmuxSession, tmuxPane: binding.tmuxPane } : null,
    };
  }

  private selectPi(seat: Seat, native: CurrentGenerationDeps): Promise<PiRecordSelection> {
    return resolveIdentityVerifiedPiRecord({ ...this.occupant(seat), runner: this.deps.piRunner(seat.sessionName) }, native,
      (path) => { try { return realpathSync(path); } catch { return null; } });
  }

  /** The identity-verified current Pi runner of a seat and its own session file, selected the same
   *  way the model observation selects it, and its newest own turn read before the final pane
   *  lookup and occupant recheck. Never cached: each call re-reads the pane and processes. */
  async currentPiRecord(nodeId: string, sessionName: string): Promise<CurrentPiRecord> {
    const tenure = this.deps.sessions.currentOccupantTenure(nodeId);
    const generation = tenure?.generationUuid ?? null;
    const boot = tenure ? parseSqliteUtcMs(tenure.bootAt) : NaN;
    if (!generation || !Number.isFinite(boot) || this.deps.sessions.currentOccupantGenerationForSession(sessionName) !== generation) {
      return { ok: false, reason: `the occupant of ${sessionName} is not the seat's current occupant` };
    }
    const binding = this.deps.sessions.getBindingForNode(nodeId);
    if (!binding?.tmuxPane || binding.tmuxSession !== sessionName) return { ok: false, reason: "the seat's pane is unknown" };
    const native = { ...this.deps.native, listProcesses: this.processCensus.cycleLister() };
    let pid: number | null, selection: PiRecordSelection;
    try {
      pid = await native.getPanePid(binding.tmuxPane);
      if (!pid) return { ok: false, reason: "the seat's pane could not be read" };
      selection = await this.selectPi({ nodeId, sessionName, runtime: "pi", generation }, native);
    } catch { return { ok: false, reason: "the pane's processes could not be read" }; }
    if (!selection.ok) return selection;
    const observation = readPiModelObservation(selection.path, { notBeforeMs: selection.notBeforeMs });
    let finalPid: number | null;
    try { finalPid = await this.deps.native.getPanePid(binding.tmuxPane); } catch { return { ok: false, reason: "the seat's pane could not be read" }; }
    // No await after this point.
    if (!this.occupantUnchanged(nodeId, sessionName, generation, binding, pid, finalPid)) return { ok: false, reason: "the occupant changed during the read" };
    if (finalPid === null) return { ok: false, reason: "the seat's pane could not be read" };
    return { ...selection, observation };
  }

  /** Sampled synchronously AFTER the final PID lookup; a null final PID is unavailable, not turnover. */
  private occupantUnchanged(nodeId: string, sessionName: string, generation: string, binding: Binding, pid: number, finalPid: number | null): boolean {
    const current = this.deps.sessions.currentOccupantTenure(nodeId);
    const currentBinding = this.deps.sessions.getBindingForNode(nodeId);
    return !(current?.generationUuid !== generation || this.deps.sessions.currentOccupantGenerationForSession(sessionName) !== generation || currentBinding?.tmuxPane !== binding.tmuxPane
      || currentBinding?.tmuxSession !== binding.tmuxSession || (finalPid !== null && finalPid !== pid));
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

  /** Re-select identity each time; only unchanged file facts are reused, never occupant verdicts. */
  private readFact(node: InventoryNode, generation: string, pid: number, selected: Selection & { ok: true }): NativeModelObservation | null {
    const signature = () => {
      const st = statSync(selected.path, { bigint: true });
      if (!st.isFile()) throw new Error("not a regular record");
      return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(":");
    };
    const key = JSON.stringify([generation, node.runtime, node.canonicalSessionName, pid, selected.path, selected.notBeforeMs]);
    const before = signature(), cached = this.facts.get(node.nodeId);
    if (cached?.key === key && cached.signature === before) return cached.fact;
    const read = node.runtime === "claude-code" ? readClaudeModelObservation(selected.path)
      : node.runtime === "codex" ? readCodexModelObservation(selected.path)
      : readPiModelObservation(selected.path, { notBeforeMs: selected.notBeforeMs! });
    const fact = read && "model" in read ? read : null;
    if (signature() === before) {
      // One entry per node; cap removed-node residue without a timer or background poll.
      this.facts.delete(node.nodeId);
      if (this.facts.size >= 1024) this.facts.delete(this.facts.keys().next().value!);
      this.facts.set(node.nodeId, { key, signature: before, fact });
    }
    return fact;
  }

  /** Two bulk pane queries per inventory, one shared lazy process census, no per-seat tmux execs.
   * The final query starts AFTER all record selections/reads, including cache hits. */
  async observeInventory(nodes: InventoryNode[]): Promise<ModelObservation[]> {
    const listProcesses = this.processCensus.cycleLister();
    if (!this.deps.readAllPaneProcesses) return Promise.all(nodes.map(n => this.observe(n, listProcesses)));
    let before: ReturnType<NonNullable<Deps["readAllPaneProcesses"]>> | undefined;
    const native = { ...this.deps.native, listProcesses, getPanePid: async (pane: string) => {
      before ??= this.deps.readAllPaneProcesses!();
      return (await before)?.get(pane)?.pid ?? null;
    } };
    const prepared = await Promise.all(nodes.map(n => this.prepare(n, native)));
    if (!prepared.some(p => "finish" in p)) return prepared as ModelObservation[];
    let after: Map<string, { pid: number | null }> | null = null;
    try { after = await this.deps.readAllPaneProcesses(); } catch { /* UNKNOWN, never a fallback subprocess storm. */ }
    return prepared.map(p => "finish" in p ? p.finish(after?.get(p.pane)?.pid ?? null, after === null ? "native-read-unavailable" : "pane-unavailable") : p);
  }

  async observe(node: InventoryNode, listProcesses = this.processCensus.cycleLister()): Promise<ModelObservation> {
    const prepared = await this.prepare(node, { ...this.deps.native, listProcesses });
    if (!("finish" in prepared)) return prepared;
    let finalPid: number | null = null;
    let unavailableReason = "pane-unavailable";
    try { finalPid = await this.deps.native.getPanePid(prepared.pane); } catch { unavailableReason = "native-read-unavailable"; }
    return prepared.finish(finalPid, unavailableReason);
  }

  private async prepare(node: InventoryNode, native: CurrentGenerationDeps): Promise<ModelObservation | PendingObservation> {
    const tenure = this.deps.sessions.currentOccupantTenure(node.nodeId);
    const generation = tenure?.generationUuid ?? null;
    const unknown = (reason: string) => unknownModelObservation(reason, generation);
    if (node.sessionStatus !== "running" || !node.canonicalSessionName) return unknown("seat-not-running");
    const sessionName = node.canonicalSessionName;
    if (!["claude-code", "codex", "pi"].includes(node.runtime ?? "")) return unknown("unsupported-runtime");
    const boot = tenure ? parseSqliteUtcMs(tenure.bootAt) : NaN;
    if (!generation || !Number.isFinite(boot) || this.deps.sessions.currentOccupantGenerationForSession(sessionName) !== generation) return unknown("occupant-unknown");
    const binding = this.deps.sessions.getBindingForNode(node.nodeId);
    if (!binding?.tmuxPane || binding.tmuxSession !== sessionName) return unknown("canonical-pane-unknown");
    try {
      const pid = await native.getPanePid(binding.tmuxPane);
      if (!pid) return unknown("pane-unavailable");
      // Codex uses the exact registered pane rather than a same-name target. Claude/Pi additionally
      // apply their existing identity/sidecar checks inside select().
      const reportingNative = { ...native,
        // Reporting never uses the monitor's explicitly legacy, identity-less thread lookup.
        readThreadIdByPid: (pid: number, identity?: string) => identity
          ? this.deps.native.readThreadIdByPid(pid, identity) : undefined,
      };
      const seat = { ...node, sessionName, generation };
      const selected = await this.select(seat, reportingNative, binding.tmuxPane, true);
      if (!selected.ok) return unknown("record-identity-missing-or-ambiguous");
      const fact = this.readFact(node, generation, pid, selected);
      return { pane: binding.tmuxPane, finish: (finalPid, unavailableReason = "pane-unavailable") => {
        // No await after this point: tenure/name/binding are sampled AFTER the final PID lookup.
        if (!this.occupantUnchanged(node.nodeId, sessionName, generation, binding, pid, finalPid)) return unknown("occupant-changed-during-read");
        if (finalPid === null) return unknown(unavailableReason);
        if (!fact || !("model" in fact)) return unknown("model-record-unavailable");
        // Copy only a model identifier, never arbitrary record text or a diagnostic containing paths.
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]{0,199}$/.test(fact.model)) return unknown("model-identifier-unreadable");
        if (!fact.observedAt) return unknown("record-time-unknown");
        const at = Date.parse(fact.observedAt);
        if (at <= boot) return unknown("record-predates-current-occupant");
        if (at > (this.deps.now ?? Date.now)()) return unknown("record-time-in-future");
        return { status: "observed", model: fact.model, source: fact.source, observedAt: fact.observedAt, generation, reason: null };
      } };
    } catch { return unknown("native-read-unavailable"); }
  }
}
