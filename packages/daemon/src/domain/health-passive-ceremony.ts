import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { QueueRepository } from "./queue-repository.js";
import type { HealthCheckpointSource } from "./health-checkpoints.js";
import type { OperatingPostureService } from "./rig-mode/operating-posture.js";
import { readHealthArtifact, healthSelectedContext } from "./health-context.js";
import { validateMissionComposition } from "./lifecycle-manifest.js";
import { healthHash, type HealthPolicyStore } from "./health-policy.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";
import { isOpenRigSender } from "../lib/pane-envelope.js";
import { adaptQueueTransitionEvidence, boundHealthEvidence, deriveHealthSourceFreshness, healthEpisodeId, type HealthScope, type PassiveCeremony, type CeremonyProgressAssessment } from "./health-projection.js";

const detector = "process.ceremony-amplification";
const familyLimit = 200;
const excluded = (tags: string[] | null | undefined) => tags?.some((t) => t === "health-diagnosis" || t === "health-human") ?? false;
const one = (values: string[]) => { const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : undefined; };
const tagged = (tags: string[], prefix: string) => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));

/** Notes the daemon writes about its own queue bookkeeping, matched by prefix (an owner's note that
 * merely quotes one still counts). `auto-unparked:` and `blocker custody moved ` are recorded under
 * the seat that closed the blocker (queue-repository.ts), so the actor does not reveal them; park and
 * parked-owner wakes (queue-repository.ts, policies/parked-owner-consumer.ts) are excluded under any actor. */
const DAEMON_BOOKKEEPING_NOTE_PREFIXES = ["auto-unparked:", "blocker custody moved ", "park wake ", "parked-owner "] as const;

/** The daemon's own actors: `*@system` (watchdog, queue, stuck-sweep, wake-ladder, claim, ...), the
 * bare `system` that releases or transfers claims when a seat's occupant changes (queue-repository.ts),
 * and OpenRig's own sender (`isOpenRigSender`): the exact `daemon@kernel` (wake escalations, stream intake,
 * the Slack gateway, quiet-release, delivery-deferral, ...) and every `system:*` actor (queue fallback
 * routing, compaction restore notices, health, ...). Other kernel seats (`human@kernel`,
 * `advisor-lead@kernel`) are seats and still count. */
const isSystemActor = (actor: string) => actor === "system" || actor.endsWith("@system") || isOpenRigSender(actor);

/** #2762: a coordination transition is one a seat decided; system actors and daemon bookkeeping notes are not. */
function isCoordinationTransition(t: { actorSession: string; transitionNote: string | null }): boolean {
  if (isSystemActor(t.actorSession)) return false;
  const note = t.transitionNote;
  return !note || !DAEMON_BOOKKEEPING_NOTE_PREFIXES.some((prefix) => note.startsWith(prefix));
}

/** A read-only question generator. Proof files, closures and acceptance receipts
 * are material for the diagnosing agent, never an automatic outcome counter. */
export class PassiveCeremonySource implements HealthObservationSource {
  readonly name = "passive-ceremony";
  readonly detectors = ["process.ceremony-amplification"];
  constructor(private readonly workspace: string, private readonly queue: QueueRepository, private readonly policy: HealthPolicyStore,
    private readonly now = () => new Date().toISOString(), private readonly checkpoints?: HealthCheckpointSource,
    private readonly posture?: { reader: OperatingPostureService; instanceId: string }) {}

  private lastCoverage: HealthSourceCoverage | undefined;
  /** This evaluation's lineage-tagged rows by tag, read once on first use (closedBoundaries). */
  private lineageRows: Map<string, string[]> | undefined;
  coverage(): HealthSourceCoverage[] { return this.lastCoverage ? [this.lastCoverage] : []; }

