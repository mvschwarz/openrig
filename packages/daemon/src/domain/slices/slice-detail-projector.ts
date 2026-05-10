// Slice Story View v0 + v1 — per-tab payload projector.
//
// Given a SliceRecord (from SliceIndexer), this assembles the full
// per-slice payload covering all six tabs: Story, Acceptance, Decisions,
// Docs, Tests/Verification, Topology. Read-only; no mutations. Composes
// already-shipped tables (queue_items, queue_transitions,
// mission_control_actions, workflow_specs, workflow_instances,
// workflow_step_trails) + slice docs on disk + dogfood-evidence.
//
// v1 enrichment (per slices/slice-story-view-v1/IMPLEMENTATION-PRD.md):
// when a workflow_instance is bound to the slice, four dimensions
// activate — spec-graph topology, spec-driven phase tagging, current-
// step + allowed exits in Acceptance, routing-type edge metadata
// (default `direct` only at v1 per audit-row-6 carve-out).
//
// v0 hardcoded legacy phase taxonomy ("discovery"/"product-lab"/
// "delivery"/"lifecycle"/"qa"/"other") is REMOVED at v1 per PRD § Write
// Set Sketch. StoryEvent.phase is now an open-ended string-or-null:
// when bound to a workflow_instance, the value is the spec-defined
// step.id; otherwise null (UI groups under "Untagged").

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { SliceIndexer, SliceRecord, SliceProofPacket } from "./slice-indexer.js";
import type { WorkflowSpecCache } from "../workflow-spec-cache.js";
import {
  findSliceWorkflowBinding,
  type SliceWorkflowBinding,
} from "../workflow/slice-workflow-binding.js";
import {
  projectSpecGraph,
  projectPhaseDefinitions,
  projectCurrentStep,
  type SpecGraphPayload,
  type PhaseDefinition,
  type CurrentStepPayload,
} from "../workflow/slice-workflow-projection.js";

