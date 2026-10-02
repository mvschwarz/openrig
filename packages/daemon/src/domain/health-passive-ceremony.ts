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
import { adaptQueueTransitionEvidence, boundHealthEvidence, deriveHealthSourceFreshness, healthEpisodeId, type HealthScope, type PassiveCeremony, type CeremonyProgressAssessment } from "./health-projection.js";

const detector = "process.ceremony-amplification";
const familyLimit = 200;
const excluded = (tags: string[] | null | undefined) => tags?.some((t) => t === "health-diagnosis" || t === "health-human") ?? false;
const one = (values: string[]) => { const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : undefined; };
const tagged = (tags: string[], prefix: string) => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));

/** A read-only question generator. Proof files, closures and acceptance receipts
 * are material for the diagnosing agent, never an automatic outcome counter. */
export class PassiveCeremonySource implements HealthObservationSource {
  constructor(private readonly workspace: string, private readonly queue: QueueRepository, private readonly policy: HealthPolicyStore,
    private readonly now = () => new Date().toISOString(), private readonly checkpoints?: HealthCheckpointSource,
    private readonly posture?: { reader: OperatingPostureService; instanceId: string }) {}

  private lastCoverage: HealthSourceCoverage | undefined;
  coverage(): HealthSourceCoverage[] { return this.lastCoverage ? [this.lastCoverage] : []; }

  read(): HealthDetectorObservation[] {
    this.lastCoverage = undefined;
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
    // Past the limit, evaluate the busiest families instead of none. A family qualifies
    // by its transition count, so ranking by transitions in the window (then lineage ID,
    // for a stable order) keeps every family that could qualify unless more than the
    // limit do. The rest are reported as omitted: unevaluated, never healthy.
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
      const transitions: ReturnType<QueueRepository["listTransitions"]> = [];
      for (const id of ids) {
        transitions.push(...this.queue.transitionLog.listForQitemWindow(id, start, now, 10001 - transitions.length));
        if (transitions.length > 10000) throw new Error("health_passive_transition_window_truncated");
      }
      transitions.sort((a, b) => a.transitionId - b.transitionId);
      if (transitions.length < p.thresholds.ceremonyTransitions) continue;
      const rows = [...new Set(transitions.map((t) => t.qitemId))].map((id) => get(id)!);
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
      const segments: typeof transitions[] = [];
      let remaining = transitions;
      for (const cut of cuts) {
        const part = remaining.filter((t) => t.transitionId <= cut);
        if (part.length) segments.push(part);
        remaining = remaining.filter((t) => t.transitionId > cut);
      }
      if (remaining.length) segments.push(remaining);
      for (const segment of segments) {
        if (segment.length < p.thresholds.ceremonyTransitions) continue;
        const segmentFirst = segment[0]!;
        const resumed = cuts.some((cut) => cut < segmentFirst.transitionId);
        const episodeStartedAt = resumed ? segmentFirst.ts : first.ts;
        const episodeKey = resumed ? `${lineageId}:${segmentFirst.transitionId}` : lineageId;
        const measuredEnd = boundaries.find((b) => b.transitionId === segment.at(-1)!.transitionId)?.endedAt ?? now;
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
    const rows = this.queue.list({ tag: `health-lineage:${lineageId}`, limit: 201 });
    if (rows.length > 200) throw new Error("health_passive_episode_history_truncated");
    return rows.flatMap((row) => {
      const transitions = this.queue.listTransitions(row.qitemId);
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