  read(): HealthDetectorObservation[] {
    this.lastCoverage = undefined;
    this.lineageRows = undefined;
    const now = this.now(); const p = this.policy.read().policy;
    const start = new Date(Date.parse(now) - p.observationWindowSeconds * 1000).toISOString();
    const touched = this.queue.db.prepare("SELECT qitem_id AS id, COUNT(*) AS n FROM queue_transitions WHERE ts >= ? AND ts <= ? GROUP BY qitem_id ORDER BY qitem_id LIMIT 2001").all(start, now) as Array<{ id: string; n: number }>;
    if (touched.length > 2000) throw new Error("health_passive_queue_window_truncated");
    type Member = { qitemId: string; handedOffFrom: string | null; tags: string[] };
    const roots = new Map<string, Member>();
    const members = new Map<string, Set<string>>();
    const activity = new Map<string, number>();
    const cached = new Map<string, Member | null>();
    // Read only linkage metadata; the queue's full row projection derives pickup
    // and notification state that this bounded source neither needs nor interprets.
    const lookup = this.queue.db.prepare("SELECT qitem_id AS qitemId, handed_off_from AS handedOffFrom, tags FROM queue_items WHERE qitem_id = ?");
    const get = (id: string): Member | null => {
      if (!cached.has(id)) {
        const row = lookup.get(id) as { qitemId: string; handedOffFrom: string | null; tags: string | null } | undefined;
        cached.set(id, row ? { ...row, tags: JSON.parse(row.tags ?? "[]") as string[] } : null);
      }
      return cached.get(id)!;
    };
    for (const item of touched) {
      let row = get(item.id); const seen = new Set<string>();
      while (row && !excluded(row.tags)) {
        if (seen.has(row.qitemId) || seen.size >= 1000) throw new Error("health_passive_lineage_cycle_or_limit");
        seen.add(row.qitemId);
        if (!row.handedOffFrom) {
          roots.set(row.qitemId, row);
          if (!members.has(row.qitemId)) members.set(row.qitemId, new Set());
          members.get(row.qitemId)!.add(item.id);
          activity.set(row.qitemId, (activity.get(row.qitemId) ?? 0) + item.n);
          break;
        }
        row = get(row.handedOffFrom);
        if (!row) throw new Error("health_passive_lineage_parent_unavailable");
      }
    }
    // Past the limit, evaluate the busiest families instead of none. The ranking counts every
    // transition in the window, daemon bookkeeping included (then lineage ID, for a stable order).
    // That raw count bounds the counted transitions a family qualifies by, so a family that could
    // qualify is left out only when more than the limit reach the threshold on raw traffic.
    // The rest are reported as omitted: unevaluated, never healthy.
    const selectedFamilies = new Set([...roots.keys()]
      .sort((a, b) => activity.get(b)! - activity.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, familyLimit));
    this.lastCoverage = { source: "passive-ceremony", evaluatedAt: now, unit: "handoff families", limit: familyLimit,
      total: roots.size, evaluated: selectedFamilies.size, omitted: roots.size - selectedFamilies.size, partial: roots.size > familyLimit,
      order: "most queue transitions in the observation window, then lineage ID" };
    // An explicit legacy source already owns this lineage; never route it twice.
    const explicit = new Set(this.checkpoints?.entries().map((x) => x.checkpoint.lineageQitemId) ?? []);
    const observations: HealthDetectorObservation[] = [];
    const contexts = new Map<string, PassiveCeremony["context"]>();
    for (const [lineageId, root] of roots) {
      if (!root || explicit.has(lineageId) || !selectedFamilies.has(lineageId)) continue;
      // Discovery already covered every touched qitem in this exact window.
      // Its parent joins give the complete family without rescanning dormant work.
      const ids = [...members.get(lineageId)!];
      if (ids.length > 1000) throw new Error("health_passive_family_member_limit");
      const window: ReturnType<QueueRepository["listTransitions"]> = [];
      for (const id of ids) {
        window.push(...this.queue.transitionLog.listForQitemWindow(id, start, now, 10001 - window.length));
        if (window.length > 10000) throw new Error("health_passive_transition_window_truncated");
      }
      window.sort((a, b) => a.transitionId - b.transitionId);
      // Count, segment and report only what seats decided (#2762); the raw window still names the family.
      const transitions = window.filter(isCoordinationTransition);
      if (transitions.length < p.thresholds.ceremonyTransitions) continue;
      const rows = [...new Set(window.map((t) => t.qitemId))].map((id) => get(id)!);
      const tags = rows.flatMap((r) => r.tags ?? []);
      let missionId = one(tagged(tags, "mission:"));
      // Normal work linkage is explicit tags. Untagged work has no invented mission.
      const resolved = this.posture?.reader.resolve({ qitemId: lineageId });
      const selected = resolved?.context;
      let workspace = this.workspace, missionRoot: string | undefined;
      let scope: HealthScope;
      const slices = tagged(tags, "slice:");
      if (this.posture) {
        if (resolved?.posture !== "unknown" && selected?.paths) workspace = selected.paths.project;
        if (resolved?.posture !== "unknown" && selected?.projectId && selected.missionId && selected.paths) {
          workspace = selected.paths.project; missionRoot = selected.paths.mission; missionId = selected.missionId;
          const sliceId = selected.workstreamId?.split("/").at(-1);
          scope = sliceId ? { type: "slice", projectId: selected.projectId, missionId, sliceId }
            : { type: "mission", projectId: selected.projectId, missionId };
        } else scope = { type: "instance", instanceId: this.posture.instanceId };
      } else {
        if (!missionId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(missionId)) continue;
        const project = readHealthArtifact(workspace, "project.yaml", 65536, true);
        const projectId = project.content ? (parseYaml(project.content) as { metadata?: { id?: unknown } })?.metadata?.id : undefined;
        if (typeof projectId !== "string" || !projectId) continue;
        const sliceId = one(slices);
        scope = sliceId ? { type: "slice", projectId, missionId, sliceId } : { type: "mission", projectId, missionId };
      }
      const first = this.queue.db.prepare("SELECT ts FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id LIMIT 1").get(lineageId) as { ts: string } | undefined;
      if (!first) throw new Error("health_passive_episode_start_unavailable");
      const boundaries = this.closedBoundaries(lineageId);
      const cuts = boundaries.map((b) => b.transitionId);
      // Each closed segment keeps the end of the disposition that closed it: a disposition recorded
      // before #2762 may cut at a transition that no longer counts, so its id is not the segment's last.
      const segments: Array<{ segment: typeof transitions; endedAt?: string }> = [];
      let remaining = transitions;
      for (const boundary of boundaries) {
        const part = remaining.filter((t) => t.transitionId <= boundary.transitionId);
        if (part.length) segments.push({ segment: part, endedAt: boundary.endedAt });
        remaining = remaining.filter((t) => t.transitionId > boundary.transitionId);
      }
      if (remaining.length) segments.push({ segment: remaining });
      for (const { segment, endedAt } of segments) {
        if (segment.length < p.thresholds.ceremonyTransitions) continue;
        const segmentFirst = segment[0]!;
        const resumed = cuts.some((cut) => cut < segmentFirst.transitionId);
        const episodeStartedAt = resumed ? segmentFirst.ts : first.ts;
        const episodeKey = resumed ? `${lineageId}:${segmentFirst.transitionId}` : lineageId;
        const measuredEnd = endedAt ?? now;
        const scopeKey = healthHash({ scope, workspace });
        if (!contexts.has(scopeKey)) contexts.set(scopeKey, scope.type === "mission" || scope.type === "slice"
          ? this.context(scope, workspace, missionRoot)
          : selected?.paths && resolved?.posture !== "unknown"
            ? this.projectContext(workspace)
            : [{ path: this.workspace, state: "unavailable", role: "Scope identity unresolved; inspect operatingPosture.reason" }]);
        const context = contexts.get(scopeKey)!;
        const memberIds = [...new Set(segment.map((t) => t.qitemId))];
        const trails = this.queue.db.prepare(`SELECT trail_id, instance_id, step_id, prior_qitem_id, closure_reason, actor_session, closed_at, closure_evidence_json FROM workflow_step_trails WHERE prior_qitem_id IN (${memberIds.map(() => "?").join(",")}) AND closed_at >= ? AND closed_at <= ? ORDER BY trail_id LIMIT 201`)
          .all(...memberIds, episodeStartedAt > start ? episodeStartedAt : start, measuredEnd) as Array<{ trail_id: string; instance_id: string; step_id: string; prior_qitem_id: string; closure_reason: string; actor_session: string; closed_at: string; closure_evidence_json: string | null }>;
        if (trails.length > 200) throw new Error("health_passive_workflow_receipts_truncated");
        const workflowReceipts = trails.map((t) => ({ trailId: t.trail_id, instanceId: t.instance_id, stepId: t.step_id, qitemId: t.prior_qitem_id, closureReason: t.closure_reason, actor: t.actor_session, at: t.closed_at, evidence: t.closure_evidence_json ? JSON.parse(t.closure_evidence_json) as unknown : null }));
        const transitionIds = segment.map((t) => t.transitionId);
        const basis = healthHash({ lineageId, scope, transitions: segment.map(adaptQueueTransitionEvidence), context, workflowReceipts });
        const id = healthEpisodeId(detector, scope, episodeStartedAt, episodeKey);
        const receipt = this.assessment(id, workspace);
        const missingFacts: string[] = [];
        if (resolved?.posture === "unknown") missingFacts.push("scope identity unresolved: " + resolved.reason);
        if (Date.parse(episodeStartedAt) < Date.parse(start)) missingFacts.push("lineage begins before retained observation window; full interval unavailable");
        if (new Set(slices).size > 1) missingFacts.push("handoff family crosses slice identities; product boundary unresolved");
        if (receipt && receipt.result.basis !== basis) missingFacts.push("normal evidence changed since the attributed assessment; reassess the current basis");
        if (receipt?.evidenceChanged) missingFacts.push("assessment evidence changed or became unavailable");
        const assessment = receipt ? { result: receipt.result, actor: receipt.actor, at: receipt.at, transitionId: receipt.transitionId, identityProvenance: receipt.identityProvenance } : undefined;
        const ceremony: PassiveCeremony = { origin: "passive", stage: "needs-diagnosis", lineageId, basis, transitionIds, context, workflowReceipts, ...(assessment ? { assessment } : {}), missingFacts };
        const latest = [...segment.map((t) => t.ts), ...workflowReceipts.map((r) => r.at)].sort().at(-1)!;
        observations.push({ kind: "coordination-lineage", scope, episodeKey, episodeStartedAt,
          lastObservedAt: latest, lineageId, coordinationTransitions: segment.length,
          productStateChanges: null, boundedAuthority: false, reviewReturns: 0, candidateChanges: 0, newRiskClasses: 0, ceremony,
          sourceDescription: `Passively read ${rows.length} declared handoff members. Normal evidence paths and workflow closure receipts are starting points, not proof counts or acceptance judgments. This source performs no writes or agent calls.`,
          source: boundHealthEvidence(segment.map(adaptQueueTransitionEvidence), { source: "mixed", startedAt: start > episodeStartedAt ? start : episodeStartedAt, endedAt: measuredEnd, limit: 10000, retentionSeconds: p.observationWindowSeconds },
            deriveHealthSourceFreshness({ evaluatedAt: now, newestSourceAt: latest, maxAgeSeconds: p.freshnessSeconds, available: true })) });
      }
    }
    return observations;
  }

