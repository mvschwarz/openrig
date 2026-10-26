import { createHash } from "node:crypto";
import type { ClassificationCandidates } from "@openrig/daemon/stream-classifier";
import type { DaemonClient } from "../client.js";
import { runProjectWake, type prepareWorker, type WakeOptions } from "../commands/project-worker.js";
import type { DecisionResult, DecisionRun } from "./decisions.js";

/**
 * Slice 22 — the stream consumer, run by the intake seat inside its own wake (`rig project wake --decide`).
 *
 * For each eligible stream item one bounded decision runs with the shipped `stream` template.
 * - Answered: accepted with its classification (a stream disposition with a fixed effect); effects are
 *   applied after the wake, checking the wake's lease before each one.
 * - Anything else the provider was asked: deferred to intake. A `deferred` disposition with the
 *   structured result is stored with the automatic attempt's abstention, so intake has custody at once
 *   and the automatic path never asks again.
 * - Nothing sent because the run itself stopped (budget, settings, cancel): the wake stops and the
 *   item stays eligible for a later wake.
 * The automatic path keeps its own attempt identity (`<classifier version>+decide:<template>`), so
 * nothing it records hides an item from the agent's own `--decisions` path or `rig project classify`.
 */

type Client = Pick<DaemonClient, "get" | "post">;
type Prepared = Awaited<ReturnType<typeof prepareWorker>>;
type Routing = NonNullable<Prepared["snapshot"]["routing"]>;
type StreamItem = { streamItemId: string; sourceSession: string; body: string; hintType?: string | null; hintUrgency?: string | null;
  hintDestination?: string | null; hintTags?: string[] | null; interrupt?: boolean | number | null };
type Effect = { operation: "create" | "note" | "none"; qitemId: string | null; destination: string | null };
type Disposition = { disposition: "create" | "join" | "duplicate" | "no_action" | "deferred"; ownerSession: string | null; workQitemId: string | null;
  effect: Effect; templateDigest: string; templateText: string; request: string; provenance: unknown; reason?: string; result?: unknown };
type Stored = Disposition & { streamItemId: string; acceptedBy: string };
type Binding = { intake: string; generation: string; leaseId: string | null };

const MAX_OWNERS = 49; // with pool, a choice question takes at most 50 options
const BODY_CAP = 4000;
const POOL = "pool";
const NONE: Effect = { operation: "none", qitemId: null, destination: null };
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const firstLine = (text: string) => (text.split("\n").find(line => line.trim()) ?? "").trim().slice(0, 120);
/** The join marker, matched exactly: `[stream-join:S1]` never matches S10 or an incidental mention. */
const joinMarker = (streamItemId: string) => `[stream-join:${streamItemId}]`;

/** Bounded state and options for one observation. The body is quoted data; code keeps every reference. */
export function streamRequest(item: StreamItem, routing: Routing) {
  const owners = routing.owners.slice(0, MAX_OWNERS);
  const state = {
    observation: { id: item.streamItemId, source: item.sourceSession, body: item.body.slice(0, BODY_CAP), bodyTruncated: item.body.length > BODY_CAP,
      hints: { type: item.hintType ?? null, urgency: item.hintUrgency ?? null, destination: item.hintDestination ?? null,
        tags: item.hintTags ?? [], interrupt: !!item.interrupt } },
    // A missing owner or omitted work is unknown, not evidence for creating or ignoring.
    ownersTruncated: routing.ownersTruncated || routing.owners.length > MAX_OWNERS, workTruncated: routing.workTruncated,
  };
  const options = {
    owners: { ...Object.fromEntries(owners.map(o => [o.session, (o.role ? `${o.logicalId}: ${o.role}` : o.logicalId).slice(0, 300)])),
      [POOL]: "None of the supplied owners fits; leave it unassigned for intake." },
    work: Object.fromEntries(routing.work.map(w => [w.qitemId, `${w.destination} (${w.state}): ${w.summary || "no summary"}`.slice(0, 300)])),
  };
  return { state, options };
}

const answersOf = (result: DecisionResult) => result.status === "answered" || result.status === "abstained"
  ? Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id, { choice: a.choice, confidence: a.confidence }])) : undefined;

/**
 * The accepted judgment and fixed effect for an answered decision; otherwise a deferral to intake with the
 * structured result, or (when nothing was sent because the run stopped) no record, so a later wake retries.
 */
