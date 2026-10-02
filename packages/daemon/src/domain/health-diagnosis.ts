import type { QueueItem, QueueRepository } from "./queue-repository.js";
import type { HealthProjectionService, HealthSourceCoverage } from "./health-detectors.js";
import { healthHash, object, type HealthPolicyStore } from "./health-policy.js";
import { HEALTH_RECORD_SCHEMA, type HealthRecord, type CeremonyProgressAssessment } from "./health-projection.js";

export const DIAGNOSIS_VERDICTS = ["false positive", "early real condition", "established pathology", "insufficient evidence", "resolved"] as const;
export interface HealthDisposition {
  verdict: typeof DIAGNOSIS_VERDICTS[number]; causalStart: string | null;
  steering: string; uncertainty: string; evidenceRefs: string[];
  progress?: CeremonyProgressAssessment;
  correction?: {
    applicability: string; causalJudgment: string;
    action: { state: "proposed" | "taken"; summary: string; evidenceRefs: string[] };
    effect: { state: "unobserved" | "observed"; summary: string; evidenceRefs: string[] };
  };
}
export interface AuthorityReference { level?: "project" | "mission" | "slice"; path: string; state: "available" | "unavailable"; sha256?: string; content?: string; role?: string; selectedBy?: string; reason?: string; }
interface Packet { schema: "openrig.health-diagnosis/v0alpha1"; finding: HealthRecord; policyVersion: string; authority: AuthorityReference[]; presentedAt: string; instructions: string; }
interface Receipt { kind: "health-diagnosis"; at: string; action: "presented" | "observed" | "disposition" | "notification-readiness"; finding?: HealthRecord; disposition?: HealthDisposition; authority?: AuthorityReference[]; episodeCleared?: boolean; progressEvidence?: AuthorityReference[]; correctionEvidence?: AuthorityReference[]; actor?: string; transitionId?: number; notificationReadiness?: { ready: boolean; reason: string }; }
interface DiagnosisAction { qitemId: string; findingId: string; action: "create" | "represent" | "observe" | "retained" | "deferred" | "notify" | "notification-deferred"; reason?: string; operatingPosture?: HealthRecord["operatingPosture"]; }
const instructions = "This packet is a shortcut, not the whole story. Start with the exact evidence and current project/mission/slice authority below; read those sources again before acting. You may extend the investigation. The deterministic signal is not a psychological or epistemic diagnosis. Self-scout is supported: trace the earliest causal point, examine your own contribution, distinguish another seat or stale control-plane source, and request a second agent only when useful. Record one bounded disposition with causal start (or unknown), smallest corrective steering, evidence and remaining uncertainty. Advice is not authorization to cancel work, change scope/rigor/ownership/lifecycle, restart agents, or relax safety. Human escalation requires explicit policy and verified delivery readiness.";
const correctionGuidance = "Inspect current selected context and its provenance, including project planning before any successor mission exists. An authorized restriction can still have a disproved premise or be disproportionate; uncertainty about a complete workflow outcome census does not justify retaining that restriction. Apply current corrections within their authority and preserve unrelated valid boundaries, including publication. Normal interactive planning is not itself pathology. Separate automatic wake/receipt bookkeeping from useful owner work; assess the relevance and interruption cost of investigating. Use one bounded correction when useful, not a recurring self-audit or universal reviewer. In an optional correction, record applicability and attributed causalJudgment separately from action {state: proposed|taken, summary, evidenceRefs} and later effect {state: unobserved|observed, summary, evidenceRefs}. A disposition, queue closure, prompt edit or numerical clearance is not observed behavioral improvement. If no later natural opportunity occurs, leave effect unobserved; retained-case replay proves mechanics only. Never infer another seat's context or re-enable live diagnosis from this advice.";

