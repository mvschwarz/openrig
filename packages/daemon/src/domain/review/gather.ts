// Living Notes Packet 2 — the input gatherer (OPR.0.4.4.20).
//
// The impure shell around the pure composer: reads slice docs + proof
// artifacts from disk, attention/agent rows from SQLite, approval stamps
// from frontmatter (cross-checked against the Packet-1 audit-target
// contract), and git facts from the workspace's default repo. Every source
// that cannot be read degrades honestly (nulls / "unknown") — the composer
// renders the named degrade, never invented content.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { sessionMemberLabel } from "../session-name.js";
import type { SliceIndexer, SliceRecord } from "../slices/slice-indexer.js";
import {
  composeMissionReview,
  composeRecordedGreenForSlice,
  composeSliceReview,
  deriveCandidateSha,
  extractMediaRefs,
  extractSection,
  parseC1Header,
  type AgentInput,
  type ApprovalFacts,
  type ApprovalStampFacts,
  type AttentionInput,
  type GitFacts,
  type MissionSliceEntry,
  type SliceComposeInputs,
  type WorkflowExceptionInput,
} from "./compose.js";
import type { AgentsBand, AgentsScope, ComposedMissionReview, ComposedRigAgents, ComposedSliceReview, LockedArtifact, SettledRow, WorkflowRowRef } from "./types.js";
import { composeAgentsBand, composeRigAgents } from "./compose.js";
import { evaluateStepDeadline } from "../workflow-deadline.js";
import type { AgentActivityStore } from "../agent-activity-store.js";
import { isHumanSeatSession } from "../human-route-enforcer.js";

export interface ReviewGathererDeps {
  db: Database.Database;
  indexer: SliceIndexer;
  /** Repo path for git lineage facts (the workspace default repo); null = degrade to unknown. */
  gitRepoPath?: string | null;
  /** OPR.0.4.4.22 — hook-activity reads for the agent state glyph (FR-2).
   *  Optional: absent → every glyph degrades to honest `unknown` (never
   *  guessed). Synchronous SQLite reads; no polling, no agent contact. */
  activityStore?: AgentActivityStore | null;
  /** Injected clock so composition stays reproducible in tests. */
  now?: () => string;
}

interface QitemRow {
  qitem_id: string;
  ts_created: string;
  destination_session: string;
  state: string;
  priority: string | null;
  tier: string | null;
  tags: string | null;
  summary: string | null;
  blocked_on: string | null;
  closure_required_at: string | null;
  ts_updated: string;
}

const ACTIVE_STATES = ["pending", "in-progress", "claimed", "blocked", "handed-off"];

/** OPR.0.4.6.WF4 Q6 — the ● (agent-leg) workflow-identity stamp, derived from
 *  the item's OWN STRUCTURED TAGS (`workflow:<name>` / `instance:<id>` /
 *  `step:<id>` — the WF-5-ratified queryable identity), NEVER from summary /
 *  identity / evidenceRef prose. Returns the pointer only when BOTH required
 *  keys are present; a non-workflow row (no `instance:`/`workflow:` tag) →
 *  `undefined`, so its AttentionInput stays byte-identical (omit-when-absent).
 *  Pointer-only: the three identity keys, never status/deadline/class. */
export function workflowRefFromTags(tagsJson: string | null): WorkflowRowRef | undefined {
  if (!tagsJson) return undefined;
  let tags: string[];
  try {
    tags = (JSON.parse(tagsJson) as string[]) ?? [];
  } catch {
    return undefined;
  }
  let instanceId: string | undefined;
  let workflowName: string | undefined;
  let stepId: string | undefined;
  for (const t of tags) {
    if (t.startsWith("instance:")) instanceId = t.slice("instance:".length);
    else if (t.startsWith("workflow:")) workflowName = t.slice("workflow:".length);
    else if (t.startsWith("step:")) stepId = t.slice("step:".length);
  }
  if (!instanceId || !workflowName) return undefined;
  return { instanceId, workflowName, ...(stepId ? { stepId } : {}) };
}

export class ReviewGatherer {
  private readonly db: Database.Database;
  private readonly indexer: SliceIndexer;
  private readonly gitRepoPath: string | null;
  private readonly activityStore: AgentActivityStore | null;
  private readonly now: () => string;