  private closedBoundaries(lineageId: string): Array<{ transitionId: number; endedAt: string }> {
    // One read per evaluation finds every lineage-tagged row: a tag lookup per family was a whole-queue scan each time.
    this.lineageRows ??= this.readLineageRows();
    const ids = this.lineageRows.get(`health-lineage:${lineageId}`) ?? [];
    if (ids.length > 200) throw new Error("health_passive_episode_history_truncated");
    return ids.flatMap((qitemId) => {
      const transitions = this.queue.listTransitions(qitemId);
      if (transitions.length > 1000) throw new Error("health_passive_diagnosis_history_truncated");
      for (const t of [...transitions].reverse()) {
        try {
          const r = JSON.parse(t.transitionNote ?? "null") as { kind?: string; action?: string; episodeCleared?: boolean; finding?: { ceremony?: PassiveCeremony; window: { endedAt: string } } } | null;
          if (r?.kind !== "health-diagnosis" || r.action !== "disposition") continue;
          const c = r.finding?.ceremony;
          return r.episodeCleared && c?.lineageId === lineageId ? [{ transitionId: Math.max(...c.transitionIds), endedAt: r.finding!.window.endedAt }] : [];
        } catch { /* Not a typed disposition. */ }
      }
      return [];
    }).sort((a, b) => a.transitionId - b.transitionId);
  }