export class HealthDiagnosisService {
  private pending: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastEvaluation: { at: string; error: string | null; coverage: HealthSourceCoverage[] | null } | null = null;
  status() { return { scheduled: this.timer !== undefined, lastEvaluation: this.lastEvaluation }; }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.evaluate("system:health", true).then((result) => { this.lastEvaluation = { at: this.now(), error: null, coverage: result.coverage }; }, (error: unknown) => { this.lastEvaluation = { at: this.now(), error: String(error), coverage: null }; });
    }, 60000);
    this.timer.unref();
  }
  async stop(): Promise<void> { clearInterval(this.timer); this.timer = undefined; await this.pending; }
  constructor(private readonly deps: {
    queue: QueueRepository; projection: HealthProjectionService; policy: HealthPolicyStore;
    now?: () => string; authority: (record: HealthRecord) => AuthorityReference[];
    resolveEvidence?: (path: string, finding: HealthRecord) => AuthorityReference;
    humanReadiness?: (address: string) => Promise<{ ready: boolean; reason: string }>;
  }) {}
  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }
  private id(findingId: string): string { return `qitem-health-diagnosis-${findingId}`; }
  private owns(row: QueueItem): boolean {
    // The tag is also used topically; only our existing ID namespace denotes occurrences.
    return row.qitemId.startsWith(this.id("")) && row.tags?.includes("health-diagnosis") === true;
  }
  private missingCurrent(finding: HealthRecord): HealthRecord {
    if (finding.category !== "process") return finding;
    return { ...finding, operatingPosture: { posture: "unknown", source: "unknown", context: null, binding: null,
      reason: "Current finding unavailable; retained posture cannot admit a new interruption.", grantsAuthority: false } };
  }
  private receipt(qitemId: string, actor: string, value: Omit<Receipt, "kind" | "at">, identityProvenance: string | null = null): void {
    this.deps.queue.update({ qitemId, actorSession: actor, identityProvenance, transitionNote: JSON.stringify({ kind: "health-diagnosis", at: this.now(), ...value }) });
  }
  show(qitemId: string, refresh = true) {
    const row = this.deps.queue.getById(qitemId);
    if (!row || !this.owns(row)) throw new Error("health_diagnosis_not_found");
    const invalid = () => new Error(`health_diagnosis_invalid_packet: ${qitemId}`);
    let packet: Packet;
    try { packet = JSON.parse(row.body) as Packet; } catch { throw invalid(); }
    if (packet?.schema !== "openrig.health-diagnosis/v0alpha1" || packet.finding?.schema !== HEALTH_RECORD_SCHEMA
      || typeof packet.finding.id !== "string" || qitemId !== this.id(packet.finding.id)
      || typeof packet.policyVersion !== "string" || !packet.policyVersion || !Array.isArray(packet.authority)
      || typeof packet.instructions !== "string" || !packet.instructions
      || typeof packet.presentedAt !== "string" || !Number.isFinite(Date.parse(packet.presentedAt))) throw invalid();
    const human = this.deps.queue.getById(`qitem-health-human-${packet.finding.id}`);
    const receipts: Receipt[] = this.deps.queue.listTransitions(qitemId).flatMap((t) => {
      try { const value = JSON.parse(t.transitionNote ?? "null") as Receipt | null; return value?.kind === "health-diagnosis" ? [{ ...value, actor: t.actorSession, transitionId: t.transitionId }] : []; } catch { return []; }
    });
    const finding = refresh && (packet.finding.ceremony || packet.finding.category === "process")
      ? this.deps.projection.get(packet.finding.id) ?? this.missingCurrent(receipts.filter((r) => r.finding).at(-1)?.finding ?? packet.finding)
      : receipts.filter((r) => r.finding).at(-1)?.finding ?? packet.finding;
    const last = receipts.filter((r) => r.disposition).at(-1);
    return { row, packet, receipts, notificationReadiness: receipts.filter((r) => r.notificationReadiness).at(-1)?.notificationReadiness ?? null, humanDelivery: human ? { qitemId: human.qitemId, outcome: human.deliveryOutcome ?? "pending" } : null,
      finding, authority: refresh ? this.deps.authority(finding) : receipts.filter((r) => r.authority).at(-1)?.authority ?? packet.authority,
      authorityReadAt: refresh ? this.now() : null, guidance: correctionGuidance,
      disposition: last?.disposition ?? null,
      assessment: last ? { actor: last.actor, at: last.at, transitionId: last.transitionId } : null,
      correctionEvidence: last?.correctionEvidence ?? [],
      behavioralEffect: last?.disposition?.correction?.effect.state ?? "unobserved" };
  }
  list(refresh = true) {
    // Refuse a truncated ownership census rather than treating a hidden occurrence as absent.
    const rows = this.deps.queue.list({ tag: "health-diagnosis", limit: 10000 });
    if (rows.length === 10000) throw new Error("health_diagnosis_census_truncated");
    const occurrences = rows.filter((r) => this.owns(r)).map((r) => this.show(r.qitemId, false));
    if (!refresh) return occurrences;
    const current = new Map(this.deps.projection.records().map((finding) => [finding.id, finding]));
    return occurrences.map((o) => {
      const finding = current.get(o.finding.id) ?? this.missingCurrent(o.finding);
      return { ...o, finding, authority: this.deps.authority(finding), authorityReadAt: this.now() };
    });
  }
  evaluate(actor: string, apply: boolean): Promise<{ policyVersion: string; enabled: boolean; actions: DiagnosisAction[]; coverage: HealthSourceCoverage[] | null }> {
    const work = this.pending.then(() => this.evaluateOnce(actor, apply));
    this.pending = work.catch(() => undefined);
    return work;
  }
  private async evaluateOnce(actor: string, apply: boolean) {
    const effective = this.deps.policy.read();
    const policy = effective.policy.diagnosis;
    const actions: DiagnosisAction[] = [];
    // Nothing was read, so this evaluation has no coverage of its own to report.
    if (!policy.enabled || !policy.owner) return { policyVersion: effective.version, enabled: false, actions, coverage: null };
    const now = Date.parse(this.now());
    const occurrences = this.list(false);
    let latestOwnerPresentation = Math.max(0, ...occurrences.filter((x) => x.row.destinationSession === policy.owner).flatMap((x) => [Date.parse(x.packet.presentedAt), ...x.receipts.filter((r) => r.action === "presented").map((r) => Date.parse(r.at))]));
    const records = this.deps.projection.records().sort((a, b) => Number(b.detector === "process.ceremony-amplification") - Number(a.detector === "process.ceremony-amplification") || a.id.localeCompare(b.id));
    // Snapshot this read's coverage now: another health read during a delivery await below replaces the source's latest.
    const coverage = this.deps.projection.coverage();
    for (const finding of records) {
      const qitemId = this.id(finding.id);
      const old = occurrences.find((o) => o.row.qitemId === qitemId);
      const base = { qitemId, findingId: finding.id };
      const suspected = finding.ceremony?.stage === "needs-diagnosis" && finding.freshness.state === "fresh";
      if (old && finding.status !== "active" && !suspected) {
        if (old.finding.status !== finding.status) {
          actions.push({ ...base, action: "observe" });
          if (apply) this.receipt(qitemId, actor, { action: "observed", finding });
        }
        continue;
      }
      if ((finding.status !== "active" && !suspected) || !policy.detectors.includes(finding.detector)) continue;
      // A process preference affects presentation, never operational health or workflow reminders.
      if (finding.category === "process" && finding.operatingPosture?.posture !== "delegated") {
        actions.push({ ...base, action: "deferred", operatingPosture: finding.operatingPosture,
          reason: finding.operatingPosture?.posture === "human-led"
            ? "Human-led scope: process-only interruptions are quiet; the finding remains inspectable."
            : "Operating posture unknown: no delegated process interruption is inferred." });
        continue;
      }
      const age = now - Date.parse(finding.lastObservedAt ?? "");
      if (!Number.isFinite(age) || age < 0 || age > effective.policy.freshnessSeconds * 1000) {
        actions.push({ ...base, action: "deferred", reason: "source is stale or contradictory" }); continue;
      }
      if (old && finding.ceremony?.stage === "confirmed" && old.row.destinationSession === policy.owner
        && effective.policy.human.address && effective.policy.human.conditions.includes("confirmed ceremony")
        && !this.deps.queue.getById(`qitem-health-human-${finding.id}`)) {
        if (!apply) actions.push({ ...base, action: "notify" });
        else {
          try { await this.notifyOccurrence(qitemId, actor, null, true); actions.push({ ...base, action: "notify" }); }
          catch (error) { actions.push({ ...base, action: "notification-deferred", reason: String(error) }); }
        }
      }
      if (old && (old.disposition || old.row.destinationSession !== policy.owner || !["pending", "in-progress"].includes(old.row.state)
        || old.receipts.filter((r) => r.action === "presented").length >= policy.maxRepresentations)) {
        actions.push({ ...base, action: "retained", reason: "existing disposition, custody, or recurrence bound" }); continue;
      }
      if (now - latestOwnerPresentation < policy.cooldownSeconds * 1000) {
        actions.push({ ...base, action: "deferred", reason: "owner cooldown" }); continue;
      }
      actions.push({ ...base, action: old ? "represent" : "create" });
      latestOwnerPresentation = now;
      if (!apply) continue;
      if (old) {
        // Reserve before awaiting transport: restart or another evaluation cannot re-send blindly.
        this.receipt(qitemId, actor, { action: "presented", finding, authority: this.deps.authority(finding) });
        await this.deps.queue.maybeNudge(qitemId, old.row.destinationSession, true, actor);
      } else {
        const packet: Packet = { schema: "openrig.health-diagnosis/v0alpha1", finding, policyVersion: effective.version,
          authority: this.deps.authority(finding), presentedAt: this.now(), instructions: `${instructions} ${correctionGuidance}${finding.ceremony ? " This is provisional suspicion, not a confirmed warning. Resolve product progress from normal scope/proof/workflow evidence and the selected SDLC boundary; do not count approvals, C1 pairing, proof files, commits, tests or generic closures as outcomes. In the existing disposition, optionally include progress: {basis, conclusion: established|false-positive|indeterminate, outcomes: [{id, observedAt, evidenceRefs}], boundedAuthority: boolean|null, boundary, evidenceRefs, missingFacts}. Bind basis to the CURRENT finding.ceremony.basis from diagnosis show; establish a complete outcome census for the exact transition window or return indeterminate with the missing fact. This census assesses that window, not whether a specific challenged rule remains useful; it is not a prerequisite to recording a correction. Outcome and bounded-authority semantics are your attributed judgment. An empty outcomes list means you affirm no outcomes, never that you could not find them. No separate checkpoint is needed." : ""} Read current context and disposition with rig health diagnosis show ${qitemId} --full --json (complete retained evidence; may be large).` };
        await this.deps.queue.create({ qitemId, sourceSession: actor, destinationSession: policy.owner, body: JSON.stringify(packet, null, 2),
          tags: ["health-diagnosis", finding.id, `policy:${effective.version}`, ...(finding.ceremony ? [`health-lineage:${finding.ceremony.lineageId}`] : [])], summary: `System Health: inspect ${finding.detector}`, evidenceRef: finding.id });
      }
    }
    return { policyVersion: effective.version, enabled: true, actions, coverage };
  }
  private requireOwner(qitemId: string, actor: string) {
    const diagnosis = this.show(qitemId);
    if (diagnosis.row.destinationSession !== actor) throw new Error("health_diagnosis_owner_required");
    return diagnosis;
  }
  dispose(qitemId: string, actor: string, value: unknown, identityProvenance: string | null = null) {
    const diagnosis = this.requireOwner(qitemId, actor);
    const d = object(value, ["verdict", "causalStart", "steering", "uncertainty", "evidenceRefs", ...["progress", "correction"].filter(k => Object.hasOwn(value ?? {}, k))]);
    if (!DIAGNOSIS_VERDICTS.includes(d.verdict as HealthDisposition["verdict"]) || (d.causalStart !== null && typeof d.causalStart !== "string")
      || typeof d.steering !== "string" || !d.steering.trim() || typeof d.uncertainty !== "string" || !d.uncertainty.trim()
      || !Array.isArray(d.evidenceRefs) || !d.evidenceRefs.length || d.evidenceRefs.some((r) => typeof r !== "string" || !r.trim())) throw new Error("Invalid or incomplete health disposition");
    if (healthHash(this.show(qitemId).disposition) === healthHash(d)) return this.show(qitemId);
    const progressEvidence = d.progress === undefined ? undefined : this.validateProgress(d.progress, diagnosis.finding);
    const correctionEvidence = d.correction === undefined ? undefined : this.validateCorrection(d.correction, diagnosis.finding);
    const progress = d.progress as CeremonyProgressAssessment | undefined;
    const episodeCleared = progress && progress.missingFacts.length === 0 && (progress.conclusion === "false-positive" || (progress.conclusion === "established"
      && (progress.boundedAuthority === true || diagnosis.finding.ceremony!.transitionIds.length / Math.max(progress.outcomes.length, 1) < this.deps.policy.read().policy.thresholds.ceremonyRatio)));
    if (progress?.conclusion === "established" && !episodeCleared && ["false positive", "insufficient evidence", "resolved"].includes(String(d.verdict))) throw new Error("health_progress_contradicts_disposition");
    this.receipt(qitemId, actor, { action: "disposition", disposition: d as unknown as HealthDisposition,
      ...(correctionEvidence ? { correctionEvidence } : {}),
      ...(progressEvidence ? { progressEvidence, finding: diagnosis.finding, episodeCleared } : {}) }, identityProvenance);
    return this.show(qitemId);
  }
  private validateCorrection(value: unknown, finding: HealthRecord): AuthorityReference[] {
    const c = object(value, ["applicability", "causalJudgment", "action", "effect"]);
    const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 4096;
    if (!text(c.applicability) || !text(c.causalJudgment)) throw Error("Correction needs applicability and attributed causal judgment");
    const refs: string[] = [];
    for (const [key, states, evidenced] of [["action", ["proposed", "taken"], "taken"], ["effect", ["unobserved", "observed"], "observed"]] as const) {
      const claim = object(c[key], ["state", "summary", "evidenceRefs"]);
      if (!(states as readonly unknown[]).includes(claim.state) || !text(claim.summary) || !Array.isArray(claim.evidenceRefs)
        || claim.evidenceRefs.length > 32 || !claim.evidenceRefs.every(text)
        || (claim.state === evidenced && !claim.evidenceRefs.length)) throw Error("Invalid correction " + key + "; taken/observed claims require evidence");
      refs.push(...claim.evidenceRefs as string[]);
    }
    const evidence = [...new Set(refs)].map(path => this.deps.resolveEvidence?.(path, finding) ?? { path, state: "unavailable" as const });
    if (evidence.some(e => e.state !== "available")) throw Error("health_correction_evidence_unavailable");
    // Evidence existence and attribution are checkable; causal truth remains the owner's judgment.
    return evidence;
  }
  private validateProgress(value: unknown, finding: HealthRecord): AuthorityReference[] {
    const p = object(value, ["basis", "conclusion", "outcomes", "boundedAuthority", "boundary", "evidenceRefs", "missingFacts"]);
    const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4096;
    const refs = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(text);
    if (!finding.ceremony || p.basis !== finding.ceremony.basis) throw new Error("health_progress_basis_changed_or_unavailable");
    if (!["established", "false-positive", "indeterminate"].includes(String(p.conclusion)) || !text(p.boundary)
      || !refs(p.evidenceRefs) || !p.evidenceRefs.length || !refs(p.missingFacts)
      || (p.boundedAuthority !== null && typeof p.boundedAuthority !== "boolean")
      || !Array.isArray(p.outcomes) || p.outcomes.length > 100) throw new Error("Invalid progress assessment");
    if (p.conclusion === "established" && (p.boundedAuthority === null || p.missingFacts.length)) throw new Error("Established progress requires a known boundary and no missing facts");
    if (p.conclusion === "indeterminate" && !p.missingFacts.length) throw new Error("Indeterminate progress must name the missing fact");
    if (p.conclusion !== "established" && p.outcomes.length) throw new Error("Only established progress can supply outcomes");
    const evidenceRefs = [...p.evidenceRefs]; const ids = new Set();
    for (const raw of p.outcomes) {
      const o = object(raw, ["id", "observedAt", "evidenceRefs"]);
      const at = Date.parse(String(o.observedAt));
      if (!text(o.id) || ids.has(o.id) || !Number.isFinite(at) || at < Date.parse(finding.window.startedAt)
        || at > Date.parse(finding.window.endedAt) || !refs(o.evidenceRefs) || !o.evidenceRefs.length) throw new Error("Outcome must be unique, evidenced, and inside the assessed transition window");
      ids.add(o.id); evidenceRefs.push(...o.evidenceRefs);
    }
    const evidence = [...new Set(evidenceRefs)].map((path) => this.deps.resolveEvidence?.(path, finding) ?? { path, state: "unavailable" as const });
    if (evidence.some((e) => e.state !== "available")) throw new Error("health_progress_evidence_unavailable");
    return evidence;
  }
  async notify(qitemId: string, actor: string, identityProvenance: string | null = null) {
    return this.notifyOccurrence(qitemId, actor, identityProvenance, false);
  }
  private async notifyOccurrence(qitemId: string, actor: string, identityProvenance: string | null, automatic: boolean) {
    const diagnosis = automatic ? this.show(qitemId) : this.requireOwner(qitemId, actor);
    if (diagnosis.finding.category === "process" && diagnosis.finding.operatingPosture?.posture !== "delegated") throw new Error("health_process_posture_does_not_admit");
    if (automatic && diagnosis.row.destinationSession !== this.deps.policy.read().policy.diagnosis.owner) throw new Error("health_diagnosis_owner_required");
    if (diagnosis.finding.ceremony && (diagnosis.finding.status !== "active" || diagnosis.finding.ceremony.stage !== "confirmed")) throw new Error("health_human_requires_confirmed_active_episode");
    const { human } = this.deps.policy.read().policy;
    const allowed = (human.conditions.includes("critical") && diagnosis.finding.severity === "critical" && diagnosis.finding.status === "active")
      || (human.conditions.includes("established pathology") && diagnosis.disposition?.verdict === "established pathology")
      || (human.conditions.includes("confirmed ceremony") && diagnosis.finding.status === "active" && diagnosis.finding.ceremony?.stage === "confirmed");
    if (!human.address || !allowed) throw new Error("health_human_policy_does_not_admit");
    const id = `qitem-health-human-${diagnosis.packet.finding.id}`;
    const existing = this.deps.queue.getById(id);
    if (existing) return { qitemId: existing.qitemId, deliveryOutcome: existing.deliveryOutcome ?? "pending", nextInspection: `rig queue transitions ${id}` };
    const ready = await this.deps.humanReadiness?.(human.address) ?? { ready: false, reason: "no verified delivery readiness" };
    if (healthHash(diagnosis.notificationReadiness) !== healthHash(ready)) this.receipt(qitemId, actor, { action: "notification-readiness", notificationReadiness: ready }, identityProvenance);
    if (!ready?.ready) throw new Error(`health_human_readiness_unavailable: ${ready?.reason ?? "no verified delivery readiness"}`);
    // Recheck the live finding and custody after readiness I/O; no stale confirmation may post.
    const current = automatic ? this.show(qitemId) : this.requireOwner(qitemId, actor);
    if (current.finding.category === "process" && current.finding.operatingPosture?.posture !== "delegated") throw new Error("health_process_posture_changed_or_unknown");
    if (automatic && current.row.destinationSession !== this.deps.policy.read().policy.diagnosis.owner) throw new Error("health_diagnosis_owner_required");
    if (current.finding.ceremony && (current.finding.status !== "active" || current.finding.ceremony.stage !== "confirmed")) throw new Error("health_human_requires_confirmed_active_episode");
    if (healthHash(this.deps.policy.read().policy.human) !== healthHash(human)) throw new Error("health_human_policy_changed");
    const row = this.deps.queue.getById(id) ?? await this.deps.queue.create({ qitemId: id, sourceSession: actor, destinationSession: human.address, identityProvenance,
      body: JSON.stringify({ diagnosis: qitemId, finding: diagnosis.finding, disposition: diagnosis.disposition }, null, 2),
      summary: `System Health: ${diagnosis.finding.summary}`, evidenceRef: qitemId, tags: ["health-human", diagnosis.finding.id] });
    return { qitemId: row.qitemId, deliveryOutcome: row.deliveryOutcome ?? "pending", nextInspection: `rig queue transitions ${row.qitemId}` };
  }
}