export interface StoryEvent {
  ts: string;
  /** Spec-defined step.id when the event traces back through a workflow
   *  step trail; null when the event is untagged (no trail mapping or
   *  the slice has no bound workflow_instance). v1 removed the v0
   *  hardcoded legacy phase enum. */
  phase: string | null;
  kind: string;
  actorSession: string | null;
  qitemId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface AcceptanceItem {
  text: string;
  done: boolean;
  source: { file: string; line: number };
}

export interface AcceptancePayload {
  totalItems: number;
  doneItems: number;
  percentage: number;
  items: AcceptanceItem[];
  closureCallout: string | null;
  /** v1 dimension #3: bound workflow_instance's current step + the
   *  spec-declared allowed next steps. Null when the slice has no
   *  bound instance (UI falls back to PROGRESS.md checkbox view only). */
  currentStep: CurrentStepPayload | null;
}

export interface DecisionRow {
  actionId: string;
  ts: string;
  actor: string;
  verb: string;
  qitemId: string;
  reason: string | null;
  beforeState: string | null;
  afterState: string | null;
}

export interface DocsTreeEntry {
  name: string;
  type: "file" | "dir";
  size: number | null;
  mtime: string | null;
  /** Relative path under the slice folder. */
  relPath: string;
}

export interface ProofPacketRendered {
  dirName: string;
  /** Headline markdown file (latest mtime). */
  primaryMarkdown: { relPath: string; content: string } | null;
  /** All other markdown files in the proof packet directory (latest-first). */
  additionalMarkdown: Array<{ relPath: string; content: string }>;
  /** Screenshot relative paths suitable for /api/slices/:name/proof-asset/<path> serving. */
  screenshots: string[];
  /** Video relative paths suitable for the <video> player. */
  videos: string[];
  /** Trace zip relative paths (download links only — not auto-rendered). */
  traces: string[];
  /** Heuristic pass/fail badge derived from primary markdown content. */
  passFailBadge: "pass" | "fail" | "partial" | "unknown";
}

export interface TopologyRigEntry {
  rigId: string;
  rigName: string;
  sessionNames: string[];
}

export interface TopologyPayload {
  affectedRigs: TopologyRigEntry[];
  /** Total unique seats touching the slice across all rigs. */
  totalSeats: number;
  /** v1 dimension #1: workflow_spec graph (nodes + edges) when the
   *  slice is bound to a workflow_instance. Null when unbound (UI falls
   *  back to the v0 per-rig session listing). */
  specGraph: SpecGraphPayload | null;
}

export interface WorkflowBindingPayload {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  currentStepId: string | null;
  currentFrontier: string[];
  hopCount: number;
  createdAt: string;
  completedAt: string | null;
  /** Other workflow_instances also touching this slice's qitem set;
   *  v1 picks the most recent as the primary binding (per PRD), and
   *  exposes the rest here so the UI can render a "+N more" indicator. */
  additionalInstanceIds: string[];
}

export interface SliceDetailPayload {
  name: string;
  missionId: string | null;
  slicePath: string;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemIds: string[];
  commitRefs: string[];
  lastActivityAt: string | null;
  /** v1: bound workflow_instance metadata (most-recent if multiple),
   *  null when no workflow_instance touches this slice's qitems. */
  workflowBinding: WorkflowBindingPayload | null;
  story: {
    events: StoryEvent[];
    /** v1 dimension #2: spec-declared phase definitions when bound;
     *  null when unbound (UI falls back to ungrouped chronological). */
    phaseDefinitions: PhaseDefinition[] | null;
  };
  acceptance: AcceptancePayload;
  decisions: { rows: DecisionRow[] };
  docs: { tree: DocsTreeEntry[] };
  tests: { proofPackets: ProofPacketRendered[]; aggregate: { passCount: number; failCount: number } };
  topology: TopologyPayload;
}

export interface SliceDetailProjectorOpts {
  db: Database.Database;
  indexer: SliceIndexer;
  /** v1: optional WorkflowSpecCache used to resolve the bound
   *  workflow_instance's spec for spec-graph + phase + current-step
   *  projection. When omitted, the projector silently degrades to v0
   *  behavior (everything renders as before; v1 fields are null). */
  workflowSpecCache?: WorkflowSpecCache;
}

export class SliceDetailProjector {
  private readonly db: Database.Database;
  private readonly indexer: SliceIndexer;
  private readonly workflowSpecCache: WorkflowSpecCache | undefined;

  constructor(opts: SliceDetailProjectorOpts) {
    this.db = opts.db;
    this.indexer = opts.indexer;
    this.workflowSpecCache = opts.workflowSpecCache;
  }

  project(slice: SliceRecord): SliceDetailPayload {
    // v1: resolve workflow_instance binding once; the bound spec drives
    // four downstream dimensions (story phase tags, spec graph, current
    // step, phase definitions). When unbound or when the spec is no
    // longer cached (operator deleted the spec file, etc.), all v1
    // fields return null and v0 fallbacks apply.
    const bindingResult = findSliceWorkflowBinding(this.db, slice.qitemIds);
    const binding = bindingResult.primary;
    const spec = binding && this.workflowSpecCache
      ? this.tryGetSpec(binding.workflowName, binding.workflowVersion)
      : null;
    const trailQitemToStep = binding ? this.buildTrailQitemToStepMap(binding.instanceId) : new Map<string, string>();

    return {
      name: slice.name,
      missionId: slice.missionId,
      slicePath: slice.slicePath,
      displayName: slice.displayName,
      railItem: slice.railItem,
      status: slice.status,
      rawStatus: slice.rawStatus,
      qitemIds: slice.qitemIds,
      commitRefs: slice.commitRefs,
      lastActivityAt: slice.lastActivityAt,
      workflowBinding: binding ? {
        instanceId: binding.instanceId,
        workflowName: binding.workflowName,
        workflowVersion: binding.workflowVersion,
        status: binding.status,
        currentStepId: binding.currentStepId,
        currentFrontier: binding.currentFrontier,
        hopCount: binding.hopCount,
        createdAt: binding.createdAt,
        completedAt: binding.completedAt,
        additionalInstanceIds: bindingResult.additionalInstanceIds,
      } : null,
      story: {
        events: this.buildStory(slice, trailQitemToStep),
        phaseDefinitions: spec ? projectPhaseDefinitions(spec) : null,
      },
      acceptance: {
        ...this.buildAcceptance(slice),
        currentStep: spec && binding
          ? projectCurrentStep(spec, binding.currentStepId, binding.hopCount, binding.status)
          : null,
      },
      decisions: { rows: this.buildDecisions(slice) },
      docs: { tree: this.buildDocsTree(slice) },
      tests: this.buildTests(slice.proofPacket),
      topology: {
        ...this.buildTopology(slice),
        specGraph: spec && binding ? projectSpecGraph(spec, binding.currentStepId) : null,
      },
    };
  }