export function toDisposition(result: DecisionResult, routing: Routing, streamItemId: string, run: Pick<DecisionRun, "template">):
    { ok: true; destination: string | null; disposition: Disposition } | { ok: false; reason: string; deferral: Disposition | null } {
  const template = run.template!;
  const sent = result.status !== "not_called";
  const provenance = sent ? { ...result.provenance, answers: answersOf(result) } : {};
  const defer = (reason: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, reason, deferral: {
    disposition: "deferred" as const, ownerSession: null, workQitemId: null, effect: NONE, templateDigest: template.digest, templateText: template.text,
    request: sent ? result.request : JSON.stringify({ notSent: result.detail }), provenance, reason,
    result: { status: result.status, ...extra } } });
  if (result.status === "not_called") {
    // An oversized request is about this item; every other no-call is the run stopping before sending.
    if (result.reason === "invalid_request") return defer(`not sent (${result.detail}); intake decides`, { detail: result.detail });
    return { ok: false, reason: `not attempted (${result.reason}: ${result.detail})`, deferral: null };
  }
  if (result.status !== "answered") {
    const detail = result.status === "abstained" ? `unknown: ${result.unknown.join(", ")}` : result.status === "refused" ? result.message || `HTTP ${result.httpStatus}`
      : result.status === "stale" ? result.reason : result.detail;
    return defer(`decision ${result.status} (${detail}); intake decides`, { detail, answers: answersOf(result),
      ...(result.status === "failed" || result.status === "refused" ? { httpStatus: result.httpStatus } : {}),
      ...(result.status === "failed" ? { cause: result.cause, upstream: result.upstream } : {}) });
  }
  const choice = (id: string) => result.answers[id]?.choice ?? null;
  const kind = choice("disposition");
  const owner = routing.owners.find(o => o.session === choice("owner") && o.session !== POOL)?.session ?? null;
  const work = routing.work.find(w => w.qitemId === choice("work")) ?? null;
  const base = { templateDigest: template.digest, templateText: template.text, request: result.request, provenance };
  const answered = { answers: answersOf(result) };
  if (kind === "create") {
    if (!owner) return defer("create without a supplied owner; intake decides", answered);
    return { ok: true, destination: owner, disposition: { ...base, disposition: kind, ownerSession: owner, workQitemId: null,
      effect: { operation: "create", qitemId: `qitem-stream-${streamItemId}`, destination: owner } } };
  }
  if (kind === "join" || kind === "duplicate") {
    // Without a supplied work reference, neither is a safe answer: join has no target and duplicate would drop the item.
    if (!work) return defer(`${kind} without a supplied work item; intake decides`, answered);
    return { ok: true, destination: work.destination, disposition: { ...base, disposition: kind, ownerSession: work.destination, workQitemId: work.qitemId,
      effect: kind === "join" ? { operation: "note", qitemId: work.qitemId, destination: null } : NONE } };
  }
  if (kind === "no_action") return { ok: true, destination: null, disposition: { ...base, disposition: kind, ownerSession: null, workQitemId: null, effect: NONE } };
  return defer("no supported disposition; intake decides", answered);
}

async function read<T>(client: Client, url: string): Promise<{ status: number; data: T }> { return client.get<T>(url) as Promise<{ status: number; data: T }>; }
type QueueRow = { qitemId?: string; state?: string; destinationSession?: string; sourceSession?: string; tags?: string[] | null };

