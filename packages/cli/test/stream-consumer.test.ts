import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DecisionRun, type DecisionsSettings } from "../src/decisions/decisions.js";
import { runDecideWake, streamRequest } from "../src/decisions/stream-consumer.js";
import { JEV_MODEL } from "../src/commands/project-jev.js";
import { projectCommand, type ProjectDeps } from "../src/commands/project.js";

vi.mock("../src/daemon-lifecycle.js", () => ({ getDaemonStatus: async () => ({ running: true }), daemonStatusGuard: () => true, getDaemonUrl: () => "http://offline.invalid" }));
vi.mock("../src/commands/daemon.js", () => ({ realDeps: () => { throw Error("real lifecycle forbidden"); } }));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

const ON: DecisionsSettings = { enabled: true, consumers: "stream", templateDir: "" };
const TAXONOMY = `version: v1\nfields:\n${["kind", "urgency", "maturity", "area"].map(k => `  ${k}:\n    question: "Which ${k}?"\n    values: { chosen: meaning }`).join("\n")}\n`;
const OPTS = { project: "FIX", taxonomy: "taxonomy.yaml", classifierVersion: "decisions-v1", evidenceEpoch: "e1", limit: "5" };
const ROUTING = {
  owners: [{ session: "dev-lead@rig", logicalId: "dev.lead", role: "Owns the build pod's work" }, { session: "qa-one@rig", logicalId: "qa.one", role: null }],
  ownersTruncated: false, work: [{ qitemId: "q-1", destination: "qa-one@rig", state: "in-progress", summary: "Fix the flaky queue test" }], workTruncated: false,
};
type Rec = Record<string, any>;