  // --- v1 helpers ---

  private tryGetSpec(name: string, version: string) {
    if (!this.workflowSpecCache) return null;
    try {
      const row = this.workflowSpecCache.getByNameVersion(name, version);
      return row?.spec ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Builds a qitem_id → step_id map by reading the bound instance's
   * workflow_step_trails. Each trail row's prior_qitem_id maps to the
   * step that closed (`step_id`), and next_qitem_id maps to the
   * subsequent step's first packet. Used by buildStory to tag each
   * StoryEvent with the spec-defined phase the qitem traces back to.
   */
  private buildTrailQitemToStepMap(instanceId: string): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const trails = this.db.prepare(
        `SELECT step_id, prior_qitem_id, next_qitem_id
           FROM workflow_step_trails
           WHERE instance_id = ?`
      ).all(instanceId) as Array<{
        step_id: string;
        prior_qitem_id: string;
        next_qitem_id: string | null;
      }>;
      for (const t of trails) {
        // The prior_qitem_id is the one that closed AT step_id —
        // events for that qitem belong to step_id's phase.
        map.set(t.prior_qitem_id, t.step_id);
      }
    } catch {
      // workflow_step_trails absent — empty map (events untagged).
    }
    return map;
  }

  // --- Story tab ---

  private buildStory(slice: SliceRecord, trailQitemToStep: Map<string, string>): StoryEvent[] {
    const events: StoryEvent[] = [];
    // v1: phase tag = spec step.id from trail mapping (when bound),
    // null otherwise. v0's hardcoded legacy phase taxonomy is gone.
    const phaseFor = (qitemId: string | null): string | null =>
      qitemId ? trailQitemToStep.get(qitemId) ?? null : null;

    if (slice.qitemIds.length > 0) {
      const placeholders = slice.qitemIds.map(() => "?").join(",");

      // queue_items create/handoff snapshot rows. We use the row itself as
      // a "create" event keyed on ts_created, plus per-row state field at
      // ts_updated. queue_transitions provides the per-transition history.
      try {
        const qrows = this.db.prepare(
          `SELECT qitem_id, ts_created, source_session, destination_session, state, body, tier
             FROM queue_items WHERE qitem_id IN (${placeholders})`
        ).all(...slice.qitemIds) as Array<{
          qitem_id: string; ts_created: string; source_session: string;
          destination_session: string; state: string; body: string; tier: string | null;
        }>;
        for (const r of qrows) {
          events.push({
            ts: r.ts_created,
            phase: phaseFor(r.qitem_id),
            kind: "queue.created",
            actorSession: r.source_session,
            qitemId: r.qitem_id,
            summary: `${r.source_session} → ${r.destination_session}: ${truncate(r.body, 100)}`,
            detail: { tier: r.tier, state: r.state },
          });
        }
      } catch {
        // queue_items absent — skip
      }

      // queue_transitions (per-state-change log; append-only per PL-004
      // Phase A schema).
      try {
        const trows = this.db.prepare(
          `SELECT qitem_id, ts, state, transition_note, actor_session, closure_reason
             FROM queue_transitions WHERE qitem_id IN (${placeholders})
             ORDER BY ts, transition_id`
        ).all(...slice.qitemIds) as Array<{
          qitem_id: string; ts: string; state: string;
          transition_note: string | null; actor_session: string;
          closure_reason: string | null;
        }>;
        for (const t of trows) {
          const note = t.transition_note ?? t.closure_reason;
          events.push({
            ts: t.ts,
            phase: phaseFor(t.qitem_id),
            kind: `transition.${t.state}`,
            actorSession: t.actor_session,
            qitemId: t.qitem_id,
            summary: `→ ${t.state}${note ? ` (${truncate(note, 60)})` : ""}`,
            detail: null,
          });
        }
      } catch {
        // queue_transitions absent — skip
      }

      // mission_control_actions (operator verbs; PL-005 Phase A migration 037).
      try {
        const arows = this.db.prepare(
          `SELECT action_id, acted_at, qitem_id, action_verb, actor_session,
                  before_state_json, after_state_json, reason, annotation
             FROM mission_control_actions WHERE qitem_id IN (${placeholders})
             ORDER BY acted_at, rowid`
        ).all(...slice.qitemIds) as Array<{
          action_id: string; acted_at: string; qitem_id: string;
          action_verb: string; actor_session: string;
          before_state_json: string | null; after_state_json: string | null;
          reason: string | null; annotation: string | null;
        }>;
        for (const a of arows) {
          const note = a.annotation ?? a.reason;
          events.push({
            ts: a.acted_at,
            phase: phaseFor(a.qitem_id),
            kind: `mission_control.${a.action_verb}`,
            actorSession: a.actor_session,
            qitemId: a.qitem_id,
            summary: `${a.actor_session} ${a.action_verb}${note ? `: ${truncate(note, 60)}` : ""}`,
            detail: { before: a.before_state_json, after: a.after_state_json },
          });
        }
      } catch {
        // mission_control_actions absent — skip
      }
    }

    // Slice doc edits (mtimes inside the slice folder). v1: no phase tag
    // — these aren't qitem-bound so they don't trace to a spec step.
    // UI will group them under "Untagged" or render them without a tag.
    try {
      const sliceDir = slice.slicePath;
      const docEntries = fs.readdirSync(sliceDir, { withFileTypes: true });
      for (const entry of docEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const st = fs.statSync(path.join(sliceDir, entry.name));
        events.push({
          ts: st.mtime.toISOString(),
          phase: null,
          kind: "doc.edited",
          actorSession: null,
          qitemId: null,
          summary: `Doc edited: ${entry.name}`,
          detail: null,
        });
      }
    } catch {
      // slice folder unreadable — skip
    }

    // Proof packet emission — single event per packet using directory mtime.
    // v1: also untagged (not qitem-bound).
    if (slice.proofPacket) {
      events.push({
        ts: slice.proofPacket.mtime,
        phase: null,
        kind: "proof_packet.emitted",
        actorSession: null,
        qitemId: null,
        summary: `Proof packet emitted: ${slice.proofPacket.dirName}`,
        detail: {
          markdownCount: slice.proofPacket.markdownFiles.length,
          screenshotCount: slice.proofPacket.screenshots.length,
          videoCount: slice.proofPacket.videos.length,
        },
      });
    }

    events.sort((a, b) => a.ts.localeCompare(b.ts));
    return events;
  }

