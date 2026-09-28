import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse } from "yaml";
import { StreamClassificationWorker, ClassifierLeaseError, ClassificationAttemptError, ProjectClassifierError,
  LABEL_FIELDS, type WorkerOptions, type ClassificationCandidates, type ClassificationDecision } from "@openrig/daemon/stream-classifier";
import type { DaemonClient } from "../client.js";

type Client = Pick<DaemonClient, "get" | "post">;
export interface WakeOptions { project: string; taxonomy: string; classifierVersion: string; evidenceEpoch: string; decisions?: string; limit?: string }
type SourceSnapshot = {
  occupant: { session: string; nodeId: string; generation: string; rigId: string };
  version: string; observedAt: string; unavailable: string[];
  sources: { project: unknown; scopes: {id: string; source: string; hash: string}[];
    roster: {session: string; nodeId: string; generation: string}[];
    recent: {streamItemId: string; body: string; evidenceRef: string}[] };
};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function localText(file: string): string {
  if (fs.statSync(file).size > 1024 * 1024) throw Error("worker input exceeds 1 MiB");
  const text = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error("worker input exceeds 1 MiB");
  return text;
}
function response<T>(r: {status: number; data: T}): T {
  if (r.status < 400) return r.data;
  const body = r.data as {error?: string; message?: string};
  const code = body?.error ?? "http_error", message = body?.message ?? code;
  if (code.startsWith("lease_") || ["no_active_lease", "occupant_changed", "occupant_unavailable"].includes(code)) throw new ClassifierLeaseError(code, message);
  if (code.startsWith("attempt_") || code === "already_classified") throw new ClassificationAttemptError(code, message);
  if (code === "idempotency_violation") throw new ProjectClassifierError(code, message);
  throw Error(`${code}: ${message}`);
}