  constructor(deps: ReviewGathererDeps) {
    this.db = deps.db;
    this.indexer = deps.indexer;
    this.gitRepoPath = deps.gitRepoPath ?? null;
    this.activityStore = deps.activityStore ?? null;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  composeSlice(name: string): ComposedSliceReview | null {
    const inputs = this.gatherSlice(name);
    return inputs ? composeSliceReview(inputs) : null;
  }

  /** Composition plus the on-disk context the freeze renderer needs (FR-6). */
  composeSliceWithContext(name: string): { composed: ComposedSliceReview; sliceDir: string; mediaRefs: string[] } | null {
    const slice = this.indexer.get(name);
    const inputs = this.gatherSlice(name);
    if (!slice || !inputs) return null;
    return { composed: composeSliceReview(inputs), sliceDir: slice.slicePath, mediaRefs: inputs.mediaRefs };
  }

  composeMission(mission: string): ComposedMissionReview | null {
    const slices = this.indexer.list().filter((s) => s.missionId === mission);
    if (slices.length === 0 && !this.missionDirExists(mission)) return null;
    const nowIso = this.now();
    // The ledger's recorded-verdict green rides beside each composed review
    // (FR-7): the gatherer holds the artifacts, so it derives the mission-
    // altitude completion fact the slice contract no longer carries (§11).
    const composed = slices
      .map((s): MissionSliceEntry | null => {
        const inputs = this.gatherSlice(s.name);
        if (!inputs) return null;
        return {
          review: composeSliceReview(inputs),
          green: composeRecordedGreenForSlice(inputs.artifacts).green,
        };
      })
      .filter((s): s is MissionSliceEntry => s !== null);
    const missionMeta = this.readMissionMeta(mission);
    return composeMissionReview({
      mission: { name: mission, id: missionMeta.id, title: missionMeta.title, intent: missionMeta.intent },
      slices: composed,
      missionAttention: this.attentionForTag(`mission:${mission}`, `slice:`),
      agents: this.agentsForSlices(slices.map((s) => s.name)),
      nowIso,
    });
  }

  /**
   * OPR.0.4.4.22 — the composed rig-agents read root (FR-1..FR-4): NEEDS
   * YOU + AGENTS (health line) + SETTLED at rig scope. Pure projection over
   * queue + hook-activity; nothing contacts an agent. The roster is
   * active-holders UNION recently-holding (transitions-on-scope-TODAY — the
   * plan-review-ruled display window, named in provenance).
   */
  composeRig(): ComposedRigAgents {
    const nowIso = this.now();
    const todayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
    const agents = this.withTelemetry(this.rigRoster(todayStart), nowIso);
    const attention = this.attentionAll();
    const overdue = this.overdueWork(nowIso);
    const { settled, handoffsToday } = this.settledToday(todayStart);
    return composeRigAgents({
      agents,
      overdue,
      attention,
      settled,
      handoffsToday,
      overdueCount: overdue.length,
      rosterWindow: "today",
      workflows: this.gatherWorkflowExceptions(nowIso),
      nowIso,
    });
  }

  /** The scope-parameterized agents projection — ONE contract, all consumers. */
  composeAgents(scope: AgentsScope): AgentsBand | null {
    const nowIso = this.now();
    if (scope === "rig") {
      return composeAgentsBand(this.agentsForSlices(null), scope, [], nowIso);
    }
    if (scope.startsWith("slice:")) {
      const name = scope.slice("slice:".length);
      if (!this.indexer.get(name)) return null;
      return composeAgentsBand(this.agentsForSlices([name]), scope, [], nowIso);
    }
    const mission = scope.slice("mission:".length);
    const slices = this.indexer.list().filter((s) => s.missionId === mission);
    if (slices.length === 0 && !this.missionDirExists(mission)) return null;
    return composeAgentsBand(this.agentsForSlices(slices.map((s) => s.name)), scope, [], nowIso);
  }

  // -------------------------------------------------------------------------

  gatherSlice(name: string): SliceComposeInputs | null {
    const slice = this.indexer.get(name);
    if (!slice) return null;

    const readme = this.readFile(path.join(slice.slicePath, "README.md"));
    const prd = this.readFile(path.join(slice.slicePath, "IMPLEMENTATION-PRD.md"));
    const proofMd = this.readFile(path.join(slice.slicePath, "PROOF.md"));

    const artifacts = this.readProofArtifacts(slice.slicePath);
    const attention = this.attentionForTag(`slice:${name}`);
    const agents = this.agentsForSlices([name]);
    const frontmatter = this.parseFrontmatter(readme);
    const approval = this.gatherApproval(slice, frontmatter);
    const candidateRef = deriveCandidateSha(artifacts);

    return {
      slice: {
        name: slice.name,
        id: typeof frontmatter["id"] === "string" ? (frontmatter["id"] as string) : null,
        title: slice.displayName,
        missionId: slice.missionId,
      },
      readme,
      prd,
      proofMd,
      artifacts,
      lockedArtifacts: this.parseLockedArtifacts(frontmatter),
      mediaRefs: this.collectMediaRefs([readme, prd, proofMd]),
      proofDirExists: fs.existsSync(path.join(slice.slicePath, "proof")),
      attention,
      agents,
      workflows: this.gatherWorkflowExceptions(this.now()),
      activeQitemPresent: this.hasActiveQitem(name, slice),
      git: this.gatherGitFacts(frontmatter, candidateRef),
      approval,
      nowIso: this.now(),
    };
  }

  /** §3.1's ONLY genuinely new datum: the pinned plan set, a frontmatter READ
   *  (`locked-artifacts:` list on the slice README — the scope-fs pattern,
   *  zero new file kinds, zero new write machinery). Malformed entries are
   *  skipped, never invented. */
  private parseLockedArtifacts(fm: Record<string, unknown>): LockedArtifact[] {
    const raw = fm["locked-artifacts"];
    if (!Array.isArray(raw)) return [];
    const out: LockedArtifact[] = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const p = typeof e["path"] === "string" ? e["path"].trim() : "";
      if (!p) continue;
      out.push({
        name: typeof e["name"] === "string" && e["name"].trim() ? e["name"].trim() : p,
        path: p,
        kind: typeof e["kind"] === "string" && e["kind"].trim() ? e["kind"].trim() : "artifact",
      });
    }
    return out;
  }

