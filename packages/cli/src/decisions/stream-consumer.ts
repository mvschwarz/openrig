import { createHash } from "node:crypto";
import type { ClassificationCandidates } from "@openrig/daemon/stream-classifier";
import type { DaemonClient } from "../client.js";
import { runProjectWake, type prepareWorker, type WakeOptions } from "../commands/project-worker.js";
import type { DecisionResult, DecisionRun } from "./decisions.js";

/**
 * Slice 22 — the stream consumer, run by the intake seat inside its own wake (`rig project wake --decide`).
 *
 * For each eligible stream item one bounded decision runs with the shipped `stream` template. An
 * answered item is accepted with its classification (a stream disposition with a fixed effect), and
 * effects are applied after the wake while the lease is held. Every other result stays with the intake
 * agent: the worker records a retryable failure, never a terminal abstention.
 */

type Client = Pick<DaemonClient, "get" | "post">;
type Prepared = Awaited<ReturnType<typeof prepareWorker>>;
type Routing = NonNullable<Prepared["snapshot"]["routing"]>;
type StreamItem = { streamItemId: string; sourceSession: string; body: string; hintType?: string | null; hintUrgency?: string | null;
  hintDestination?: string | null; hintTags?: string[] | null; interrupt?: boolean | number | null };
type Disposition = { disposition: "create" | "join" | "duplicate" | "no_action"; ownerSession: string | null; workQitemId: string | null;
  effect: { operation: "create" | "note" | "none"; qitemId: string | null; destination: string | null };
  templateDigest: string; templateText: string; request: string; provenance: unknown };
type Stored = Disposition & { streamItemId: string };

const MAX_OWNERS = 49; // with pool, a choice question takes at most 50 options
const BODY_CAP = 4000;
const POOL = "pool";
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const firstLine = (text: string) => (text.split("\n").find(line => line.trim()) ?? "").trim().slice(0, 120);

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

/** The accepted judgment and fixed effect for an answered decision, or why intake decides instead. */
export function toDisposition(result: DecisionResult, routing: Routing, streamItemId: string, run: Pick<DecisionRun, "template">):
    { ok: true; destination: string | null; disposition: Disposition } | { ok: false; reason: string } {
  if (result.status !== "answered") {
    const detail = result.status === "abstained" ? `unknown: ${result.unknown.join(", ")}` : result.status === "refused" ? result.message || `HTTP ${result.httpStatus}`
      : result.status === "stale" ? result.reason : result.detail;
    return { ok: false, reason: `decision ${result.status} (${detail}); intake decides` };
  }
  const template = run.template!;
  const choice = (id: string) => result.answers[id]?.choice ?? null;
  const kind = choice("disposition") as Disposition["disposition"] | null;
  const owner = routing.owners.find(o => o.session === choice("owner") && o.session !== POOL)?.session ?? null;
  const work = routing.work.find(w => w.qitemId === choice("work")) ?? null;
  const base = { templateDigest: template.digest, templateText: template.text, request: result.request,
    // Choice and confidence per answer; the full distributions stay in the provider's response.
    provenance: { ...result.provenance, answers: Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id, { choice: a.choice, confidence: a.confidence }])) } };
  if (kind === "create") {
    if (!owner) return { ok: false, reason: "create without a supplied owner; intake decides" };
    return { ok: true, destination: owner, disposition: { ...base, disposition: kind, ownerSession: owner, workQitemId: null,
      effect: { operation: "create", qitemId: `qitem-stream-${streamItemId}`, destination: owner } } };
  }
  if (kind === "join") {
    if (!work) return { ok: false, reason: "join without a supplied work item; intake decides" };
    return { ok: true, destination: work.destination, disposition: { ...base, disposition: kind, ownerSession: work.destination, workQitemId: work.qitemId,
      effect: { operation: "note", qitemId: work.qitemId, destination: null } } };
  }
  if (kind === "duplicate" || kind === "no_action") return { ok: true, destination: null, disposition: { ...base, disposition: kind,
    ownerSession: null, workQitemId: kind === "duplicate" ? work?.qitemId ?? null : null, effect: { operation: "none", qitemId: null, destination: null } } };
  return { ok: false, reason: "no supported disposition; intake decides" };
}

async function read<T>(client: Client, url: string): Promise<{ status: number; data: T }> { return client.get<T>(url) as Promise<{ status: number; data: T }>; }