export async function prepareWorker(client: Client, opts: WakeOptions, read = localText) {
  const limit = Number(opts.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("limit must be an integer in 1..100");
  const text = read(opts.taxonomy), taxonomy = parse(text);
  if (!taxonomy || typeof taxonomy.version !== "string" || !taxonomy.version.trim()) throw Error("taxonomy version is required");
  const snapshot = response(await client.get<SourceSnapshot>(`/api/projects/worker-sources?project=${encodeURIComponent(opts.project)}`));
  const occupant = snapshot.occupant;
  if (!occupant?.session || !occupant.generation || !occupant.nodeId) throw Error("real classifier occupant unavailable");
  const values: ClassificationCandidates["values"] = {classificationType: [], classificationUrgency: [], classificationMaturity: [], classificationConfidence: [], classificationDestination: [], area: [], scopeRef: []};
  for (const [input, output] of [["kind","classificationType"],["urgency","classificationUrgency"],["maturity","classificationMaturity"],["area","area"]] as const) {
    const field = taxonomy.fields?.[input];
    if (typeof field?.question !== "string" || !field.values || Array.isArray(field.values) || typeof field.values !== "object") throw Error(`taxonomy ${input} question/values unavailable`);
    values[output] = Object.keys(field.values);
  }
  values.scopeRef = snapshot.sources.scopes.map(x => x.id);
  values.classificationDestination = [...snapshot.sources.roster.map(x => x.session), "pool"];
  const candidates: ClassificationCandidates = {
    version: hash(JSON.stringify({sourceVersion: snapshot.version, taxonomyHash: hash(text), values})), values,
    duplicateCandidates: snapshot.sources.recent.map(x => ({streamItemId: x.streamItemId, evidenceRef: x.evidenceRef})), relatedRefs: [],
  };
  const query = new URLSearchParams({classifierVersion: opts.classifierVersion, taxonomyVersion: taxonomy.version, evidenceEpoch: opts.evidenceEpoch, limit: opts.limit ?? "20", expectedOccupant: occupant.generation});
  const eligible = response(await client.get<{items: {streamItemId: string}[]; nextAfterSortKey: string | null}>(`/api/projects/eligible?${query}`));
  return {snapshot, candidates, taxonomy: {version: taxonomy.version, source: opts.taxonomy, hash: hash(text), questions: taxonomy.fields}, eligible};
}

/** The receiving entry for one occupant-owned bounded wake. No automatic registration. */
export async function runProjectWake(client: Client, opts: WakeOptions, read = localText, experiment?: {
  decide: (prepared: Awaited<ReturnType<typeof prepareWorker>>) => WorkerOptions["classify"];
  signal: AbortSignal; shouldStop: () => boolean; timeoutMs: number;
}) {
  const prepared = await prepareWorker(client, opts, read);
  const {snapshot, candidates, taxonomy} = prepared;
  const {session, generation} = snapshot.occupant;
  const suffix = (url: string) => `${url}${url.includes("?") ? "&" : "?"}expectedOccupant=${encodeURIComponent(generation)}`;
  const get = async <T>(url: string): Promise<T> => response(await client.get<T>(suffix(url)));
  const post = async <T>(url: string, body: unknown): Promise<T> => response(await client.post<T>(suffix(url), body));
  const packet = opts.decisions ? JSON.parse(read(opts.decisions)) as {
    candidateSetVersion: string; decisions: {streamItemId: string; bodyHash: string; decision: ClassificationDecision}[];
  } : null;
  if (packet && (!Array.isArray(packet.decisions) || packet.decisions.length > 100 || new Set(packet.decisions.map(x => x.streamItemId)).size !== packet.decisions.length)) throw Error("decisions must contain at most 100 unique stream item IDs");
  if (!experiment && (!packet || packet.candidateSetVersion !== candidates.version)) throw Error("fresh decisions bound to this candidateSetVersion are required; no attempts started");
  if (experiment && packet) throw Error("choose one source of decisions");
  const worker = new StreamClassificationWorker({
    session, classifierVersion: opts.classifierVersion, taxonomyVersion: taxonomy.version, evidenceEpoch: opts.evidenceEpoch,
    candidates, pageSize: Number(opts.limit ?? 20),
    ...(experiment ? {signal: experiment.signal, shouldStop: experiment.shouldStop, requestTimeoutMs: experiment.timeoutMs} : {}),
    leases: {
      evaluateDeadness: () => null, // acquire uses the existing evaluated-acquire transaction path.
      acquire: actor => post("/api/projects/lease/acquire", {classifierSession: actor, evaluateDeadnessFirst: true}),
      requireActiveHolder: (_actor, id) => get(`/api/projects/lease?expectedLeaseId=${encodeURIComponent(id ?? "")}`),
      heartbeat: (id, actor) => post("/api/projects/lease/heartbeat", {leaseId: id, classifierSession: actor}),
    },
    attempts: {
      eligible: input => get(`/api/projects/eligible?${new URLSearchParams(Object.entries(input).filter(([,v]) => v !== undefined).map(([k,v]): [string, string] => [k,String(v)]))}`),
      begin: input => post("/api/projects/attempts/begin", input),
      abstain: input => post(`/api/projects/attempts/${encodeURIComponent(input.attemptId)}/abstain`, input),
      fail: input => post(`/api/projects/attempts/${encodeURIComponent(input.attemptId)}/fail`, input),
    },
    classifier: {classify: input => post("/api/projects/project", input)},
    stream: {getById: id => get(`/api/stream/${encodeURIComponent(id)}`)},
    classify: experiment ? experiment.decide(prepared) : async request => {
      if (snapshot.unavailable.length) return {kind: "abstain", reason: `candidate sources unavailable: ${snapshot.unavailable.join("; ")}`};
      if (!packet || packet.candidateSetVersion !== candidates.version) return {kind: "abstain", reason: "decisions unavailable for this candidate snapshot"};
      const selected = packet.decisions.find(x => x.streamItemId === request.item.streamItemId && x.bodyHash === hash(request.item.body));
      if (!selected) return {kind: "abstain", reason: "decision unavailable for exact stream item bytes"};
      if (selected.decision?.kind === "classify") {
        const labels = selected.decision.labels;
        if (!labels || LABEL_FIELDS.some(field => labels[field] != null && !candidates.values[field].includes(labels[field]!))) return {kind: "abstain", reason: "selected label candidate unavailable"};
        if (labels.duplicateOfStreamItemId != null && !candidates.duplicateCandidates.some(x => x.streamItemId === labels.duplicateOfStreamItemId && x.evidenceRef === labels.duplicateEvidenceRef)) return {kind: "abstain", reason: "positive duplicate evidence unavailable"};
      }
      return selected.decision;
    },
  } satisfies WorkerOptions);
  const result = await worker.wake();
  // Descriptor only. A message requests this entry; it never executes a wake by itself.
  let wakeRequest: unknown = null;
  // A copied argument vector, never an interpolated shell command. The occupant still owns judgment.
  const nextCommand = ["rig", "project", "candidates", "--project", opts.project, "--taxonomy", opts.taxonomy,
    "--classifier-version", opts.classifierVersion, "--evidence-epoch", opts.evidenceEpoch, "--limit", opts.limit ?? "20", "--json"];
  try {
    if (experiment) return {occupant: snapshot.occupant, candidateSetVersion: candidates.version, evidenceEpoch: opts.evidenceEpoch,
      result, nextCommand: null, wakeRequest: null, registered: false, sourceSnapshot: snapshot,
      continuation: "Foreground experiment only; no automatic retry or wake registration. Inspect this result before another explicit run."};
    const descriptor = worker.wakeRegistration(session, generation);
    descriptor.specYaml = JSON.stringify({target: {session}, message: `Run ${JSON.stringify(nextCommand)} as an argument vector, read the exact eligible stream items with rig stream show, then supply source-bound decisions to rig project wake with these same options plus --decisions. One bounded wake only; honor returned nextWakeAt. Never change evidence epoch without owner authorization.`});
    wakeRequest = descriptor;
  } catch { /* no acquired lease */ }
  return {occupant: snapshot.occupant, candidateSetVersion: candidates.version, evidenceEpoch: opts.evidenceEpoch,
    result, nextCommand, wakeRequest, registered: false, sourceSnapshot: snapshot};
}