  private readFile(p: string): string | null {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  private missionDirExists(mission: string): boolean {
    // The indexer knows slices; a slice-less mission still composes (empty board).
    return this.indexer.list().some((s) => s.missionId === mission);
  }

  private readMissionMeta(mission: string): { id: string | null; title: string; intent: string | null; missionDir: string | null } {
    const anySlice = this.indexer.list().find((s) => s.missionId === mission);
    if (anySlice) {
      const missionDir = path.dirname(path.dirname(anySlice.slicePath));
      const readme = this.readFile(path.join(missionDir, "README.md"));
      const fm = this.parseFrontmatter(readme);
      // FR-8: the brief's "What & why" projects VERBATIM as the intent opener.
      const brief = this.readFile(path.join(missionDir, "MISSION_BRIEF.md"));
      return {
        id: typeof fm["id"] === "string" ? (fm["id"] as string) : null,
        title: typeof fm["title"] === "string" ? (fm["title"] as string) : mission,
        intent: extractSection(brief, "What & why"),
        missionDir,
      };
    }
    return { id: null, title: mission, intent: null, missionDir: null };
  }

  /** FR-8 freeze-moment brief write target: {absolute path, current content}. */
  missionBriefTarget(mission: string): { briefPath: string; content: string } | null {
    const meta = this.readMissionMeta(mission);
    if (!meta.missionDir) return null;
    const briefPath = path.join(meta.missionDir, "MISSION_BRIEF.md");
    const content = this.readFile(briefPath);
    return content === null ? null : { briefPath, content };
  }

  private parseFrontmatter(content: string | null): Record<string, unknown> {
    if (!content) return {};
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    try {
      return (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private readProofArtifacts(sliceDir: string) {
    const proofDir = path.join(sliceDir, "proof");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(proofDir).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
    return entries
      .sort()
      .map((f) => {
        const full = path.join(proofDir, f);
        try {
          const content = fs.readFileSync(full, "utf8");
          const mtime = fs.statSync(full).mtime.toISOString();
          return parseC1Header(content, `proof/${f}`, mtime);
        } catch {
          return null;
        }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }

  /** Markdown image/video refs across the composed sources (FR-5 defect scan). */
  private collectMediaRefs(sources: Array<string | null>): string[] {
    return sources.flatMap((s) => extractMediaRefs(s));
  }

  private tableExists(name: string): boolean {
    try {
      const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      return row !== undefined;
    } catch {
      return false;
    }
  }

  private columnExists(table: string, column: string): boolean {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === column);
    } catch {
      return false;
    }
  }

  /** Human-routed attention rows carrying the given tag (the §5 predicate is
   *  Packet 1's; until it lands, human-tier/human-dest/park-on-human rows are
   *  selected with the same shape). */
  /** OPR.0.4.6.WF5 FR-3 — recorded workflow-instance views for the ▲
   *  band: failed + in-flight instances, the WF-1 evaluator verdict
   *  (consumed, never recomputed — the module import IS the single
   *  home), the open exception item by TAG QUERY (never summary
   *  parsing), and the non-open-frontier anomaly check. Read-only;
   *  absent tables (pre-workflow DBs) return []. */
  private gatherWorkflowExceptions(nowIso: string): WorkflowExceptionInput[] {
    try {
      const instances = this.db
        .prepare(
          `SELECT instance_id, workflow_name, status, current_step_id, current_frontier_json
           FROM workflow_instances WHERE status IN ('failed','active','waiting')`,
        )
        .all() as Array<{
        instance_id: string;
        workflow_name: string;
        status: string;
        current_step_id: string | null;
        current_frontier_json: string;
      }>;
      const now = new Date(nowIso);
      const out: WorkflowExceptionInput[] = [];
      for (const row of instances) {
        let frontier: string[] = [];
        try {
          frontier = (JSON.parse(row.current_frontier_json) as string[]) ?? [];
        } catch {
          frontier = [];
        }
        const packets = frontier.map(
          (id) =>
            this.db
              .prepare(
                `SELECT qitem_id, state, destination_session, ts_created, claimed_at, closure_required_at
                 FROM queue_items WHERE qitem_id = ?`,
              )
              .get(id) as
              | { qitem_id: string; state: string; destination_session: string; ts_created: string; claimed_at: string | null; closure_required_at: string | null }
              | undefined,
        );
        const frontierRefsNonOpenPacket =
          (row.status === "active" || row.status === "waiting") &&
          packets.some((p) => p && !["pending", "in-progress", "blocked"].includes(p.state));
        const verdict = evaluateStepDeadline(
          {
            instanceId: row.instance_id,
            status: row.status,
            currentFrontier: frontier,
            currentStepId: row.current_step_id,
          },
          packets.map((p) =>
            p
              ? {
                  qitemId: p.qitem_id,
                  state: p.state,
                  destinationSession: p.destination_session,
                  tsCreated: p.ts_created,
                  claimedAt: p.claimed_at,
                  closureRequiredAt: p.closure_required_at,
                }
              : null,
          ),
          now,
        );
        const item = this.db
          .prepare(
            `SELECT qitem_id, destination_session, tier, ts_created, summary
             FROM queue_items
             WHERE state IN ('pending','in-progress','blocked')
               AND tags LIKE ? AND tags LIKE ?
             ORDER BY ts_created DESC LIMIT 1`,
          )
          .get(`%"instance:${row.instance_id}"%`, `%"workflow-exception"%`) as
          | { qitem_id: string; destination_session: string; tier: string | null; ts_created: string; summary: string | null }
          | undefined;
        out.push({
          instanceId: row.instance_id,
          workflowName: row.workflow_name,
          status: row.status,
          currentStepId: row.current_step_id,
          deadlineState: verdict.state,
          deadlineEvidence: verdict.evidence
            ? `step ${verdict.evidence.stepId ?? "?"} packet ${verdict.evidence.packetId} held by ${verdict.evidence.ownerSession} — ${verdict.evidence.overdueBySeconds}s past the ${verdict.evidence.anchor} anchor`
            : null,
          frontierRefsNonOpenPacket,
          openItem: item
            ? {
                qitemId: item.qitem_id,
                destinationSession: item.destination_session,
                humanRouted:
                  item.tier === "human-gate" || /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(item.destination_session),
                createdAtIso: item.ts_created,
                summary: item.summary,
              }
            : null,
        });
      }
      return out;
    } catch (err) {
      // Pre-workflow DBs (no tables) compose byte-identically to
      // pre-WF-5; anything else fails LOUD (the WF-3 narrowed-catch
      // lesson — a broad catch here would silently blind the band).
      if (err instanceof Error && /no such table/i.test(err.message)) return [];
      throw err;
    }
  }

  private attentionForTag(tag: string, excludeTagPrefix?: string): AttentionInput[] {
    if (!this.tableExists("queue_items")) return [];
    const hasEvidenceRef = this.columnExists("queue_items", "evidence_ref");
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at${hasEvidenceRef ? ", evidence_ref" : ""}
         FROM queue_items
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})
           AND tags LIKE ?
           AND (tier = 'human-gate'
                OR destination_session LIKE 'human%'
                OR (state = 'blocked' AND blocked_on LIKE 'human%'))`,
      )
      .all(...ACTIVE_STATES, `%"${tag}"%`) as Array<QitemRow & { evidence_ref?: string | null }>;
    return rows
      .filter((r) => {
        if (!excludeTagPrefix) return true;
        try {
          const tags = (JSON.parse(r.tags ?? "[]") as string[]) ?? [];
          return !tags.some((t) => t.startsWith(excludeTagPrefix));
        } catch {
          return true;
        }
      })
      .map((r) => {
        // OPR.0.4.6.WF4 Q6 — stamp the ● workflow pointer from the item's own
        // tags; OMITTED for non-workflow rows (byte-identity-by-omission).
        const workflow = workflowRefFromTags(r.tags);
        return {
          qitemId: r.qitem_id,
          summary: r.summary,
          leg: r.state === "blocked" ? "park-on-human" : "human-routed",
          where: r.destination_session,
          createdAtIso: r.ts_created,
          priority: r.priority,
          tier: r.tier,
          evidenceRef: r.evidence_ref ?? null,
          unblocks: r.state === "blocked" ? r.qitem_id : null,
          destinationSession: r.destination_session,
          closureRequiredAtIso: r.closure_required_at,
          ...(workflow ? { workflow } : {}),
        };
      });
  }

  /** Sessions holding active work on the named slices (null = rig-wide).
   *  Region membership derives from work-on-scope, never rig co-residency.
   *  Runtime/idle telemetry is honest-unknown at v1 (queue-derived only). */
  private agentsForSlices(sliceNames: string[] | null): AgentInput[] {
    if (!this.tableExists("queue_items")) return [];
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at
         FROM queue_items
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})`,
      )
      .all(...ACTIVE_STATES) as QitemRow[];
    const bySession = new Map<string, { rows: QitemRow[]; slices: Set<string> }>();
    for (const r of rows) {
      if (isHumanSeatSession(r.destination_session)) continue;
      let tags: string[] = [];
      try {
        tags = (JSON.parse(r.tags ?? "[]") as string[]) ?? [];
      } catch {
        tags = [];
      }
      const rowSlices = tags.filter((t) => t.startsWith("slice:")).map((t) => t.slice("slice:".length));
      if (sliceNames !== null && !rowSlices.some((s) => sliceNames.includes(s))) continue;
      const entry = bySession.get(r.destination_session) ?? { rows: [], slices: new Set<string>() };
      entry.rows.push(r);
      for (const s of rowSlices) entry.slices.add(s);
      bySession.set(r.destination_session, entry);
    }
    return [...bySession.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([session, e]) => {
        const latest = e.rows.reduce((acc, r) => (r.ts_updated > acc.ts_updated ? r : acc), e.rows[0]!);
        const parked = e.rows
          .filter((r) => !!r.blocked_on)
          .reduce<QitemRow | null>((acc, r) => (!acc || r.ts_updated > acc.ts_updated ? r : acc), null);
        return {
          agentName: sessionMemberLabel(session), // OPR.0.4.6.MH1 FR-8: shared contract
          sessionName: session,
          runtime: "unknown" as const,
          parkedOn: parked?.blocked_on ?? null,
          idle: null, // honest-unknown: queue rows alone cannot prove liveness
          idleSinceIso: null,
          doing: parked?.summary ?? latest.summary,
          holdsCount: e.rows.length,
          lastTransitionIso: (parked ?? latest).ts_updated,
          slices: [...e.slices].sort(),
        };
      });
  }

  // --- OPR.0.4.4.22 rig-scope helpers (all synchronous SQLite reads) ---

  /** FR-1 roster: agents HOLDING active work on any slice-tagged item, UNION
   *  agents RECENTLY holding (their slice-tagged items transitioned today —
   *  the ruled display window). Membership derives from work-on-scope,
   *  never rig co-residency. */
  private rigRoster(todayStartIso: string): AgentInput[] {
    const holders = this.agentsForSlices(null);
    if (!this.tableExists("queue_items")) return holders;
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    // Recently-holding: destination of a slice-tagged qitem whose latest
    // update landed today but is no longer in an active state.
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at
         FROM queue_items
         WHERE ts_updated >= ?
           AND state NOT IN (${ACTIVE_STATES.map(() => "?").join(",")})
           AND tags LIKE '%"slice:%'`,
      )
      .all(todayStartIso, ...ACTIVE_STATES) as QitemRow[];
    const known = new Set(holders.map((h) => h.sessionName));
    const recent = new Map<string, { latest: QitemRow; slices: Set<string> }>();
    for (const r of rows) {
      if (isHumanSeatSession(r.destination_session)) continue;
      if (known.has(r.destination_session)) continue;
      let tags: string[] = [];
      try {
        tags = (JSON.parse(r.tags ?? "[]") as string[]) ?? [];
      } catch {
        tags = [];
      }
      const rowSlices = tags.filter((t) => t.startsWith("slice:")).map((t) => t.slice("slice:".length));
      if (rowSlices.length === 0) continue;
      const entry = recent.get(r.destination_session) ?? { latest: r, slices: new Set<string>() };
      if (r.ts_updated > entry.latest.ts_updated) entry.latest = r;
      for (const s of rowSlices) entry.slices.add(s);
      recent.set(r.destination_session, entry);
    }
    const recentInputs: AgentInput[] = [...recent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([session, e]) => ({
        agentName: sessionMemberLabel(session), // OPR.0.4.6.MH1 FR-8: shared contract
        sessionName: session,
        runtime: "unknown" as const,
        parkedOn: null,
        idle: null,
        idleSinceIso: null,
        // FR-1: an agent with no tracked ACTIVE item renders the truth —
        // itself a coordination signal; nothing is invented.
        doing: "no tracked work item",
        holdsCount: 0,
        lastTransitionIso: e.latest.ts_updated,
        slices: [...e.slices].sort(),
      }));
    return [...holders, ...recentInputs].sort((a, b) => a.sessionName.localeCompare(b.sessionName));
  }

  /** FR-2 telemetry enrichment: runtime from the sessions/nodes tables, the
   *  active/idle light from recorded hook activity (AgentActivityStore).
   *  Anything unprovable stays honest-unknown — never guessed. */
  private withTelemetry(agents: AgentInput[], nowIso: string): AgentInput[] {
    const runtimes = this.sessionRuntimes();
    return agents.map((a) => {
      const runtime = runtimes.get(a.sessionName) ?? "unknown";
      let idle: boolean | null = a.idle;
      let idleSinceIso: string | null = a.idleSinceIso;
      if (this.activityStore) {
        try {
          const activity = this.activityStore.getLatestForNode({ sessionName: a.sessionName, now: new Date(nowIso) });
          if (activity?.state === "running") {
            idle = false;
            idleSinceIso = null;
          } else if (activity?.state === "idle") {
            idle = true;
            idleSinceIso = activity.eventAt ?? activity.sampledAt ?? null;
          }
          // needs_input / unknown / null → stays honest-unknown.
        } catch {
          // Telemetry read failure = unknown, never a guess.
        }
      }
      const normalizedRuntime =
        runtime === "claude-code" || runtime === "codex" || runtime === "terminal" ? runtime : ("unknown" as const);
      return { ...a, runtime: normalizedRuntime, idle, idleSinceIso };
    });
  }

  private sessionRuntimes(): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.tableExists("sessions") || !this.tableExists("nodes")) return out;
    try {
      const rows = this.db
        .prepare(
          `SELECT s.session_name AS session_name, n.runtime AS runtime
           FROM sessions s JOIN nodes n ON n.id = s.node_id
           WHERE s.session_name IS NOT NULL`,
        )
        .all() as Array<{ session_name: string; runtime: string | null }>;
      for (const r of rows) if (r.runtime) out.set(r.session_name, r.runtime);
    } catch {
      /* degrade to unknown runtimes */
    }
    return out;
  }

  /** Rig-scope NEEDS YOU: ALL human-routed active items (no tag filter). */
  private attentionAll(): AttentionInput[] {
    if (!this.tableExists("queue_items")) return [];
    const hasEvidenceRef = this.columnExists("queue_items", "evidence_ref");
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at${hasEvidenceRef ? ", evidence_ref" : ""}
         FROM queue_items
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})
           AND (tier = 'human-gate'
                OR destination_session LIKE 'human%'
                OR (state = 'blocked' AND blocked_on LIKE 'human%'))`,
      )
      .all(...ACTIVE_STATES) as Array<QitemRow & { evidence_ref?: string | null }>;
    return rows.map((r) => {
      // OPR.0.4.6.WF4 Q6 — stamp the ● workflow pointer from the item's own
      // tags; OMITTED for non-workflow rows (byte-identity-by-omission).
      const workflow = workflowRefFromTags(r.tags);
      return {
        qitemId: r.qitem_id,
        summary: r.summary,
        leg: r.state === "blocked" ? "park-on-human" : "human-routed",
        where: r.destination_session,
        createdAtIso: r.ts_created,
        priority: r.priority,
        tier: r.tier,
        evidenceRef: r.evidence_ref ?? null,
        unblocks: r.state === "blocked" ? r.qitem_id : null,
        destinationSession: r.destination_session,
        closureRequiredAtIso: r.closure_required_at,
        ...(workflow ? { workflow } : {}),
      };
    });
  }