/** Applies one stored effect. Throws when the outcome is unknown, so the next wake retries the same effect. */
class ApplicationLeaseLost extends Error {}
async function applyEffect(client: Client, d: Stored, binding: Binding & { leaseId: string }): Promise<Record<string, unknown>> {
  const intake = binding.intake;
  const classificationBinding = { leaseId: binding.leaseId, expectedOccupant: binding.generation };
  const checkFence = (response: { status: number; data: unknown }) => {
    const code = (response.data as { error?: string })?.error ?? "";
    if (response.status >= 400 && (code.startsWith("lease_") || ["no_active_lease", "occupant_changed", "invalid_classification_binding"].includes(code)))
      throw new ApplicationLeaseLost("the wake's application binding is no longer held");
  };
  if (d.effect.operation === "none") return { operation: "none", disposition: d.disposition, workQitemId: d.workQitemId };
  const at = `/api/queue/${encodeURIComponent(d.effect.qitemId!)}`;
  if (d.effect.operation === "note") {
    const target = await read<QueueRow>(client, at);
    if (target.status === 404) return { operation: "note", qitemId: d.effect.qitemId, outcome: "target_missing" };
    if (target.status >= 400) throw Error(`work row HTTP ${target.status}`);
    // A row closed or handed off since the candidates were read: its successor's owner wouldn't see a note.
    if (!["pending", "in-progress", "blocked"].includes(target.data.state ?? "")) return { operation: "note", qitemId: d.effect.qitemId, outcome: "target_closed", state: target.data.state ?? null };
    const marker = joinMarker(d.streamItemId);
    const transitions = await read<{ transitionNote?: string | null }[]>(client, `${at}/transitions`);
    if (transitions.status >= 400) throw Error(`transitions HTTP ${transitions.status}`);
    if (transitions.data.some(t => t.transitionNote?.startsWith(`Joined ${marker} (routed by `))) return { operation: "note", qitemId: d.effect.qitemId, outcome: "already_noted" };
    const noted = await client.post(`${at}/update`, { classificationBinding, transitionNote: `Joined ${marker} (routed by ${intake}). Read it: rig stream show ${d.streamItemId}` });
    checkFence(noted);
    if (noted.status >= 400) throw Error(`note HTTP ${noted.status}`);
    return { operation: "note", qitemId: d.effect.qitemId, outcome: "noted" };
  }
  // The accepted effect, recognised whoever created it: the derived id, the owner and the item's tag.
  const reconcile = async (why: string): Promise<Record<string, unknown>> => {
    const row = await read<QueueRow>(client, at);
    if (row.status === 200 && row.data.sourceSession === d.acceptedBy && row.data.destinationSession === d.effect.destination && (row.data.tags ?? []).includes(`stream:${d.streamItemId}`))
      return { operation: "create", qitemId: d.effect.qitemId, outcome: "existing" };
    if (row.status >= 400 && row.status !== 404) throw Error(`queue row HTTP ${row.status}`);
    return { operation: "create", qitemId: d.effect.qitemId, outcome: "handed_to_intake", reason: why,
      evidence: row.status === 404 ? { row: "absent" } : { destination: row.data.destinationSession ?? null, source: row.data.sourceSession ?? null, tags: row.data.tags ?? [] } };
  };
  // The queue absorbs a retried create only from the same source; another holder never creates on someone else's acceptance.
  if (intake !== d.acceptedBy) return reconcile(`accepted by ${d.acceptedBy}; ${intake} doesn't create on another seat's acceptance`);
  const item = await read<StreamItem>(client, `/api/stream/${encodeURIComponent(d.streamItemId)}`);
  if (item.status >= 400) throw Error(`stream item HTTP ${item.status}`);
  const s = item.data, bytes = Buffer.byteLength(s.body);
  const model = (d.provenance as { returnedModel?: string | null; requestedModel?: string })?.returnedModel ?? (d.provenance as { requestedModel?: string })?.requestedModel;
  const body = [`# Stream observation routed to you: ${firstLine(s.body) || d.streamItemId}`, "",
    `- **Read it:** rig stream show ${d.streamItemId} (${bytes} bytes, from ${s.sourceSession}).`,
    `- **Hints:** type ${s.hintType ?? "none"}, urgency ${s.hintUrgency ?? "none"}, destination ${s.hintDestination ?? "none"}, tags ${(s.hintTags ?? []).join(", ") || "none"}.`,
    `- **Routed by:** ${intake} with typed decisions (template ${d.templateDigest.slice(0, 19)}, model ${model}). If it's misrouted, hand it off with the usual queue verbs.`].join("\n");
  const created = await client.post(`/api/queue/create`, { classificationBinding, qitemId: d.effect.qitemId, destinationSession: d.effect.destination, body,
    summary: `Stream observation from ${s.sourceSession}: ${firstLine(s.body)}`.slice(0, 200), tags: ["stream-routed", `stream:${d.streamItemId}`], priority: "routine" });
  checkFence(created);
  if (created.status === 409) return reconcile(`queue create refused the derived id (${(created.data as { error?: string })?.error ?? "conflict"})`);
  if (created.status >= 400) throw Error(`queue create HTTP ${created.status}`);
  return { operation: "create", qitemId: d.effect.qitemId, outcome: "created" };
}