  /** Every `health-lineage:<id>` tag's rows, exact tag match, ids only (all closedBoundaries uses). */
  private readLineageRows(): Map<string, string[]> {
    const rows = this.queue.db.prepare("SELECT qitem_id AS id, tags FROM queue_items WHERE tags LIKE '%health-lineage:%'")
      .all() as Array<{ id: string; tags: string | null }>;
    const index = new Map<string, string[]>();
    for (const row of rows) {
      let tags: unknown;
      try { tags = JSON.parse(row.tags ?? "[]"); } catch { continue; }
      if (!Array.isArray(tags)) continue;
      for (const tag of new Set(tags)) {
        if (typeof tag !== "string" || !tag.startsWith("health-lineage:")) continue;
        const ids = index.get(tag) ?? [];
        ids.push(row.id); index.set(tag, ids);
      }
    }
    return index;
  }

  private assessment(id: string, workspace = this.workspace): (NonNullable<PassiveCeremony["assessment"]> & { evidenceChanged: boolean }) | undefined {
    const qitemId = `qitem-health-diagnosis-${id}`;
    const row = this.queue.getById(qitemId);
    if (!row?.tags?.includes("health-diagnosis")) return undefined;
    const transitions = this.queue.listTransitions(qitemId);
    if (transitions.length > 1000) throw new Error("health_passive_diagnosis_history_truncated");
    for (const t of [...transitions].reverse()) {
      try {
        const r = JSON.parse(t.transitionNote ?? "null") as { kind?: string; action?: string; disposition?: { progress?: CeremonyProgressAssessment }; progressEvidence?: Array<{ path: string; sha256?: string }> } | null;
        if (r?.kind === "health-diagnosis" && r.action === "disposition" && r.disposition?.progress) {
          return { evidenceChanged: !r.progressEvidence?.length || r.progressEvidence.some((e) => readHealthArtifact(workspace, e.path).sha256 !== e.sha256), result: r.disposition.progress, actor: t.actorSession, at: t.ts, transitionId: t.transitionId, identityProvenance: t.identityProvenance };
        }
      } catch { /* Ordinary queue prose is not an assessment. */ }
    }
    return undefined;
  }