/** Applies one stored effect. Throws when the outcome is unknown, so the next wake retries the same effect. */
async function applyEffect(client: Client, d: Stored, intake: string): Promise<Record<string, unknown>> {
  if (d.effect.operation === "none") return { operation: "none", disposition: d.disposition, workQitemId: d.workQitemId };
  const marker = `stream ${d.streamItemId}`;
  if (d.effect.operation === "note") {
    const transitions = await read<{ transitionNote?: string | null }[]>(client, `/api/queue/${encodeURIComponent(d.effect.qitemId!)}/transitions`);
    if (transitions.status === 404) return { operation: "note", qitemId: d.effect.qitemId, outcome: "target_missing" };
    if (transitions.status >= 400) throw Error(`transitions HTTP ${transitions.status}`);
    if (transitions.data.some(t => t.transitionNote?.includes(marker))) return { operation: "note", qitemId: d.effect.qitemId, outcome: "already_noted" };
    const noted = await client.post(`/api/queue/${encodeURIComponent(d.effect.qitemId!)}/update`,
      { transitionNote: `Joined ${marker} (routed by ${intake}). Read it: rig stream show ${d.streamItemId}` });
    if (noted.status >= 400) throw Error(`note HTTP ${noted.status}`);
    return { operation: "note", qitemId: d.effect.qitemId, outcome: "noted" };
  }
  const item = await read<StreamItem>(client, `/api/stream/${encodeURIComponent(d.streamItemId)}`);
  if (item.status >= 400) throw Error(`stream item HTTP ${item.status}`);
  const s = item.data, bytes = Buffer.byteLength(s.body);
  const model = (d.provenance as { returnedModel?: string | null; requestedModel?: string })?.returnedModel ?? (d.provenance as { requestedModel?: string })?.requestedModel;
  const body = [`# Stream observation routed to you: ${firstLine(s.body) || d.streamItemId}`, "",
    `- **Read it:** rig stream show ${d.streamItemId} (${bytes} bytes, from ${s.sourceSession}).`,
    `- **Hints:** type ${s.hintType ?? "none"}, urgency ${s.hintUrgency ?? "none"}, destination ${s.hintDestination ?? "none"}, tags ${(s.hintTags ?? []).join(", ") || "none"}.`,
    `- **Routed by:** ${intake} with typed decisions (template ${d.templateDigest.slice(0, 19)}, model ${model}). If it's misrouted, hand it off with the usual queue verbs.`].join("\n");
  const created = await client.post(`/api/queue/create`, { qitemId: d.effect.qitemId, destinationSession: d.effect.destination, body,
    summary: `Stream observation from ${s.sourceSession}: ${firstLine(s.body)}`.slice(0, 200), tags: ["stream-routed", `stream:${d.streamItemId}`], priority: "routine" });
  if (created.status === 409) return { operation: "create", qitemId: d.effect.qitemId, outcome: "conflict", detail: (created.data as { error?: string })?.error ?? "conflict" };
  if (created.status >= 400) throw Error(`queue create HTTP ${created.status}`);
  return { operation: "create", qitemId: d.effect.qitemId, outcome: "created" };
}

/** Applies every accepted-but-unapplied effect: this wake's, and any an earlier wake left after a crash. */
export async function applyPending(client: Client, intake: string, limit = 50) {
  const list = await read<Stored[]>(client, `/api/projects/dispositions/unapplied?limit=${limit}`);
  if (list.status >= 400) return [{ outcome: "unavailable", reason: `dispositions HTTP ${list.status}` }];
  const out: Record<string, unknown>[] = [];
  for (const d of list.data) {
    let applied: Record<string, unknown>;
    try { applied = await applyEffect(client, d, intake); } catch (error) {
      out.push({ streamItemId: d.streamItemId, outcome: "unknown", reason: error instanceof Error ? error.message : "unavailable", retry: "next wake, same effect" });
      continue;
    }
    const marked = await client.post(`/api/projects/dispositions/${encodeURIComponent(d.streamItemId)}/applied`, { applied });
    out.push({ streamItemId: d.streamItemId, disposition: d.disposition, ...applied, ...(marked.status >= 400 ? { recorded: false } : {}) });
  }
  return out;
}

/** One bounded intake wake with typed decisions. The caller has checked `run.unavailable` first. */
export async function runDecideWake(client: Client, opts: WakeOptions, run: DecisionRun, readFile?: (file: string) => string) {
  const accepted = new Map<string, Disposition>();
  let routing: Routing | null = null, routingGap = "this daemon serves no routing candidates";
  const wake = await runProjectWake(client, opts, readFile, {
    // The worker's own stop path abstains terminally, so it never stops here; the run halts itself instead.
    signal: new AbortController().signal, shouldStop: () => false, timeoutMs: run.budget.callTimeoutMs + 5_000,
    candidates: prepared => {
      routing = prepared.snapshot.routing ?? null;
      if (prepared.snapshot.routingUnavailable) routingGap = prepared.snapshot.routingUnavailable;
      const destinations = [...(routing?.owners ?? []).map(o => o.session), POOL];
      const values = { ...prepared.candidates.values, classificationDestination: destinations };
      return { ...prepared.candidates, values,
        version: hash(JSON.stringify({ base: prepared.candidates.version, routing: prepared.snapshot.routingVersion ?? null, destinations })) } satisfies ClassificationCandidates;
    },
    decide: () => async (request, signal) => {
      if (!routing) throw Error(`routing candidates unavailable (${routingGap}); intake decides`);
      const { state, options } = streamRequest(request.item as StreamItem, routing);
      const decided = toDisposition(await run.decide(state, options, signal), routing, request.item.streamItemId, run);
      if (!decided.ok) throw Error(decided.reason); // a retryable attempt failure; the agent decides this item
      accepted.set(request.item.streamItemId, decided.disposition);
      return { kind: "classify", labels: decided.destination ? { classificationDestination: decided.destination } : {} };
    },
    classifyBody: input => {
      const d = accepted.get(String(input.streamItemId));
      return d ? { ...input, action: d.disposition, disposition: d } : input;
    },
  });
  const result = (wake as { result: { state: string; outcomes: { streamItemId: string; status: string; reason?: string }[] } }).result;
  const intake = wake.occupant.session;
  const applied = result.state === "processed" || result.state === "stopped" ? await applyPending(client, intake)
    : [{ outcome: "skipped", reason: `wake ended ${result.state}; effects wait for a wake that holds the lease` }];
  const forIntake = result.outcomes.filter(o => o.status !== "written")
    .map(o => ({ ...o, read: `rig stream show ${o.streamItemId}` }));
  return { ...wake, nextCommand: null, wakeRequest: null, continuation: "Decide the forIntake items in this turn; effects of accepted decisions are listed under applied.",
    decisions: { calls: run.calls, applied, forIntake } };
}
