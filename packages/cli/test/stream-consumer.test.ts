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

/** A fake daemon: worker sources, the attempt ledger, classification with dispositions, and queue effects. */
function daemon(items: string[] = ["S1"], opts: { createStatus?: number[]; noted?: boolean } = {}) {
  const lease = { leaseId: "lease-1", classifierSession: "intake@rig", state: "active", acquiredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() };
  const done = new Set<string>(), classified: Record<string, any>[] = [], failed: Record<string, any>[] = [], abstained: unknown[] = [];
  const dispositions = new Map<string, Record<string, any>>(), creates: Record<string, any>[] = [], notes: Record<string, any>[] = [];
  const createStatus = [...(opts.createStatus ?? [])];
  const route = (url: string) => url.split("?")[0]!;
  const get = async (url: string) => {
    const path = route(url);
    if (path === "/api/projects/worker-sources") return { status: 200, data: { occupant: { session: "intake@rig", nodeId: "n1", generation: "g1", rigId: "rig" },
      version: "v", observedAt: "t", unavailable: [], sources: { project: {}, scopes: [], roster: [], recent: [] }, routing: ROUTING, routingVersion: "rv" } };
    if (path === "/api/projects/eligible") return { status: 200, data: { items: items.filter(i => !done.has(i)).map(streamItemId => ({ streamItemId })), nextAfterSortKey: null } };
    if (path === "/api/projects/lease") return { status: 200, data: lease };
    if (path.startsWith("/api/stream/")) { const id = path.split("/").pop()!; return { status: 200, data: { streamItemId: id, sourceSession: "poster@rig", body: `The queue test ${id} is flaky again\nmore detail`, hintTags: ["tests"] } }; }
    if (path === "/api/projects/dispositions/unapplied") return { status: 200, data: [...dispositions.values()].filter(d => !d.applied) };
    if (path === "/api/queue/q-1/transitions") return { status: 200, data: opts.noted ? [{ transitionNote: "Joined stream S1 (routed by intake@rig)." }] : [] };
    if (path.startsWith("/api/queue/") && path.endsWith("/transitions")) return { status: 404, data: { error: "qitem_not_found" } };
    throw Error(`unexpected GET ${url}`);
  };
  const post = async (url: string, body: any) => {
    const path = route(url);
    if (path === "/api/projects/lease/acquire" || path === "/api/projects/lease/heartbeat") return { status: 200, data: lease };
    if (path === "/api/projects/attempts/begin") return { status: 201, data: { ...body, attemptId: `a-${body.streamItemId}`, executionId: `x-${body.streamItemId}`, status: "in_flight" } };
    if (path.endsWith("/fail")) { failed.push(body); return { status: 200, data: { status: "error", reason: body.reason } }; }
    if (path.endsWith("/abstain")) { abstained.push(body); return { status: 200, data: { status: "abstained" } }; }
    if (path === "/api/projects/project") { classified.push(body); done.add(body.streamItemId); if (body.disposition) dispositions.set(body.streamItemId, { ...body.disposition, streamItemId: body.streamItemId }); return { status: 201, data: body }; }
    if (path.startsWith("/api/projects/dispositions/") && path.endsWith("/applied")) { const d = dispositions.get(path.split("/")[4]!)!; d.applied = body.applied; return { status: 200, data: d }; }
    if (path === "/api/queue/create") { const status = createStatus.shift() ?? 201; if (status < 300) creates.push(body); return { status, data: status === 409 ? { error: "qitem_id_reuse" } : body }; }
    if (path === "/api/queue/q-1/update") { notes.push(body); return { status: 200, data: {} }; }
    throw Error(`unexpected POST ${url}`);
  };
  return { client: { get, post } as never, classified, failed, abstained, dispositions, creates, notes, done };
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
const wake = (d: ReturnType<typeof daemon>, send: ReturnType<typeof provider>) =>
  runDecideWake(d.client, OPTS, new DecisionRun({ consumer: "stream", settings: () => ON, env: { OPENROUTER_API_KEY: "synthetic" }, send }), () => TAXONOMY);

describe("stream consumer in the intake turn", () => {
  it("create: accepts the judgment with the exact request, then creates the owner's row once", async () => {
    const d = daemon(), send = provider({ disposition: "create", owner: "dev-lead@rig" });
    const out = await wake(d, send);
    expect(d.classified).toHaveLength(1);
    const c = d.classified[0]!;
    expect(c).toMatchObject({ streamItemId: "S1", classificationDestination: "dev-lead@rig", action: "create",
      disposition: { disposition: "create", ownerSession: "dev-lead@rig", effect: { operation: "create", qitemId: "qitem-stream-S1", destination: "dev-lead@rig" },
        templateDigest: expect.stringMatching(/^sha256:/), templateText: expect.stringContaining("name: stream"), provenance: { generationId: "gen-1", answers: { disposition: { choice: "create" } } } } });
    expect(c.disposition.request).toBe(String(send.mock.calls[0]![1]!.body));
    expect(d.creates).toEqual([expect.objectContaining({ qitemId: "qitem-stream-S1", destinationSession: "dev-lead@rig", tags: ["stream-routed", "stream:S1"],
      body: expect.stringContaining("rig stream show S1") })]);
    expect(d.creates[0]!.body).not.toContain("more detail"); // a pointer and a size, not the observation pasted in
    expect(out.decisions).toMatchObject({ calls: 1, applied: [{ streamItemId: "S1", outcome: "created" }], forIntake: [] });
    expect(d.failed).toEqual([]); expect(d.abstained).toEqual([]);
  });

  it("join notes the chosen work once; a repeat finds its marker and doesn't note again", async () => {
    const d = daemon(), out = await wake(d, provider({ disposition: "join", work: "q-1" }));
    expect(d.classified[0]).toMatchObject({ classificationDestination: "qa-one@rig", disposition: { workQitemId: "q-1", effect: { operation: "note", qitemId: "q-1" } } });
    expect(d.notes).toEqual([{ transitionNote: expect.stringContaining("Joined stream S1") }]);
    expect(out.decisions.applied).toMatchObject([{ outcome: "noted" }]);
    const again = daemon([], { noted: true });
    again.dispositions.set("S1", { streamItemId: "S1", disposition: "join", workQitemId: "q-1", effect: { operation: "note", qitemId: "q-1", destination: null } });
    expect((await wake(again, provider({}))).decisions.applied).toMatchObject([{ outcome: "already_noted" }]);
    expect(again.notes).toEqual([]);
  });

  it("duplicate and no_action are recorded with no queue effect", async () => {
    const d = daemon(["S1", "S2"]);
    const send = vi.fn().mockImplementationOnce(provider({ disposition: "duplicate", work: "q-1" })).mockImplementationOnce(provider({ disposition: "no_action" }));
    const out = await wake(d, send as never);
    expect(d.classified.map(c => [c.action, c.disposition.effect.operation, c.disposition.workQitemId])).toEqual([["duplicate", "none", "q-1"], ["no_action", "none", null]]);
    expect([d.creates, d.notes]).toEqual([[], []]);
    expect(out.decisions.applied).toMatchObject([{ operation: "none", disposition: "duplicate" }, { operation: "none", disposition: "no_action" }]);
  });

  it.each<[string, ReturnType<typeof provider>, RegExp]>([
    ["an uncertain disposition", provider({}), /decision abstained \(unknown: disposition\)/],
    ["a provider error", provider({}, 503), /decision failed \(HTTP 503\)/],
    ["create with no supplied owner", provider({ disposition: "create", owner: "pool" }), /create without a supplied owner/],
    ["join with no supplied work", provider({ disposition: "join" }), /join without a supplied work item/],
  ])("%s stays with intake: a retryable failure, never a terminal abstention", async (_n, send, reason) => {
    const d = daemon(), out = await wake(d, send);
    expect(d.classified).toEqual([]); expect(d.abstained).toEqual([]);
    expect(d.failed).toEqual([expect.objectContaining({ reason: expect.stringMatching(reason) })]);
    expect(out.decisions.forIntake).toEqual([expect.objectContaining({ streamItemId: "S1", read: "rig stream show S1" })]);
  });

  it("recovers an accepted but unapplied effect from an earlier wake without deciding again", async () => {
    const d = daemon([]), send = provider({});
    d.dispositions.set("S0", { streamItemId: "S0", disposition: "create", ownerSession: "dev-lead@rig", workQitemId: null,
      effect: { operation: "create", qitemId: "qitem-stream-S0", destination: "dev-lead@rig" }, templateDigest: "sha256:" + "b".repeat(64), provenance: { requestedModel: JEV_MODEL } });
    const out = await wake(d, send);
    expect(send).not.toHaveBeenCalled();
    expect(d.creates).toEqual([expect.objectContaining({ qitemId: "qitem-stream-S0" })]);
    expect(out.decisions.applied).toMatchObject([{ streamItemId: "S0", outcome: "created" }]);
  });

  it("an unknown create outcome isn't recorded, and the next wake retries the same id; a reused id is a conflict", async () => {
    const d = daemon(["S1"], { createStatus: [500, 201] });
    const first = await wake(d, provider({ disposition: "create", owner: "dev-lead@rig" }));
    expect(first.decisions.applied).toMatchObject([{ streamItemId: "S1", outcome: "unknown", retry: "next wake, same effect" }]);
    expect(d.dispositions.get("S1")!.applied).toBeUndefined();
    const second = await wake(d, provider({}));
    expect(second.decisions.applied).toMatchObject([{ streamItemId: "S1", outcome: "created" }]);
    expect(d.creates.map(c => c.qitemId)).toEqual(["qitem-stream-S1"]);
    const reused = daemon(["S1"], { createStatus: [409] });
    expect((await wake(reused, provider({ disposition: "create", owner: "dev-lead@rig" }))).decisions.applied)
      .toMatchObject([{ outcome: "conflict", detail: "qitem_id_reuse" }]);
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
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ decisions: { status: "not_called", reason: "disabled" }, status: { state: "no_call" } });
    expect(send).not.toHaveBeenCalled();
  });
});