  private projectContext(workspace: string, missionRoot?: string): PassiveCeremony["context"] {
    return [
      ...["SPEC.md", "project.yaml"].map(path => ({ ...readHealthArtifact(workspace, join(workspace, path), 65536), role: "project authority / selected SDLC" })),
      ...healthSelectedContext(workspace, missionRoot).map(({ content: _content, ...ref }) => ({ ...ref, role: ref.role ?? "selected context" })),
    ];
  }

  private context(scope: Extract<HealthScope, { type: "mission" | "slice" }>, workspace = this.workspace, missionRoot = join(workspace, "missions", scope.missionId)): PassiveCeremony["context"] {
    const result = this.projectContext(workspace, missionRoot);
    const add = (path: string, role: string) => { const r = readHealthArtifact(workspace, join(workspace, path), 65536); result.push({ ...r, role }); };
    const missionDir = relative(workspace, missionRoot);
    ["SPEC.md", "mission.yaml", "PROGRESS.md"].forEach((name) => add(join(missionDir, name), "mission authority / selected SDLC / progress"));
    const manifestPath = join(missionDir, "mission.yaml");
    const manifest = readHealthArtifact(workspace, manifestPath, 65536, true);
    if (scope.type === "slice" && manifest.content) {
      const members = validateMissionComposition(parseYaml(manifest.content), join(workspace, manifestPath));
      if (members.length > 200) throw new Error("health_passive_scope_membership_limit");
      for (const member of members) {
        const dir = relative(realpathSync(workspace), dirname(member.path));
        const spec = readHealthArtifact(workspace, join(dir, "SPEC.md"), 65536, true);
        const fm = spec.content?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        if (!fm || (parseYaml(fm) as { id?: string })?.id !== scope.sliceId) continue;
        ["SPEC.md", "slice.yaml", "PROGRESS.md", "PROOF.md"].forEach((name) => add(join(dir, name), "slice authority / selected SDLC / progress / proof"));
        try {
          const proofs = readdirSync(join(workspace, dir, "proof"), { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".md"));
          if (proofs.length > 100) throw new Error("health_passive_proof_directory_limit");
          proofs.sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => add(join(dir, "proof", f.name), "proof artifact to inspect, not accepted-outcome count"));
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
    }
    return result;
  }
}