/**
 * Applies every accepted-but-unapplied effect: this wake's, and any an earlier wake left after a crash.
 * The wake's lease and occupant are checked before each effect, and application stops when they're lost.
 */
export async function applyPending(client: Client, binding: Binding, limit = 50) {
  const occupant = `expectedOccupant=${encodeURIComponent(binding.generation)}`;
  let leaseId = binding.leaseId;
  if (!leaseId) {
    const held = await read<{ leaseId?: string }>(client, `/api/projects/lease?${occupant}`);
    if (held.status !== 200 || !held.data.leaseId) return [{ outcome: "skipped", reason: "no lease held by this seat; effects wait for the next wake" }];
    leaseId = held.data.leaseId;
  }
  const list = await read<Stored[]>(client, `/api/projects/dispositions/unapplied?limit=${limit}`);
  if (list.status >= 400) return [{ outcome: "unavailable", reason: `dispositions HTTP ${list.status}` }];
  const out: Record<string, unknown>[] = [];
  for (const d of list.data) {
    const held = await read<unknown>(client, `/api/projects/lease?expectedLeaseId=${encodeURIComponent(leaseId)}&${occupant}`);
    if (held.status !== 200) { out.push({ outcome: "stopped", reason: "the wake's lease is no longer held; remaining effects wait for the next wake" }); break; }
    let applied: Record<string, unknown>;
    try { applied = await applyEffect(client, d, { ...binding, leaseId }); } catch (error) {
      if (error instanceof ApplicationLeaseLost) { out.push({ streamItemId: d.streamItemId, outcome: "stopped", reason: error.message }); break; }
      out.push({ streamItemId: d.streamItemId, outcome: "unknown", reason: error instanceof Error ? error.message : "unavailable", retry: "next wake, same effect" });
      continue;
    }
    const marked = await client.post(`/api/projects/dispositions/${encodeURIComponent(d.streamItemId)}/applied?${occupant}`, { leaseId, applied });
    out.push({ streamItemId: d.streamItemId, disposition: d.disposition, ...applied, ...(marked.status >= 400 ? { recorded: false } : {}) });
    if (marked.status >= 400) break; // the effect may have committed; never proceed with a lost/uncertain binding
  }
  return out;
}

/**
 * Decisions off or unconfigured: nothing is asked, but effects already accepted are still applied, under this seat's
 * classifier lease, so committed work is never stranded by a disable.
 */
export async function recoverEffects(client: Client, project: string) {
  const sources = await read<{ occupant?: { session?: string; generation?: string } }>(client, `/api/projects/worker-sources?project=${encodeURIComponent(project)}`);
  const occupant = sources.status === 200 ? sources.data.occupant : undefined;
  if (!occupant?.session || !occupant.generation) return [{ outcome: "skipped", reason: "the intake occupant is unavailable; effects wait for a wake" }];
  const lease = await client.post<{ leaseId?: string; error?: string }>(`/api/projects/lease/acquire?expectedOccupant=${encodeURIComponent(occupant.generation)}`,
    { classifierSession: occupant.session, evaluateDeadnessFirst: true });
  if (lease.status >= 400 || typeof lease.data?.leaseId !== "string") {
    return [{ outcome: "skipped", reason: `classifier lease not acquired (${lease.data?.error ?? `HTTP ${lease.status}`}); effects wait for the holder's wake` }];
  }
  return applyPending(client, { intake: occupant.session, generation: occupant.generation, leaseId: lease.data.leaseId });
}