  /** FR-4: today's closed handoffs from the transitions log — the SETTLED
   *  band and the health line's handoff count come from the SAME query
   *  (two renders, one computation). */
  private settledToday(todayStartIso: string): { settled: SettledRow[]; handoffsToday: number } {
    if (!this.tableExists("queue_transitions")) return { settled: [], handoffsToday: 0 };
    const summaryJoin = this.tableExists("queue_items") && this.columnExists("queue_items", "summary")
      ? "LEFT JOIN queue_items q ON q.qitem_id = t.qitem_id"
      : null;
    try {
      const rows = this.db
        .prepare(
          `SELECT t.qitem_id AS qitem_id, t.ts AS ts, t.actor_session AS actor_session,
                  t.closure_target AS closure_target${summaryJoin ? ", q.summary AS summary" : ", NULL AS summary"}
           FROM queue_transitions t
           ${summaryJoin ?? ""}
           WHERE t.closure_reason = 'handed_off_to' AND t.ts >= ?
           ORDER BY t.ts DESC`,
        )
        .all(todayStartIso) as Array<{ qitem_id: string; ts: string; actor_session: string; closure_target: string | null; summary: string | null }>;
      const settled: SettledRow[] = rows.map((r) => ({
        fromSession: r.actor_session,
        toSession: r.closure_target ?? "unknown",
        summary: r.summary,
        closedAtIso: r.ts,
        qitemId: r.qitem_id,
      }));
      return { settled, handoffsToday: settled.length };
    } catch {
      return { settled: [], handoffsToday: 0 };
    }
  }