/** A fake daemon: worker sources, the attempt ledger, classifications and deferrals, the lease, and queue effects. */
function daemon(items: string[] = ["S1"], opts: { dispositionStatus?: number; createStatus?: number[]; notes?: string[]; workState?: string; work?: Rec[]; leaseLost?: boolean; rows?: Record<string, Rec> } = {}) {
  const lease = { leaseId: "lease-1", classifierSession: "intake@rig", state: "active", acquiredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() };
  const done = new Set<string>(), classified: Rec[] = [], failed: Rec[] = [], abstained: Rec[] = [], applied: { url: string; body: Rec }[] = [];
  const dispositions = new Map<string, Rec>(), creates: Rec[] = [], notes: Rec[] = [], rows: Record<string, Rec> = { ...(opts.rows ?? {}) };
  const createStatus = [...(opts.createStatus ?? [])];
  let leaseChecks = 0, applying = false;
  const route = (url: string) => url.split("?")[0]!;
  const get = async (url: string) => {
    const path = route(url);
    if (path === "/api/projects/worker-sources") return { status: 200, data: { occupant: { session: "intake@rig", nodeId: "n1", generation: "g1", rigId: "rig" },
      version: "v", observedAt: "t", unavailable: [], sources: { project: {}, scopes: [], roster: [], recent: [] }, routing: { ...ROUTING, work: opts.work ?? ROUTING.work }, routingVersion: "rv" } };
    if (path === "/api/projects/eligible") return { status: 200, data: { items: items.filter(i => !done.has(i)).map(streamItemId => ({ streamItemId })), nextAfterSortKey: null } };
    if (path === "/api/projects/lease") {
      if (url.includes("expectedLeaseId") && applying) { leaseChecks++; if (opts.leaseLost) return { status: 409, data: { error: "lease_mismatch" } }; }
      return { status: 200, data: lease };
    }
    if (path.startsWith("/api/stream/")) { const id = path.split("/").pop()!; return { status: 200, data: { streamItemId: id, sourceSession: "poster@rig", body: `The queue test ${id} is flaky again\nmore detail`, hintTags: ["tests"] } }; }
    if (path === "/api/projects/dispositions/unapplied") { applying = true; return { status: 200, data: [...dispositions.values()].filter(d => !d.applied && d.disposition !== "deferred") }; }
    if (path.startsWith("/api/projects/dispositions/")) { if (opts.dispositionStatus) return { status: opts.dispositionStatus, data: { error: "lookup_unavailable" } }; const d = dispositions.get(path.split("/")[4]!); return d ? { status: 200, data: d } : { status: 404, data: { error: "disposition_not_found" } }; }
    if (path === "/api/queue/q-1") return { status: 200, data: { qitemId: "q-1", state: opts.workState ?? "in-progress" } };
    if (path === "/api/queue/q-1/transitions") return { status: 200, data: (opts.notes ?? []).map(transitionNote => ({ transitionNote })) };
    if (path.startsWith("/api/queue/")) { const row = rows[decodeURIComponent(path.split("/")[3]!)]; return row ? { status: 200, data: row } : { status: 404, data: { error: "qitem_not_found" } }; }
    throw Error(`unexpected GET ${url}`);
  };
  const post = async (url: string, body: any) => {
    const path = route(url);
    if (path === "/api/projects/lease/acquire" || path === "/api/projects/lease/heartbeat") return { status: 200, data: lease };
    if (path === "/api/projects/attempts/begin") return { status: 201, data: { ...body, attemptId: `a-${body.streamItemId}`, executionId: `x-${body.streamItemId}`, status: "in_flight" } };
    if (path.endsWith("/fail")) { failed.push(body); return { status: 200, data: { status: "error", reason: body.reason } }; }
    if (path.endsWith("/abstain")) {
      abstained.push(body); const id = String(body.attemptId).slice(2); done.add(id);
      if (body.disposition) dispositions.set(id, { ...body.disposition, streamItemId: id, acceptedBy: "intake@rig", applied: { outcome: "deferred_to_intake" } });
      return { status: 200, data: { status: "abstained", streamItemId: id } };
    }
    if (path === "/api/projects/project") { classified.push(body); done.add(body.streamItemId); if (body.disposition) dispositions.set(body.streamItemId, { ...body.disposition, streamItemId: body.streamItemId, acceptedBy: "intake@rig" }); return { status: 201, data: body }; }
    if (path.startsWith("/api/projects/dispositions/") && path.endsWith("/applied")) { applied.push({ url, body }); const d = dispositions.get(path.split("/")[4]!)!; d.applied = body.applied; return { status: 200, data: d }; }
    if (path === "/api/queue/create") {
      const status = createStatus.shift() ?? 201;
      if (status < 300) { creates.push(body); rows[body.qitemId] = { qitemId: body.qitemId, destinationSession: body.destinationSession, sourceSession: "intake@rig", tags: body.tags, state: "pending" }; }
      return { status, data: status === 409 ? { error: "qitem_id_reuse" } : body };
    }
    if (path === "/api/queue/q-1/update") { notes.push(body); return { status: 200, data: {} }; }
    throw Error(`unexpected POST ${url}`);
  };
  return { client: { get, post } as never, classified, failed, abstained, applied, dispositions, creates, notes, rows, done, leaseChecks: () => leaseChecks };
}

function provider(choices: Record<string, string>, status = 200) {
  return vi.fn(async (_u: unknown, init?: RequestInit) => {
    if (status !== 200) return new Response("down", { status });
    const questions = JSON.parse(String(init!.body)).questions as Record<string, { criteria: Record<string, string> }>;
    return Response.json({ id: "gen-1", model: JEV_MODEL + "-20260917", provider: "TypeSafe", usage: { input_tokens: 1, output_tokens: 1, cost: 0.00001 },
      answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
        const choice = choices[id] ?? "__unknown__";
        return [id, { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
      })) });
  });
}
const decisionRun = (send: ReturnType<typeof provider>, maxCalls = 20) =>
  new DecisionRun({ consumer: "stream", settings: () => ON, env: { OPENROUTER_API_KEY: "synthetic" }, send, budget: { maxCalls } });
const wake = (d: ReturnType<typeof daemon>, send: ReturnType<typeof provider>, maxCalls?: number) => runDecideWake(d.client, OPTS, decisionRun(send, maxCalls), () => TAXONOMY);
const acceptedCreate = (by: string) => ({ streamItemId: "S0", disposition: "create", acceptedBy: by, ownerSession: "dev-lead@rig", workQitemId: null,
  effect: { operation: "create", qitemId: "qitem-stream-S0", destination: "dev-lead@rig" }, templateDigest: "sha256:" + "b".repeat(64), provenance: { requestedModel: JEV_MODEL } });