/** One bounded intake wake with typed decisions. The caller has checked `run.unavailable` first. */
export async function runDecideWake(client: Client, opts: WakeOptions, run: DecisionRun, readFile?: (file: string) => string) {
  const accepted = new Map<string, Disposition>(), deferrals = new Map<string, Disposition>(), reasons = new Map<string, string>();
  // Its own attempt identity, fresh when the template changes; the agent's --classifier-version stays free.
  const automatic = `${opts.classifierVersion}+decide:${run.template!.digest.slice(7, 19)}`;
  let routing: Routing | null = null, routingGap = "this daemon serves no routing candidates", stop = false, leaseId: string | null = null;
  const wake = await runProjectWake(client, { ...opts, classifierVersion: automatic }, readFile, {
    // The worker abstains an item when it's told to stop after a decision, so stopping only ever follows a thrown no-call.
    signal: new AbortController().signal, shouldStop: () => stop, timeoutMs: run.budget.callTimeoutMs + 5_000,
    // Items intake (or an earlier manual version) abstained on stay with intake; experiment abstentions don't count.
    eligibleQuery: { excludeAbstainedElsewhere: "1" },
    candidates: prepared => {
      routing = prepared.snapshot.routing ?? null;
      if (prepared.snapshot.routingUnavailable) routingGap = prepared.snapshot.routingUnavailable;
      const destinations = [...(routing?.owners ?? []).map(o => o.session), POOL];
      const values = { ...prepared.candidates.values, classificationDestination: destinations };
      return { ...prepared.candidates, values,
        version: hash(JSON.stringify({ base: prepared.candidates.version, routing: prepared.snapshot.routingVersion ?? null, destinations })) } satisfies ClassificationCandidates;
    },
    decide: () => async (request, signal) => {
      const id = request.item.streamItemId;
      // Intake already has custody of a deferred item (an earlier template, or an abstention that didn't land): never ask again.
      const existing = await read<{ disposition?: string }>(client, `/api/projects/dispositions/${encodeURIComponent(id)}`);
      if (existing.status === 200) { reasons.set(id, `already ${existing.data.disposition ?? "recorded"}; intake has it`); return { kind: "abstain", reason: reasons.get(id)! }; }
      if (existing.status !== 404) {
        stop = true; reasons.set(id, `not attempted: disposition lookup HTTP ${existing.status}`);
        throw Error(reasons.get(id)!);
      }
      if (!routing) {
        stop = true; reasons.set(id, `not attempted: routing candidates unavailable (${routingGap})`);
        throw Error(reasons.get(id)!);
      }
      const { state, options } = streamRequest(request.item as StreamItem, routing);
      const decided = toDisposition(await run.decide(state, options, signal), routing, id, run);
      if (decided.ok) {
        accepted.set(id, decided.disposition);
        return { kind: "classify", labels: decided.destination ? { classificationDestination: decided.destination } : {} };
      }
      reasons.set(id, decided.reason);
      if (!decided.deferral) { stop = true; throw Error(decided.reason); } // the run stopped before sending; a later wake retries
      deferrals.set(request.attempt.attemptId, decided.deferral);
      return { kind: "abstain", reason: decided.reason };
    },
    classifyBody: input => {
      leaseId ??= typeof input.leaseId === "string" ? input.leaseId : null;
      const d = accepted.get(String(input.streamItemId));
      return d ? { ...input, action: d.disposition, disposition: d } : input;
    },
    abstainBody: input => {
      leaseId ??= typeof input.leaseId === "string" ? input.leaseId : null;
      const d = deferrals.get(String(input.attemptId));
      return d ? { ...input, disposition: d } : input;
    },
  });
  const result = (wake as { result: { state: string; outcomes: { streamItemId: string; status: string; reason?: string }[] } }).result;
  const binding = { intake: wake.occupant.session, generation: wake.occupant.generation, leaseId };
  const applied = result.state === "processed" || result.state === "stopped" ? await applyPending(client, binding)
    : [{ outcome: "skipped", reason: `wake ended ${result.state}; effects wait for a wake that holds the lease` }];
  const withReason = (o: { streamItemId: string; status: string; reason?: string }) => ({ ...o, reason: o.reason ?? reasons.get(o.streamItemId), read: `rig stream show ${o.streamItemId}` });
  const forIntake = [
    ...result.outcomes.filter(o => o.status === "abstained").map(withReason),
    ...applied.filter(a => ["handed_to_intake", "target_missing", "target_closed"].includes(String(a.outcome)))
      .map(a => ({ ...a, read: `rig stream show ${a.streamItemId}` })),
  ];
  const notAttempted = result.outcomes.filter(o => o.status !== "written" && o.status !== "abstained").map(withReason);
  return { ...wake, nextCommand: null, wakeRequest: null,
    continuation: `Decide the forIntake items in this turn with rig project classify, or rig project wake --decisions under your own --classifier-version; ` +
      `the automatic path recorded its attempts under ${automatic} and won't ask about a deferred item again. notAttempted items stay for a later wake.`,
    decisions: { automaticClassifierVersion: automatic, calls: run.calls, applied, forIntake, notAttempted } };
}