  /** FR-3/FR-4: in-progress slice work past closure_required_at, rig-wide.
   *  Feeds both the derived NEEDS YOU exception and the health count. */
  private overdueWork(nowIso: string): AttentionInput[] {
    if (!this.tableExists("queue_items")) return [];
    try {
      const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
      const rows = this.db
        .prepare(
          `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                  blocked_on, closure_required_at
           FROM queue_items
           WHERE state = 'in-progress'
             AND closure_required_at IS NOT NULL
             AND closure_required_at < ?
             AND tags LIKE '%"slice:%'`,
        )
        .all(nowIso) as QitemRow[];
      return rows.map((r) => {
        // OPR.0.4.6.WF4 Q6 — stamp the ● workflow pointer from the item's own
        // tags; OMITTED for non-workflow rows (byte-identity-by-omission).
        const workflow = workflowRefFromTags(r.tags);
        return {
          qitemId: r.qitem_id,
          summary: r.summary,
          leg: "overdue",
          where: r.destination_session,
          createdAtIso: r.ts_created,
          priority: r.priority,
          tier: r.tier,
          evidenceRef: null,
          unblocks: null,
          destinationSession: r.destination_session,
          closureRequiredAtIso: r.closure_required_at,
          ...(workflow ? { workflow } : {}),
        };
      });
    } catch {
      return [];
    }
  }

