import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readHealthArtifact } from "./health-context.js";
import type { QueueRepository } from "./queue-repository.js";
import { healthHash, object, type HealthPolicyStore } from "./health-policy.js";
import { adaptQueueTransitionEvidence, adaptLifecycleReceiptEvidence, boundHealthEvidence, deriveHealthSourceFreshness, type HealthScope } from "./health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource } from "./health-detectors.js";

/** Authored outcome-boundary census, not a per-edit event feed. Queue references
 * are verified locally; product/authority meaning remains attributed testimony. */
export interface HealthCheckpoint {
  schema: "openrig.health-checkpoint/v0alpha1";
  lineageQitemId: string;
  includeHandoffs?: boolean;
  scope: HealthScope;
  startedAt: string;
  observedAt: string;
  transitionIds: number[];
  productOutcomes: Array<{ id: string; observedAt: string; evidenceRef: string }>;
  productCensusRef: string;
  boundedAuthority: { applies: boolean | null; evidenceRef: string };
  sdlc?: { expectation: string; evidenceRef: string };
  authorityPaths: { project: string[]; mission: string[]; slice: string[] };
}
interface StoredCheckpoint { actor: string; checkpoint: HealthCheckpoint; episodeStartedAt: string; active: boolean; qualifying: HealthCheckpoint | null; }
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("Expected a nonempty bounded string"); }
function timestamp(value: unknown): number { text(value); const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error("Invalid checkpoint timestamp"); return time; }
function scope(value: unknown): asserts value is HealthScope {
  const type = (value as HealthScope)?.type;
  const fields = { instance: ["instanceId"], rig: ["rigId"], seat: ["rigId", "seatId"], mission: ["projectId", "missionId"], slice: ["projectId", "missionId", "sliceId"] }[type];
  if (!fields) throw new Error("Unknown health scope");
  const s = object(value, ["type", ...fields]); fields.forEach((f) => text(s[f]));
}
export class HealthCheckpointSource implements HealthObservationSource {
  readonly name = "health-checkpoints";
  readonly detectors = ["process.ceremony-amplification"];
  private readonly dir: string;
  constructor(home: string, private readonly queue: QueueRepository, private readonly policy: HealthPolicyStore, private readonly now = () => new Date().toISOString(), private readonly workspace = join(home, "workspace")) {
    this.dir = join(home, "health", "checkpoints");
  }
  private validate(value: unknown, allowDerive = false): HealthCheckpoint {
    const c = object(value, ["schema", "lineageQitemId", "scope", "startedAt", "observedAt", "transitionIds", "productOutcomes", "productCensusRef", "boundedAuthority", "authorityPaths", ...["includeHandoffs", "sdlc"].filter((key) => Object.hasOwn(value ?? {}, key))]);
    if (c.schema !== "openrig.health-checkpoint/v0alpha1") throw new Error("Unsupported checkpoint schema");
    text(c.lineageQitemId); text(c.productCensusRef); scope(c.scope);
    const start = timestamp(c.startedAt); const end = timestamp(c.observedAt);
    if (end < start || end > Date.parse(this.now())) throw new Error("Checkpoint window is reversed or future");
    // Resolve once on explicit submission, then retain exact IDs in the audit.
    // Reads and stored checkpoints never silently acquire later traffic.
    if (allowDerive && c.transitionIds === "derive") c.transitionIds = this.transitions(c as unknown as HealthCheckpoint).map((t) => t.transitionId);
    if (!Array.isArray(c.transitionIds) || c.transitionIds.length > 10000 || c.transitionIds.some((x) => !Number.isInteger(x) || x < 1) || new Set(c.transitionIds).size !== c.transitionIds.length) throw new Error("Invalid, duplicate, or excessive transition IDs");
    if (!Array.isArray(c.productOutcomes) || c.productOutcomes.length > 1000) throw new Error("Invalid product outcomes");
    const ids = new Set();
    for (const outcome of c.productOutcomes) {
      const o = object(outcome, ["id", "observedAt", "evidenceRef"]); text(o.id); text(o.evidenceRef);
      const at = timestamp(o.observedAt); if (at < start || at > end || ids.has(o.id)) throw new Error("Product outcome is duplicate or outside the lineage window"); ids.add(o.id);
    }
    const authority = object(c.boundedAuthority, ["applies", "evidenceRef"]); text(authority.evidenceRef);
    if (authority.applies !== null && typeof authority.applies !== "boolean") throw new Error("Authority must be true, false or unknown");
    if (c.includeHandoffs !== undefined && typeof c.includeHandoffs !== "boolean") throw new Error("includeHandoffs must be boolean");
    if (c.sdlc !== undefined) {
      const sdlc = object(c.sdlc, ["expectation", "evidenceRef"]); text(sdlc.expectation); text(sdlc.evidenceRef);
    }
    const paths = object(c.authorityPaths, ["project", "mission", "slice"]);
    for (const list of Object.values(paths)) {
      if (!Array.isArray(list) || list.length > 10) throw new Error("Invalid authority path list"); list.forEach(text);
    }
    const row = this.queue.getById(c.lineageQitemId);
    if (!row || row.tags?.some((t) => t === "health-diagnosis" || t === "health-human")) throw new Error("Checkpoint must name existing product work, not health traffic");
    const transitions = this.transitions(value as HealthCheckpoint);
    const members = [...new Set(transitions.map((t) => t.qitemId))].map((id) => this.queue.getById(id)!);
    if (members.some((member) => member.tags?.some((tag) => tag === "health-diagnosis" || tag === "health-human"))) throw new Error("Checkpoint excludes health traffic");
    if (c.includeHandoffs) {
      const expected = c.scope.type === "slice" ? { "mission:": c.scope.missionId, "slice:": c.scope.sliceId }
        : c.scope.type === "mission" ? { "mission:": c.scope.missionId } : {};
      if (members.some((member) => member.tags?.some((tag) => Object.entries(expected).some(([prefix, id]) => tag.startsWith(prefix) && tag !== `${prefix}${id}`)))) throw new Error("Handoff lineage crosses the declared checkpoint scope");
    }
    const actual = new Set(transitions.map((t) => t.transitionId));
    if (actual.size !== c.transitionIds.length || c.transitionIds.some((id) => !actual.has(id))) throw new Error("Checkpoint transition census does not match this exact lineage/window");
    return structuredClone(c as unknown as HealthCheckpoint);
  }
  private transitions(c: HealthCheckpoint) {
    const log = this.queue.transitionLog;
    return c.includeHandoffs ? log.listForHandoffWindow(c.lineageQitemId, c.startedAt, c.observedAt, 10001)
      : log.listForQitemWindow(c.lineageQitemId, c.startedAt, c.observedAt, 10001);
  }
  private file(lineage: string): string { return join(this.dir, `${healthHash(lineage)}.json`); }
  submit(value: unknown, actor: string) {
    const checkpoint = this.validate(structuredClone(value), true);
    text(actor);
    const file = this.file(checkpoint.lineageQitemId);
    if (!existsSync(file) && existsSync(this.dir) && readdirSync(this.dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length >= 200) throw new Error("health_checkpoint_source_limit");
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as StoredCheckpoint : null;
    if (previous && healthHash(previous.checkpoint) === healthHash(checkpoint)) return previous;
    if (previous && Date.parse(checkpoint.observedAt) <= Date.parse(previous.checkpoint.observedAt)) throw new Error("Checkpoint must advance observation time");
    const p = this.policy.read().policy.thresholds;
    const active = checkpoint.boundedAuthority.applies !== true && checkpoint.transitionIds.length >= p.ceremonyTransitions
      && checkpoint.transitionIds.length / Math.max(checkpoint.productOutcomes.length, 1) >= p.ceremonyRatio;
    const stored: StoredCheckpoint = { actor, checkpoint, active,
      episodeStartedAt: previous?.active ? previous.episodeStartedAt : checkpoint.startedAt,
      qualifying: active ? checkpoint : previous?.active ? previous.qualifying : null };
    // Recurrence starts at the first new qualifying checkpoint, not the previous episode's window.
    if (active && previous && !previous.active) stored.episodeStartedAt = checkpoint.observedAt;
    if (Buffer.byteLength(JSON.stringify(stored)) > 1048576) throw new Error("health_checkpoint_too_large");
    mkdirSync(join(this.dir, "history"), { recursive: true });
    const id = randomUUID();
    writeFileSync(join(this.dir, "history", `${id}.json`), JSON.stringify({ previous, current: stored }, null, 2), { flag: "wx" });
    const tmp = join(this.dir, `${id}.tmp`); writeFileSync(tmp, JSON.stringify(stored, null, 2)); renameSync(tmp, file);
    return stored;
  }
  entries(): StoredCheckpoint[] {
    if (!existsSync(this.dir)) return [];
    const names = readdirSync(this.dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 200) throw new Error("health_checkpoint_source_limit");
    return names.map((name) => {
      const bytes = readFileSync(join(this.dir, name), "utf8");
      if (Buffer.byteLength(bytes) > 1048576) throw new Error("health_checkpoint_too_large");
      const stored = JSON.parse(bytes) as StoredCheckpoint;
      this.validate(stored.checkpoint);
      text(stored.actor); timestamp(stored.episodeStartedAt);
      if (stored.qualifying) this.validate(stored.qualifying);
      return stored;
    });
  }
  read(): HealthDetectorObservation[] {
    const policy = this.policy.read().policy; const now = this.now();
    return this.entries().flatMap((stored) => {
      const current = stored.checkpoint;
      const thresholds = policy.thresholds;
      const active = current.boundedAuthority.applies !== true && current.transitionIds.length >= thresholds.ceremonyTransitions
        && current.transitionIds.length / Math.max(current.productOutcomes.length, 1) >= thresholds.ceremonyRatio;
      // A missing counter-signal is unknown, even when the authored value would
      // suppress the rule. Keep a potential observation until refs are resolved.
      const c = active ? current : stored.qualifying ?? (current.transitionIds.length >= thresholds.ceremonyTransitions ? current : null);
      if (!c) return [];
      const ids = new Set(c.transitionIds);
      const transitions = this.transitions(c).filter((t) => ids.has(t.transitionId));
      const evidence = transitions.map(adaptQueueTransitionEvidence);
      const refs = [...c.productOutcomes.map((p) => ({ id: p.evidenceRef, at: p.observedAt, outcome: p.id })),
        { id: current.productCensusRef, at: current.observedAt, outcome: `product census by ${stored.actor}: ${current.productOutcomes.length} outcomes` },
        { id: current.boundedAuthority.evidenceRef, at: current.observedAt, outcome: `bounded authority: ${String(current.boundedAuthority.applies)}` },
        ...(current.sdlc ? [{ id: current.sdlc.evidenceRef, at: current.observedAt, outcome: `selected SDLC expectation: ${current.sdlc.expectation}` }] : [])];
      const resolved = new Map([...new Set([...c.productOutcomes, ...current.productOutcomes].map((p) => p.evidenceRef)
        .concat(c.productCensusRef, c.boundedAuthority.evidenceRef, current.productCensusRef, current.boundedAuthority.evidenceRef, current.sdlc?.evidenceRef ?? ""))]
        .map((ref) => [ref, readHealthArtifact(this.workspace, ref)]));
      const missing = [...resolved].filter(([, result]) => result.state !== "available").map(([ref]) => ref);
      const outcomeCount = resolved.get(c.productCensusRef)?.state === "available"
        && c.productOutcomes.every((p) => resolved.get(p.evidenceRef)?.state === "available") ? c.productOutcomes.length : null;
      const receipts = refs.flatMap((r, i) => {
        const result = resolved.get(r.id)!;
        return result.state === "available" ? [adaptLifecycleReceiptEvidence({ receiptId: r.id, operation: "health-outcome-checkpoint", outcome: `${r.outcome}; sha256:${result.sha256}`, observedAt: r.at, sourceOrder: evidence.length + i })] : [];
      });
      const available = transitions.length === ids.size && current.boundedAuthority.applies !== null && !!current.sdlc && missing.length === 0;
      const gateCounts = new Map<string, number>();
      const rows = new Map([...new Set(transitions.map((t) => t.qitemId))].map((id) => [id, this.queue.getById(id)]));
      for (const t of transitions) {
        const tags = rows.get(t.qitemId)?.tags?.filter((tag) => tag.startsWith("gate:")).sort().join("+") || "untagged";
        gateCounts.set(tags, (gateCounts.get(tags) ?? 0) + 1);
      }
      const breakdown = [...gateCounts].sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([tag, count]) => `${tag}=${count}`).join(", ");
      return [{ kind: "coordination-lineage" as const, scope: current.scope, episodeStartedAt: stored.episodeStartedAt,
        lastObservedAt: current.observedAt, conditionCleared: !active && stored.qualifying !== null, confidence: "medium" as const, sourceDescription: `Outcome census attributed to ${stored.actor}; latest authored census: ${current.transitionIds.length} transitions, ${current.productOutcomes.length} listed product outcomes, bounded authority ${String(current.boundedAuthority.applies)}. Observed census: ${rows.size} qitems; transition breakdown by literal gate tags: ${breakdown}. Selected SDLC expectation: ${current.sdlc?.expectation ?? "SDLC expectation unavailable"}. Product, authority and expectation meaning are authored evidence, not inferred by the daemon. A known ratio is a signal to inspect proportionality against that expectation, not a verdict that a review was unnecessary. Unavailable references: ${missing.length ? missing.map((ref) => ref || "SDLC expectation unavailable").join(", ") : "none"}.`, lineageId: c.lineageQitemId,
        coordinationTransitions: c.transitionIds.length, productStateChanges: outcomeCount,
        boundedAuthority: available && c.boundedAuthority.applies === true,
        reviewReturns: 0, candidateChanges: 0, newRiskClasses: 0,
        source: boundHealthEvidence([...evidence, ...receipts], { source: "mixed", startedAt: new Date(Math.max(Date.parse(c.startedAt), Date.parse(now) - policy.observationWindowSeconds * 1000)).toISOString(), endedAt: now, limit: 11003, retentionSeconds: policy.observationWindowSeconds }, deriveHealthSourceFreshness({ evaluatedAt: now, newestSourceAt: current.observedAt, maxAgeSeconds: policy.freshnessSeconds, available })) }];
    });
  }
}