  // --- Acceptance tab ---

  private buildAcceptance(slice: SliceRecord): Omit<AcceptancePayload, "currentStep"> {
    const items: AcceptanceItem[] = [];
    // Parse README + IMPLEMENTATION-PRD + PROGRESS.md for [ ]/[x] checkbox lines.
    // Source citation = file + 1-based line number so the operator can jump.
    const candidateFiles = ["README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md", "IMPLEMENTATION.md"];
    const sliceDir = slice.slicePath;
    for (const fname of candidateFiles) {
      const full = path.join(sliceDir, fname);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(/^\s*-?\s*\[(\s|x|X)\]\s+(.+)$/);
        if (!m) continue;
        items.push({
          text: m[2]!.trim(),
          done: m[1]!.toLowerCase() === "x",
          source: { file: fname, line: i + 1 },
        });
      }
    }
    const total = items.length;
    const done = items.filter((i) => i.done).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const closureCallout = slice.status === "done"
      ? `Goal Met (status: ${slice.rawStatus ?? "done"})`
      : null;
    return {
      totalItems: total,
      doneItems: done,
      percentage: pct,
      items,
      closureCallout,
    };
  }

  // --- Decisions tab ---

  private buildDecisions(slice: SliceRecord): DecisionRow[] {
    if (slice.qitemIds.length === 0) return [];
    try {
      const placeholders = slice.qitemIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT action_id, acted_at, actor_session, action_verb, qitem_id,
                before_state_json, after_state_json, reason, annotation
           FROM mission_control_actions
           WHERE qitem_id IN (${placeholders})
           ORDER BY acted_at DESC, rowid DESC`
      ).all(...slice.qitemIds) as Array<{
        action_id: string; acted_at: string; actor_session: string;
        action_verb: string; qitem_id: string;
        before_state_json: string | null; after_state_json: string | null;
        reason: string | null; annotation: string | null;
      }>;
      return rows.map((r) => ({
        actionId: r.action_id,
        ts: r.acted_at,
        actor: r.actor_session,
        verb: r.action_verb,
        qitemId: r.qitem_id,
        reason: r.annotation ?? r.reason,
        beforeState: r.before_state_json,
        afterState: r.after_state_json,
      }));
    } catch {
      return [];
    }
  }

  // --- Docs tab ---

  private buildDocsTree(slice: SliceRecord): DocsTreeEntry[] {
    const sliceDir = slice.slicePath;
    const out: DocsTreeEntry[] = [];
    const walk = (dir: string, relPrefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push({ name: entry.name, type: "dir", size: null, mtime: null, relPath: rel });
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = fs.statSync(full);
          out.push({
            name: entry.name,
            type: "file",
            size: st.size,
            mtime: st.mtime.toISOString(),
            relPath: rel,
          });
        } catch {
          // skip
        }
      }
    };
    walk(sliceDir, "");
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
  }

  /** Read a single doc file from the slice folder for the Docs tab. Returns null if missing or outside the slice folder. */
  readDoc(sliceName: string, relPath: string): string | null {
    const slice = this.indexer.get(sliceName);
    if (!slice) return null;
    const sliceDir = slice.slicePath;
    const resolved = path.resolve(sliceDir, relPath);
    if (!resolved.startsWith(`${path.resolve(sliceDir)}${path.sep}`) && resolved !== path.resolve(sliceDir)) {
      // Path-traversal guard.
      return null;
    }
    try {
      return fs.readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  // --- Tests / Verification tab ---

  private buildTests(proofPacket: SliceProofPacket | null): SliceDetailPayload["tests"] {
    if (!proofPacket) {
      return { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } };
    }
    const additionalMarkdown: ProofPacketRendered["additionalMarkdown"] = [];
    let primaryMarkdown: ProofPacketRendered["primaryMarkdown"] = null;
    for (let i = 0; i < proofPacket.markdownFiles.length; i++) {
      const rel = proofPacket.markdownFiles[i]!;
      const content = this.readProofAsset(proofPacket, rel) ?? "";
      if (i === 0) {
        primaryMarkdown = { relPath: rel, content };
      } else {
        additionalMarkdown.push({ relPath: rel, content });
      }
    }
    const passFailBadge = inferPassFailBadge(primaryMarkdown?.content ?? "");
    const rendered: ProofPacketRendered = {
      dirName: proofPacket.dirName,
      primaryMarkdown,
      additionalMarkdown,
      screenshots: proofPacket.screenshots,
      videos: proofPacket.videos,
      traces: proofPacket.traces,
      passFailBadge,
    };
    return {
      proofPackets: [rendered],
      aggregate: {
        passCount: passFailBadge === "pass" ? 1 : 0,
        failCount: passFailBadge === "fail" ? 1 : 0,
      },
    };
  }

  /**
   * Read a proof-packet asset (markdown content or check existence of binary
   * files like screenshots/videos). Path-traversal guarded by absPath prefix
   * check.
   */
  readProofAsset(proofPacket: SliceProofPacket, relPath: string): string | null {
    const resolved = path.resolve(proofPacket.absPath, relPath);
    if (!resolved.startsWith(`${path.resolve(proofPacket.absPath)}${path.sep}`)) {
      return null;
    }
    try {
      return fs.readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  /** Returns the absolute on-disk path of a proof asset for binary serving. Path-traversal guarded. */
  resolveProofAssetPath(proofPacket: SliceProofPacket, relPath: string): string | null {
    const resolved = path.resolve(proofPacket.absPath, relPath);
    if (!resolved.startsWith(`${path.resolve(proofPacket.absPath)}${path.sep}`)) {
      return null;
    }
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  // --- Topology tab ---

  private buildTopology(slice: SliceRecord): Omit<TopologyPayload, "specGraph"> {
    if (slice.qitemIds.length === 0) {
      return { affectedRigs: [], totalSeats: 0 };
    }
    try {
      const placeholders = slice.qitemIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT DISTINCT source_session, destination_session
           FROM queue_items WHERE qitem_id IN (${placeholders})`
      ).all(...slice.qitemIds) as Array<{ source_session: string; destination_session: string }>;

      const sessionsByRig = new Map<string, Set<string>>();
      for (const r of rows) {
        for (const s of [r.source_session, r.destination_session]) {
          if (!s) continue;
          const rig = sessionRigKey(s);
          const set = sessionsByRig.get(rig) ?? new Set<string>();
          set.add(s);
          sessionsByRig.set(rig, set);
        }
      }

      // Resolve rig display names from the rigs table when possible. If the
      // rig isn't registered locally (e.g., session names from another host),
      // we keep the parsed key as a placeholder rigId.
      const rigNames = new Map<string, string>();
      try {
        const rigRows = this.db.prepare(
          `SELECT id, name FROM rigs`
        ).all() as Array<{ id: string; name: string }>;
        for (const r of rigRows) rigNames.set(r.name, r.id);
      } catch {
        // rigs table unavailable — fall back to parsed key as both id and name.
      }

      const affectedRigs: TopologyRigEntry[] = [];
      for (const [rigKey, sessionSet] of sessionsByRig) {
        affectedRigs.push({
          rigId: rigNames.get(rigKey) ?? rigKey,
          rigName: rigKey,
          sessionNames: Array.from(sessionSet).sort(),
        });
      }
      affectedRigs.sort((a, b) => a.rigName.localeCompare(b.rigName));

      const totalSeats = Array.from(sessionsByRig.values()).reduce((sum, set) => sum + set.size, 0);
      return { affectedRigs, totalSeats };
    } catch {
      return { affectedRigs: [], totalSeats: 0 };
    }
  }

  // v1: classifyPhase() heuristic removed — phase tagging is now
  // spec-driven (via workflow_step_trails join in buildTrailQitemToStepMap)
  // or null (untagged) when no workflow_instance is bound. The v0
  // hardcoded legacy phase taxonomy ("discovery"/"product-lab"/"delivery"/
  // "lifecycle"/"qa"/"other" inferred from session-name substrings) is
  // gone. Per slices/slice-story-view-v1/IMPLEMENTATION-PRD.md § Write
  // Set Sketch — explicit deletion noted in commit message.
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function sessionRigKey(session: string): string {
  // Sessions are usually "<member>@<rig>" — the rig portion is the key.
  // Sessions without an @ are treated as their own rig key.
  const idx = session.lastIndexOf("@");
  if (idx === -1) return session;
  return session.slice(idx + 1);
}

function inferPassFailBadge(content: string): "pass" | "fail" | "partial" | "unknown" {
  if (!content) return "unknown";
  const lower = content.toLowerCase();
  if (/\b(accept|accepted|passed|all green|all pass|fully green|green after fix|complete|✅|🟢)/.test(lower)) return "pass";
  if (/\b(blocker|blocked|fail|red|🔴|❌)/.test(lower)) return "fail";
  if (/\b(partial|partially|in progress|standing by)/.test(lower)) return "partial";
  return "unknown";
}