  private hasActiveQitem(name: string, slice: SliceRecord): boolean {
    if (!this.tableExists("queue_items")) return false;
    const row = this.db
      .prepare(
        `SELECT 1 FROM queue_items WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")}) AND tags LIKE ? LIMIT 1`,
      )
      .get(...ACTIVE_STATES, `%"slice:${name}"%`);
    if (row) return true;
    if (slice.qitemIds.length === 0) return false;
    const placeholders = slice.qitemIds.map(() => "?").join(",");
    try {
      return this.db
        .prepare(
          `SELECT 1 FROM queue_items
           WHERE qitem_id IN (${placeholders})
             AND state IN (${ACTIVE_STATES.map(() => "?").join(",")})
           LIMIT 1`,
        )
        .get(...slice.qitemIds, ...ACTIVE_STATES) !== undefined;
    } catch {
      return false;
    }
  }

  /** §4 — the two staged-approval stamps (arch F-A: the SHIPPED verb's
   *  frontmatter fields), each cross-checked against the pinned
   *  scope-approval audit shape (`approval_scope` inside audit_notes_json).
   *  A stamp with no matching row -> auditVerified false (UNVERIFIED stamp,
   *  rendered loudly — never a block). */
  private gatherApproval(slice: SliceRecord, fm: Record<string, unknown>): ApprovalFacts {
    const str = (k: string): string | null => {
      const v = fm[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v instanceof Date) return v.toISOString();
      return null;
    };
    const sliceId = str("id");

    const auditRowPresent = (approvalScope: "spec" | "delivery"): boolean => {
      if (!this.tableExists("mission_control_actions")) return false;
      try {
        return (
          this.db
            .prepare(
              `SELECT 1 FROM mission_control_actions
               WHERE action_verb='approve'
                 AND audit_notes_json LIKE ?
                 AND (audit_notes_json LIKE ? OR audit_notes_json LIKE ?)
               LIMIT 1`,
            )
            .get(
              `%"approval_scope":"${approvalScope}"%`,
              // A null slice id must never match an empty scope_id row.
              sliceId ? `%"scope_id":"${sliceId}"%` : `%"scope_id":"${slice.name}"%`,
              `%${slice.name}%`,
            ) !== undefined
        );
      } catch {
        return false;
      }
    };

    const stamp = (byKey: string, atKey: string, approvalScope: "spec" | "delivery"): ApprovalStampFacts | null => {
      const by = str(byKey);
      const at = str(atKey);
      if (!by || !at) return null;
      return { by, at, auditRowPresent: auditRowPresent(approvalScope) };
    };

    return {
      spec: stamp("approved-spec-by", "approved-spec-at", "spec"),
      delivery: stamp("approved-by", "approved-at", "delivery"),
    };
  }