describe("stream consumer in the intake turn", () => {
  it("create: accepts the judgment with the exact request, then creates the owner's row once", async () => {
    const d = daemon(), send = provider({ disposition: "create", owner: "dev-lead@rig" });
    const out = await wake(d, send);
    const c = d.classified[0]!;
    expect(c.classifierVersion).toMatch(/^decisions-v1\+decide:[0-9a-f]{12}$/);
    expect(c).toMatchObject({ streamItemId: "S1", classificationDestination: "dev-lead@rig", action: "create",
      disposition: { disposition: "create", ownerSession: "dev-lead@rig", effect: { operation: "create", qitemId: "qitem-stream-S1", destination: "dev-lead@rig" },
        templateDigest: expect.stringMatching(/^sha256:/), templateText: expect.stringContaining("name: stream"), provenance: { generationId: "gen-1", answers: { disposition: { choice: "create" } } } } });
    expect(c.disposition.request).toBe(String(send.mock.calls[0]![1]!.body));
    expect(d.creates).toEqual([expect.objectContaining({ qitemId: "qitem-stream-S1", destinationSession: "dev-lead@rig", tags: ["stream-routed", "stream:S1"],
      body: expect.stringContaining("rig stream show S1") })]);
    expect(d.creates[0]!.body).not.toContain("more detail"); // a pointer and a size, not the observation pasted in
    expect(out.decisions).toMatchObject({ automaticClassifierVersion: c.classifierVersion, calls: 1, applied: [{ streamItemId: "S1", outcome: "created" }], forIntake: [], notAttempted: [] });
    // The applied record carries the wake's lease and occupant, checked before the effect.
    expect(d.applied).toEqual([{ url: expect.stringContaining("expectedOccupant=g1"), body: expect.objectContaining({ leaseId: "lease-1" }) }]);
    expect(d.leaseChecks()).toBe(1);
  });

  it("join notes the chosen work once, matching its marker exactly", async () => {
    const d = daemon(), out = await wake(d, provider({ disposition: "join", work: "q-1" }));
    expect(d.classified[0]).toMatchObject({ classificationDestination: "qa-one@rig", disposition: { workQitemId: "q-1", effect: { operation: "note", qitemId: "q-1" } } });
    expect(d.notes).toEqual([expect.objectContaining({ transitionNote: expect.stringContaining("Joined [stream-join:S1]") })]);
    expect(out.decisions.applied).toMatchObject([{ outcome: "noted" }]);
    const joined = { disposition: "join", workQitemId: "q-1", acceptedBy: "intake@rig", effect: { operation: "note", qitemId: "q-1", destination: null } };
    // S10's marker and an incidental mention don't count; the exact marker does.
    const near = daemon([], { notes: ["Joined [stream-join:S10] (routed by intake@rig).", "see [stream-join:S1] for context"] });
    near.dispositions.set("S1", { streamItemId: "S1", ...joined });
    expect((await wake(near, provider({}))).decisions.applied).toMatchObject([{ outcome: "noted" }]);
    const again = daemon([], { notes: ["Joined [stream-join:S1] (routed by intake@rig)."] });
    again.dispositions.set("S1", { streamItemId: "S1", ...joined });
    expect((await wake(again, provider({}))).decisions.applied).toMatchObject([{ outcome: "already_noted" }]);
    expect(again.notes).toEqual([]);
  });

  it("join doesn't note a work row that was closed or handed off since the candidates were read", async () => {
    const d = daemon(["S1"], { workState: "handed-off" }), out = await wake(d, provider({ disposition: "join", work: "q-1" }));
    expect(out.decisions.applied).toMatchObject([{ outcome: "target_closed", state: "handed-off" }]);
    expect(out.decisions.forIntake).toMatchObject([{ outcome: "target_closed", read: "rig stream show S1" }]);
    expect(d.notes).toEqual([]);
  });

  it("duplicate needs a supplied work item: with one it's recorded; with an unknown one, or no work at all, it's deferred", async () => {
    const d = daemon(["S1", "S2"]);
    const send = vi.fn().mockImplementationOnce(provider({ disposition: "duplicate", work: "q-1" })).mockImplementationOnce(provider({ disposition: "no_action" }));
    const out = await wake(d, send as never);
    expect(d.classified.map(c => [c.action, c.disposition.effect.operation, c.disposition.workQitemId])).toEqual([["duplicate", "none", "q-1"], ["no_action", "none", null]]);
    expect(out.decisions.applied).toMatchObject([{ operation: "none", disposition: "duplicate" }, { operation: "none", disposition: "no_action" }]);
    for (const [work, choices] of [[undefined, { disposition: "duplicate", work: "__unknown__" }], [[], { disposition: "duplicate" }]] as const) {
      const e = daemon(["S1"], { work: work as Rec[] | undefined }), res = await wake(e, provider(choices));
      expect(e.classified).toEqual([]);
      expect(e.dispositions.get("S1")).toMatchObject({ disposition: "deferred", reason: expect.stringContaining("duplicate without a supplied work item") });
      expect(res.decisions.forIntake).toMatchObject([{ streamItemId: "S1", status: "abstained" }]);
    }
  });

  it.each<[string, ReturnType<typeof provider>, RegExp, string]>([
    ["an uncertain disposition", provider({}), /decision abstained \(unknown: disposition\)/, "abstained"],
    ["create with no supplied owner", provider({ disposition: "create", owner: "pool" }), /create without a supplied owner/, "answered"],
    ["join with no supplied work", provider({ disposition: "join" }), /join without a supplied work item/, "answered"],
    ["a provider error", provider({}, 503), /decision failed \(HTTP 503\)/, "failed"],
  ])("%s is deferred to intake with its structured result, abstained only for the automatic identity", async (_n, send, reason, status) => {
    const d = daemon(), out = await wake(d, send);
    expect(d.classified).toEqual([]); expect(d.failed).toEqual([]);
    expect(d.abstained).toEqual([expect.objectContaining({ reason: expect.stringMatching(reason),
      disposition: expect.objectContaining({ disposition: "deferred", effect: { operation: "none", qitemId: null, destination: null },
        request: String(send.mock.calls[0]![1]!.body), templateText: expect.stringContaining("name: stream"), result: expect.objectContaining({ status }) }) })]);
    expect(out.decisions.forIntake).toEqual([expect.objectContaining({ streamItemId: "S1", reason: expect.stringMatching(reason), read: "rig stream show S1" })]);
    expect(out.continuation).toContain("--classifier-version");
  });

  it("an item intake already has (a deferral from an earlier template) isn't sent again", async () => {
    const d = daemon(), send = provider({ disposition: "create", owner: "dev-lead@rig" });
    d.dispositions.set("S1", { streamItemId: "S1", disposition: "deferred", applied: { outcome: "deferred_to_intake" } });
    const out = await wake(d, send);
    expect(send).not.toHaveBeenCalled();
    expect(d.abstained).toEqual([expect.not.objectContaining({ disposition: expect.anything() })]);
    expect(out.decisions.forIntake).toMatchObject([{ streamItemId: "S1", reason: expect.stringContaining("already deferred") }]);
  });

  it.each([204, 403, 503])("a disposition lookup HTTP %s stops the wake without re-asking an earlier deferral", async status => {
    const d = daemon(["S1", "S2"], { dispositionStatus: status }), send = provider({ disposition: "create", owner: "dev-lead@rig" });
    const previous = { streamItemId: "S1", disposition: "deferred", applied: { outcome: "deferred_to_intake" } };
    d.dispositions.set("S1", structuredClone(previous));
    const out = await wake(d, send);
    expect(send).not.toHaveBeenCalled();
    expect([...d.dispositions.values()]).toEqual([previous]);
    expect([d.classified, d.abstained, d.creates, d.notes]).toEqual([[], [], [], []]);
    expect(out.result).toMatchObject({ state: "stopped", outcomes: [{ streamItemId: "S1", status: "error" }] });
    expect(out.decisions.notAttempted).toMatchObject([{ streamItemId: "S1", reason: `not attempted: disposition lookup HTTP ${status}` }]);
    expect([...d.done]).toEqual([]);
  });

  it("when the run stops before sending (budget), the wake stops and the rest stay eligible, not deferred", async () => {
    const d = daemon(["S1", "S2", "S3"]), out = await wake(d, provider({ disposition: "no_action" }), 1);
    expect(d.classified.map(c => c.streamItemId)).toEqual(["S1"]);
    expect(d.failed).toEqual([expect.objectContaining({ reason: expect.stringContaining("not attempted (budget_spent") })]);
    expect([...d.dispositions.values()].some(x => x.disposition === "deferred")).toBe(false);
    expect(out.decisions.notAttempted).toMatchObject([{ streamItemId: "S2", status: "error" }]);
    expect(d.done.has("S3")).toBe(false); // never begun
  });

  it("stops applying effects when the wake's lease is no longer held", async () => {
    const d = daemon(["S1"], { leaseLost: true }), out = await wake(d, provider({ disposition: "create", owner: "dev-lead@rig" }));
    expect(d.creates).toEqual([]); expect(d.applied).toEqual([]);
    expect(out.decisions.applied).toMatchObject([{ outcome: "stopped" }]);
    expect(d.dispositions.get("S1")!.applied).toBeUndefined();
  });

  it("recovers an accepted effect from an earlier wake without deciding again", async () => {
    const d = daemon([]), send = provider({});
    d.dispositions.set("S0", acceptedCreate("intake@rig"));
    const out = await wake(d, send);
    expect(send).not.toHaveBeenCalled();
    expect(d.creates).toEqual([expect.objectContaining({ qitemId: "qitem-stream-S0" })]);
    expect(out.decisions.applied).toMatchObject([{ streamItemId: "S0", outcome: "created" }]);
  });

  it("a different holder reconciles the accepted row if it exists, and otherwise hands the item to intake; it never creates as another seat", async () => {
    const committed = daemon([], { rows: { "qitem-stream-S0": { destinationSession: "dev-lead@rig", sourceSession: "old-intake@rig", tags: ["stream-routed", "stream:S0"] } } });
    committed.dispositions.set("S0", acceptedCreate("old-intake@rig"));
    expect((await wake(committed, provider({}))).decisions.applied).toMatchObject([{ streamItemId: "S0", outcome: "existing" }]);
    expect(committed.creates).toEqual([]);
    const absent = daemon([]);
    absent.dispositions.set("S0", acceptedCreate("old-intake@rig"));
    const out = await wake(absent, provider({}));
    expect(out.decisions.applied).toMatchObject([{ outcome: "handed_to_intake", reason: expect.stringContaining("accepted by old-intake@rig"), evidence: { row: "absent" } }]);
    expect(out.decisions.forIntake).toMatchObject([{ streamItemId: "S0", outcome: "handed_to_intake" }]);
    expect(absent.creates).toEqual([]);
  });

  it("a refused derived id is reconciled when the row is the accepted effect, and otherwise handed to intake with evidence", async () => {
    const mine = daemon(["S1"], { createStatus: [409], rows: { "qitem-stream-S1": { destinationSession: "dev-lead@rig", sourceSession: "intake@rig", tags: ["stream:S1"] } } });
    expect((await wake(mine, provider({ disposition: "create", owner: "dev-lead@rig" }))).decisions.applied).toMatchObject([{ outcome: "existing" }]);
    const other = daemon(["S1"], { createStatus: [409], rows: { "qitem-stream-S1": { destinationSession: "dev-lead@rig", sourceSession: "x@rig", tags: ["stream:S1"] } } });
    expect((await wake(other, provider({ disposition: "create", owner: "dev-lead@rig" }))).decisions.applied)
      .toMatchObject([{ outcome: "handed_to_intake", evidence: { destination: "dev-lead@rig", source: "x@rig" } }]);
  });

  it("an unknown create outcome isn't recorded, and the next wake retries the same id", async () => {
    const d = daemon(["S1"], { createStatus: [500, 201] });
    const first = await wake(d, provider({ disposition: "create", owner: "dev-lead@rig" }));
    expect(first.decisions.applied).toMatchObject([{ streamItemId: "S1", outcome: "unknown", retry: "next wake, same effect" }]);
    expect(d.dispositions.get("S1")!.applied).toBeUndefined();
    expect((await wake(d, provider({}))).decisions.applied).toMatchObject([{ streamItemId: "S1", outcome: "created" }]);
    expect(d.creates.map(c => c.qitemId)).toEqual(["qitem-stream-S1"]);
  });

  it("bounds what it sends: at most 49 owners plus pool, a capped body, and truncation stated", () => {
    const owners = Array.from({ length: 60 }, (_, i) => ({ session: `s${i}@rig`, logicalId: `s.${i}`, role: null }));
    const { state, options } = streamRequest({ streamItemId: "S1", sourceSession: "p@rig", body: "x".repeat(5000) }, { ...ROUTING, owners });
    expect(Object.keys(options.owners)).toHaveLength(50);
    expect(options.owners.pool).toBeDefined();
    expect([state.observation.body.length, state.observation.bodyTruncated, state.ownersTruncated]).toEqual([4000, true, true]);
  });

  it("rig project wake --decide with decisions off prints the status and starts nothing", async () => {
    const out: string[] = []; vi.spyOn(console, "log").mockImplementation(x => { out.push(String(x)); });
    const send = vi.fn();
    await new Command().addCommand(projectCommand({ lifecycleDeps: {}, clientFactory: () => { throw Error("daemon forbidden"); },
      decisionsSettings: () => ({ ...ON, enabled: false }), experimentEnv: {}, experimentFetch: send } as ProjectDeps))
      .parseAsync(["project", "wake", "--project", "FIX", "--taxonomy", "t", "--classifier-version", "v", "--evidence-epoch", "e", "--decide"], { from: "user" });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ decisions: { status: "not_called", reason: "disabled" }, status: { state: "no_call" },
      recovered: [{ outcome: "skipped", reason: expect.stringContaining("daemon forbidden") }] });
    expect(send).not.toHaveBeenCalled();
  });

  it("decisions turned off after an answer was accepted: the next --decide asks nothing and still applies the effect", async () => {
    const d = daemon(["S1"], { createStatus: [500] });
    expect((await wake(d, provider({ disposition: "create", owner: "dev-lead@rig" }))).decisions.applied).toMatchObject([{ streamItemId: "S1", outcome: "unknown" }]);
    expect(d.creates).toEqual([]);
    const out: string[] = []; vi.spyOn(console, "log").mockImplementation(x => { out.push(String(x)); });
    const send = vi.fn();
    await new Command().addCommand(projectCommand({ lifecycleDeps: {}, clientFactory: () => d.client,
      decisionsSettings: () => ({ ...ON, enabled: false }), experimentEnv: {}, experimentFetch: send } as ProjectDeps))
      .parseAsync(["project", "wake", "--project", "FIX", "--taxonomy", "t", "--classifier-version", "v", "--evidence-epoch", "e", "--decide"], { from: "user" });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ decisions: { reason: "disabled" }, recovered: [{ streamItemId: "S1", outcome: "created" }] });
    expect(d.creates.map(c => c.qitemId)).toEqual(["qitem-stream-S1"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks the daemon to leave out items abstained under another version", async () => {
    const d = daemon(["S1"]);
    const urls: string[] = [];
    const get = (d.client as { get: (u: string) => Promise<unknown> }).get;
    (d.client as { get: (u: string) => Promise<unknown> }).get = async (u: string) => { urls.push(u); return get(u); };
    await wake(d, provider({ disposition: "no_action" }));
    expect(urls.filter(u => u.startsWith("/api/projects/eligible")).every(u => u.includes("excludeAbstainedElsewhere=1"))).toBe(true);
    expect(urls.some(u => u.startsWith("/api/projects/eligible"))).toBe(true);
  });
});
