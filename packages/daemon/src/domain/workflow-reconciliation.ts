import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { compileProjectLifecycle, type LifecycleCompilation, type LifecycleSourceDigest } from "./project-lifecycle-compiler.js";
import { WorkflowInstanceStore, WorkflowInstanceError } from "./workflow-instance-store.js";
import { WorkflowSpecCache } from "./workflow-spec-cache.js";
import type { WorkflowInstance, WorkflowSpec } from "./workflow-types.js";
import type { EventBus } from "./event-bus.js";
import { shellQuote } from "../adapters/shell-quote.js";

export interface GraphReconciliation {
  status: "current" | "source-only" | "compatible" | "incompatible" | "unavailable" | "unbound";
  adopted: boolean | null;
  boundDigest: string | null;
  proposedDigest: string | null;
  boundVersion: string;
  proposedVersion: string | null;
  compatible: boolean;
  changes: Array<{ kind: string; ref: string; fields?: string[] }>;
  reasons: string[];
  composition: { mode: string; explanation: string; boundSlices: string[]; executableSteps: Array<{ id: string; dependsOn: string[] }> };
  nextAction: string;
  applyCommand?: string;
  operationKey?: string;
  expectedVersion: number;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const graph = ({ version: _version, ...spec }: WorkflowSpec) => ({ ...spec, coordination_terminal_turn_rule: spec.coordination_terminal_turn_rule ?? "hot_potato" });
const sourcesOf = (instance: WorkflowInstance): LifecycleSourceDigest[] => Array.isArray(instance.lifecycleBinding?.sources)
  ? instance.lifecycleBinding.sources.filter((s): s is LifecycleSourceDigest => !!s && typeof s.path === "string" && typeof s.sha256 === "string" && ["project", "mission", "slice"].includes(s.kind))
  : [];
const caches = new WeakMap<Database.Database, Map<string, { signature: string; result: ReturnType<typeof compare> }>>();

/** One derived comparison for CLI/TUI. Unchanged reads stat bound inputs,
 * not recompile every proof/manifest; replacement, deletion and revision invalidate it. */
export function inspectGraph(db: Database.Database, instanceId: string): GraphReconciliation {
  return proposal(db, new WorkflowInstanceStore(db).getByIdOrThrow(instanceId)).view;
}

function proposal(db: Database.Database, instance: WorkflowInstance, fresh = false): ReturnType<typeof compare> {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const old = cache.get(instance.instanceId);
  const signatureFor = (extra: LifecycleSourceDigest[] = []) => canonical([instance.version, instance.status,
    [...new Set([...sourcesOf(instance), ...extra].map(source => source.path))].sort().map(path => {
      try {
        const s = lstatSync(path, { bigint: true });
        return [path, String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
      } catch { return [path, "unavailable"]; }
    })]);
  if (!fresh && old?.result.view.status !== "unavailable" && old?.signature === signatureFor(old?.result.compilation?.sources)) return old.result;
  const result = compare(db, instance);
  cache.set(instance.instanceId, { signature: signatureFor(result.compilation?.sources), result });
  return result;
}

function compare(db: Database.Database, instance: WorkflowInstance): { view: GraphReconciliation; compilation?: LifecycleCompilation } {
  const binding = instance.lifecycleBinding;
  // The spec this instance runs (#2607), with its rig placeholders as authored, so the graph comparison is unchanged.
  const oldSpec = new WorkflowSpecCache(db).getForInstance({ ...instance, boundRig: null })?.spec;
  const mode = String((binding?.graphSource as { mode?: string } | undefined)?.mode ?? "unbound");
  const view: GraphReconciliation = {
    status: "unbound", adopted: null, boundDigest: instance.compiledInputDigest, proposedDigest: null,
    boundVersion: instance.workflowVersion, proposedVersion: null, compatible: false,
    expectedVersion: instance.version, changes: [], reasons: [],
    composition: {
      mode,
      explanation: mode === "legacy-slices"
        ? "Active slice execution contracts are executable steps; execution.depends_on supplies prerequisites. Membership order is advisory."
        : "The project profile and mission extension/override define outer steps. Slice manifests bind sources and proof, not automatic nested children. Waves group agent planning; they do not schedule child work. Current packets and blockers carry actual custody.",
      boundSlices: sourcesOf(instance).filter(s => s.kind === "slice").map(s => s.path),
      executableSteps: oldSpec?.steps.map(s => ({ id: s.id, dependsOn: s.depends_on ?? [] })) ?? [],
    },
    nextAction: "rig workflow trace " + instance.instanceId,
  };
  if (!binding || !instance.lifecycleOperationKey) {
    view.reasons.push("This is not a manifest-bound lifecycle. Inspect its authored spec; lifecycle revision does not migrate arbitrary workflows.");
    return { view };
  }
  if (!Array.isArray(binding.sources) || sourcesOf(instance).length !== binding.sources.length) {
    view.status = "unavailable"; view.reasons.push("Retained source bindings are malformed or incomplete; restore their provenance before revision.");
    return { view };
  }
  const missionPath = sourcesOf(instance).find(s => s.kind === "mission")?.path;
  if (!missionPath || !oldSpec) {
    view.status = "unavailable"; view.reasons.push("Bound mission source or retained running specification is unavailable; restore that evidence before revision.");
    return { view };
  }
  let compilation: LifecycleCompilation;
  try { compilation = compileProjectLifecycle({ missionPath, operationKey: instance.lifecycleOperationKey }); }
  catch (error) {
    view.status = "unavailable"; view.reasons.push(error instanceof Error ? error.message : String(error));
    view.nextAction = "Repair the named authored input, then rig workflow revise " + instance.instanceId;
    return { view };
  }
  view.proposedDigest = compilation.compiledInputDigest;
  view.proposedVersion = compilation.workflowSpec?.version ?? null;
  for (const source of sourcesOf(instance)) {
    const current = compilation.sources.find(s => s.path === source.path);
    if (!current) view.changes.push({ kind: "source-removed", ref: source.path });
    else if (current.sha256 !== source.sha256) view.changes.push({ kind: "source-changed", ref: source.path });
  }
  for (const source of compilation.sources) if (!sourcesOf(instance).some(s => s.path === source.path))
    view.changes.push({ kind: "source-added", ref: source.path });
  const proposed = compilation.workflowSpec;
  if (!compilation.eligible || !proposed) {
    view.status = "incompatible"; view.reasons.push(...compilation.unknowns);
    return { view, compilation };
  }
  const completed = new Set((db.prepare(
    "SELECT step_id FROM workflow_step_trails WHERE instance_id = ? AND closure_reason IN ('done', 'handoff')",
  ).all(instance.instanceId) as Array<{ step_id: string }>).map(row => row.step_id));
  const store = new WorkflowInstanceStore(db);
  const live = store.listFrontierBindings(instance.instanceId);
  const protectedIds = new Set([...completed, ...live.map(row => row.stepId), ...store.listFailureOccurrences(instance.instanceId).map(row => row.stepId)]);
  if (live.length !== instance.currentFrontier.length) view.reasons.push("Current frontier has missing or ambiguous step bindings; resolve custody before revision.");
  if (!["active", "waiting"].includes(instance.status)) view.reasons.push("Instance is " + instance.status + "; retained terminal or failed history is not revised.");
  if (oldSpec.steps.some(s => s.depends_on === undefined || s.next_hop?.on) || proposed.steps.some(s => s.depends_on === undefined || s.next_hop?.on))
    view.reasons.push("Only explicit dependency graphs without conditional jumps support in-place revision.");
  const { steps: _oldSteps, exception_routing: oldRouting, ...oldContract } = graph(oldSpec);
  const { steps: _newSteps, exception_routing: newRouting, ...newContract } = graph(proposed);
  if (!same(oldRouting, newRouting)) view.changes.push({ kind: "exception-routing-changed", ref: "exception_routing", fields: ["future occurrences only; existing obligations keep their owners"] });
  if (!same(oldContract, newContract)) view.reasons.push("Workflow-wide routing, entry, policy or context contract changed; restore those fields and revise future steps separately.");
  const oldRequired = (binding.graphSource as { requiredSteps?: string[] } | undefined)?.requiredSteps ?? [];
  for (const id of oldRequired) if (!compilation.graphSource.requiredSteps.includes(id))
    view.reasons.push("Required obligation " + id + " cannot be removed.");
  const ancestors = (spec: WorkflowSpec, id: string, seen = new Set<string>()): Set<string> => {
    for (const parent of spec.steps.find(s => s.id === id)?.depends_on ?? []) {
      if (!seen.has(parent)) { seen.add(parent); ancestors(spec, parent, seen); }
    }
    return seen;
  };
  for (const id of oldRequired) {
    const before = ancestors(oldSpec, id), after = ancestors(proposed, id);
    for (const parent of oldRequired) if (before.has(parent) && !after.has(parent))
      view.reasons.push("Required order " + parent + " before " + id + " cannot be removed.");
  }
  for (const step of proposed.steps) if (step.host && step.host !== "local")
    view.reasons.push("Step " + step.id + " requires unsupported remote execution; keep a local supported target.");
  for (const step of oldSpec.steps) {
    const next = proposed.steps.find(s => s.id === step.id);
    if (!next) {
      view.changes.push({ kind: "step-removed", ref: step.id });
      view.reasons.push("Step " + step.id + " cannot be removed; preserve its obligation and record an attributed disposition.");
    } else if (!same(step, next)) {
      view.changes.push({ kind: "step-changed", ref: step.id, fields: [...new Set([...Object.keys(step), ...Object.keys(next)])].filter(key => !same((step as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key])) });
      if (protectedIds.has(step.id)) view.reasons.push("Step " + step.id + " already has completed, live or failed work. Its judgment/custody needs explicit reconsideration; restore this step and revise unstarted successors.");
    }
  }
  for (const step of proposed.steps) if (!oldSpec.steps.some(s => s.id === step.id))
    view.changes.push({ kind: "step-added", ref: step.id });
  // The existing projector creates successors when a prerequisite closes.
  // Refuse a newly eligible root rather than invent a second scheduling path.
  for (const step of proposed.steps) if (!protectedIds.has(step.id) && (step.depends_on ?? []).every(id => completed.has(id)))
    view.reasons.push("Unstarted step " + step.id + " has no unfinished prerequisite to trigger it. Keep it dependent on outstanding work; this revision does not replay completed prerequisites.");
  view.adopted = instance.compiledInputDigest === compilation.compiledInputDigest;
  view.compatible = view.reasons.length === 0;
  view.status = view.adopted ? "current" : !view.compatible ? "incompatible" : same(graph(oldSpec), graph(proposed)) ? "source-only" : "compatible";
  view.nextAction = "rig workflow revise " + instance.instanceId;
  if (!view.adopted && view.compatible) {
    view.operationKey = "revision-" + createHash("sha256").update(canonical([instance.instanceId, instance.version, compilation.compiledInputDigest])).digest("hex").slice(0, 24);
    view.applyCommand = "rig workflow revise " + instance.instanceId + " --apply --expected-version " + instance.version + " --expected-digest " + compilation.compiledInputDigest + " --operation-key " + view.operationKey + " --actor-session <you> --reason <decision>";
  }
  return { view, compilation };
}

/** Native effect readback survives lost responses and later authored changes.
 * Receipts live in the existing instance binding; prior specs/step/queue history remain. */
export function recoverGraphOperation(db: Database.Database, key: string): { kind: string; receipt: Record<string, unknown>; instance: WorkflowInstance } | null {
  const store = new WorkflowInstanceStore(db);
  const created = store.getByLifecycleOperationKey(key);
  if (created) return { kind: "instantiate", instance: created, receipt: {
    operationKey: key, instanceId: created.instanceId, entryQitemId: created.lifecycleBinding?.entryQitemId,
    compiledInputDigest: created.lifecycleBinding?.initialInputDigest ?? created.compiledInputDigest,
    createdAt: created.createdAt, actorSession: created.createdBySession,
  } };
  const match = db.prepare("SELECT wi.instance_id, revision.value AS receipt FROM workflow_instances wi, json_each(wi.lifecycle_binding_json, '$.revisionHistory') revision WHERE json_extract(revision.value, '$.operationKey') = ?")
    .get(key) as { instance_id: string; receipt: string } | undefined;
  return match ? { kind: "revision", instance: store.getByIdOrThrow(match.instance_id), receipt: JSON.parse(match.receipt) } : null;
}

export function reviseGraph(db: Database.Database, bus: EventBus, input: {
  instanceId: string; operationKey: string; expectedVersion: number; expectedDigest: string; actorSession: string; reason: string;
}) {
  const fail = (message: string, details?: Record<string, unknown>): never => { throw new WorkflowInstanceError("lifecycle_revision_conflict", message, details); };
  if (typeof input.operationKey !== "string" || !input.operationKey.trim() || typeof input.actorSession !== "string" || !input.actorSession.trim() || typeof input.reason !== "string" || !input.reason.trim() || !Number.isSafeInteger(input.expectedVersion) || typeof input.expectedDigest !== "string" || !input.expectedDigest)
    fail("Revision needs the inspected version/digest, stable operation key, actor and decision. Run rig workflow revise <instance>.");
  const prior = recoverGraphOperation(db, input.operationKey);
  if (prior) {
    if (prior.kind !== "revision" || prior.instance.instanceId !== input.instanceId ||
        prior.receipt.expectedVersion !== input.expectedVersion || prior.receipt.compiledInputDigest !== input.expectedDigest ||
        prior.receipt.actorSession !== input.actorSession || prior.receipt.reason !== input.reason)
      fail("This operation key already records a different decision. Inspect rig workflow operation " + shellQuote(input.operationKey));
    return { ...prior, replayed: true };
  }
  let receipt!: Record<string, unknown>;
  bus.withNotifyEnvelope(register => {
    if (recoverGraphOperation(db, input.operationKey)) fail("Operation committed concurrently; recover its exact key before another attempt.");
    const store = new WorkflowInstanceStore(db), instance = store.getByIdOrThrow(input.instanceId);
    if (instance.version !== input.expectedVersion) fail("The instance progressed since inspection. Inspect again before choosing a revision.", { expectedVersion: input.expectedVersion, actualVersion: instance.version });
    const { view, compilation } = proposal(db, instance, true);
    if (view.proposedDigest !== input.expectedDigest) fail("Authored input changed since inspection. Inspect the new proposal before applying it.", { expectedDigest: input.expectedDigest, actualDigest: view.proposedDigest });
    if (!view.compatible || view.adopted || !compilation?.workflowSpec) fail("Revision refused; existing work is preserved.", { reconciliation: view });
    const binding = instance.lifecycleBinding!;
    receipt = { operationKey: input.operationKey, instanceId: input.instanceId, expectedVersion: input.expectedVersion,
      previousDigest: instance.compiledInputDigest, previousVersion: instance.workflowVersion,
      previousSources: binding.sources, previousGraphSource: binding.graphSource,
      compiledInputDigest: compilation!.compiledInputDigest, workflowVersion: compilation!.workflowSpec!.version,
      actorSession: input.actorSession, reason: input.reason, at: new Date().toISOString(), sourceOnly: view.status === "source-only",
      preservedFrontier: instance.currentFrontier, changes: view.changes };
    new WorkflowSpecCache(db).putGenerated(compilation!.workflowSpec!, compilation!.sources.find(s => s.kind === "mission")!.path, compilation!.compiledInputDigest);
    store.reviseLifecycle(instance.instanceId, instance.version, compilation!.workflowSpec!.version, compilation!.compiledInputDigest, {
      ...binding, initialInputDigest: binding.initialInputDigest ?? instance.compiledInputDigest,
      sources: compilation!.sources, dependencies: compilation!.dependencies, graphSource: compilation!.graphSource,
      revisionHistory: [...(Array.isArray(binding.revisionHistory) ? binding.revisionHistory : []), receipt],
    });
    register(bus.persistWithinTransaction({ type: "workflow.revised", instanceId: instance.instanceId, workflowName: instance.workflowName, operationKey: input.operationKey, compiledInputDigest: compilation!.compiledInputDigest, revisedBy: input.actorSession }));
  });
  return { kind: "revision", receipt, instance: new WorkflowInstanceStore(db).getByIdOrThrow(input.instanceId), replayed: false };
}