  private git(args: string[]): string | null {
    if (!this.gitRepoPath) return null;
    try {
      return execFileSync("git", args, { cwd: this.gitRepoPath, timeout: 4000, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }

  private gatherGitFacts(fm: Record<string, unknown>, candidateSha: string | null): GitFacts {
    const mainTip = this.git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
    const sliceId = typeof fm["id"] === "string" ? (fm["id"] as string) : null;
    let mergeSha: string | null = null;
    if (sliceId) {
      const found = this.git(["log", "--fixed-strings", `--grep=Merge ${sliceId}`, "--format=%h", "-1"]);
      mergeSha = found && found.length > 0 ? found : null;
    }
    let mergeIsAncestorOfTip: boolean | null = null;
    if (mergeSha) {
      const out = this.git(["merge-base", "--is-ancestor", mergeSha, "HEAD"]);
      // exec throws (returns null) on non-ancestor exit 1; success returns "".
      mergeIsAncestorOfTip = out !== null;
    }
    let candidateBehindTip: number | null = null;
    if (!mergeSha && candidateSha) {
      const base = this.git(["merge-base", candidateSha, "HEAD"]);
      if (base) {
        const count = this.git(["rev-list", "--count", `${base}..HEAD`]);
        candidateBehindTip = count !== null && /^\d+$/.test(count) ? Number(count) : null;
      }
    }
    return { mainTip, mergeSha, mergeIsAncestorOfTip, candidateBehindTip };
  }
}
