import { describe, expect, it, vi } from "vitest";
import { streamOutcome } from "../src/commands/stream-outcome.js";
import { createProgram } from "../src/index.js";
import type { StreamDeps } from "../src/commands/stream.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return { ...actual, getDaemonStatus: async () => ({ state: "running", healthy: true, port: 8444 }), daemonStatusGuard: () => true,
    getDaemonUrl: () => "http://stream-outcome.test" };
});

type Reply = { status: number; data: unknown };
/** A read-only fake daemon keyed by path; anything unlisted is a 404 with the route's own code. */
function client(routes: Record<string, Reply>) {
  return { get: vi.fn(async (url: string) => routes[url.split("&limit")[0]!] ?? routes[url] ??
    (url.includes("/dispositions/") ? { status: 404, data: { error: "disposition_not_found" } }
      : url.includes("/api/projects/list") ? { status: 200, data: [] } : { status: 404, data: { error: "qitem_not_found" } })) };
}
const DISP = "/api/projects/dispositions/S1", LIST = "/api/projects/list?streamItemId=S1";
const disposition = (over: Record<string, unknown>) => ({ status: 200, data: { disposition: "create", acceptedBy: "intake@rig", acceptedAt: "t1",
  ownerSession: "dev-lead@rig", workQitemId: null, effect: { operation: "create", qitemId: "qitem-stream-S1" }, reason: null, appliedAt: "t2",
  applied: { operation: "create", outcome: "created" }, ...over } });
const classified = (over: Record<string, unknown> = {}) => ({ status: 200, data: [{ streamItemId: "S1", classifierSession: "intake@rig",
  classificationDestination: "dev-lead@rig", action: "create", classifierVersion: "intake-v1+decide:0123456789ab", tsProjected: "t1", ...over }] });
const row = (state: string, over: Record<string, unknown> = {}) => ({ status: 200, data: { qitemId: "qitem-stream-S1", destinationSession: "dev-lead@rig",
  state, closureReason: null, closureTarget: null, resolution: null, evidenceRef: null, tsUpdated: "t3", ...over } });

describe("what became of a stream observation", () => {
  it("nothing recorded yet: awaiting intake", async () => {
    expect(await streamOutcome(client({}), "S1")).toMatchObject({ stage: "awaiting_intake" });
  });

  it("deferred by the automatic path, then decided by intake", async () => {
    const deferred = disposition({ disposition: "deferred", reason: "decision abstained (unknown: disposition); intake decides", effect: { operation: "none", qitemId: null },
      appliedAt: "t1", applied: { outcome: "deferred_to_intake" } });
    expect(await streamOutcome(client({ [DISP]: deferred }), "S1")).toMatchObject({ stage: "deferred_to_intake",
      summary: expect.stringContaining("hasn't recorded a decision"), deferred: { reason: expect.stringContaining("unknown: disposition") } });
    expect(await streamOutcome(client({ [DISP]: deferred, [LIST]: classified({ classifierVersion: "intake-v1", classifierSession: "intake-agent@rig" }) }), "S1"))
      .toMatchObject({ stage: "decided_by_intake", classification: { by: "intake-agent@rig", path: "intake" }, deferred: { at: "t1" } });
  });

  it("a classification written by the advisory experiment is labelled so, not as intake's", async () => {
    expect(await streamOutcome(client({ [LIST]: classified({ classifierVersion: "v1+experiment", classifierSession: "intake-agent@rig" }) }), "S1"))
      .toMatchObject({ stage: "decided_by_intake", classification: { path: "experiment" }, summary: expect.stringMatching(/^An advisory experiment run by intake-agent@rig recorded/) });
  });

  it("create: the opened row's owner and state, and a closed row's reported outcome with the caveat", async () => {
    expect(await streamOutcome(client({ [DISP]: disposition({}), [LIST]: classified(), "/api/queue/qitem-stream-S1": row("in-progress") }), "S1"))
      .toMatchObject({ stage: "work_open", accepted: { by: "intake@rig" }, classification: { path: "automatic" },
        work: [{ qitemId: "qitem-stream-S1", owner: "dev-lead@rig", state: "in-progress" }] });
    const closed = await streamOutcome(client({ [DISP]: disposition({}), "/api/queue/qitem-stream-S1":
      row("done", { closureReason: "no-follow-on", resolution: "Fixed the flaky wait in #1886", evidenceRef: "pr-1886" }) }), "S1");
    expect(closed).toMatchObject({ stage: "work_closed", work: [{ state: "done", closure: "no-follow-on", resolution: "Fixed the flaky wait in #1886", evidence: "pr-1886" }],
      note: expect.stringContaining("isn't proof that a fix shipped") });
    const moved = await streamOutcome(client({ [DISP]: disposition({}), "/api/queue/qitem-stream-S1": row("pending", { destinationSession: "qa-one@rig" }) }), "S1");
    expect(moved.summary).toContain("now with qa-one@rig");
  });

  it("a handed-on or superseded row is followed to the row holding the work now", async () => {
    const S1 = "/api/queue/qitem-stream-S1", NEXT = "/api/queue/list?handedOffFrom=";
    const handed = row("handed-off", { closureReason: "handed_off_to", closureTarget: "qa-one@rig" });
    const open = await streamOutcome(client({ [DISP]: disposition({}), [S1]: handed,
      [`${NEXT}qitem-stream-S1`]: { status: 200, data: [{ qitemId: "q-2", handedOffFrom: "qitem-stream-S1" }] },
      "/api/queue/q-2": row("in-progress", { qitemId: "q-2", destinationSession: "qa-one@rig" }) }), "S1");
    expect(open).toMatchObject({ stage: "work_open", work: [{ qitemId: "q-2", owner: "qa-one@rig", state: "in-progress", handedOnFrom: ["qitem-stream-S1"] }] });
    expect(open.summary).toContain("handed on to q-2; it's in-progress and now with qa-one@rig");
    const twice = await streamOutcome(client({ [DISP]: disposition({}), [S1]: handed,
      [`${NEXT}qitem-stream-S1`]: { status: 200, data: [{ qitemId: "q-2", handedOffFrom: "qitem-stream-S1" }] },
      "/api/queue/q-2": row("canceled", { qitemId: "q-2", closureReason: "superseded", closureTarget: "q-3" }),
      [`${NEXT}q-2`]: { status: 200, data: [{ qitemId: "q-3", handedOffFrom: "q-2" }] },
      "/api/queue/q-3": row("done", { qitemId: "q-3", closureReason: "no-follow-on", resolution: "fixed" }) }), "S1");
    expect(twice).toMatchObject({ stage: "work_closed", work: [{ qitemId: "q-3", state: "done", resolution: "fixed", handedOnFrom: ["qitem-stream-S1", "q-2"] }] });
  });

  it("unknown, never closed: a failed read, a missing row, or a handoff whose successor can't be found", async () => {
    const S1 = "/api/queue/qitem-stream-S1", NEXT = "/api/queue/list?handedOffFrom=qitem-stream-S1";
    const failed = await streamOutcome(client({ [DISP]: disposition({}), [S1]: { status: 500, data: { error: "boom" } } }), "S1");
    expect(failed).toMatchObject({ stage: "work_unknown", work: [{ state: "unavailable", unknown: "row_read_failed" }] });
    expect(failed).not.toHaveProperty("note");
    expect(await streamOutcome(client({ [DISP]: disposition({}) }), "S1")).toMatchObject({ stage: "work_unknown", work: [{ unknown: "row_missing" }] });
    const manual = row("done", { closureReason: "handed_off_to", closureTarget: "dev-guard@rig" });
    const unlinked = await streamOutcome(client({ [DISP]: disposition({}), [S1]: manual, [NEXT]: { status: 200, data: [] } }), "S1");
    expect(unlinked).toMatchObject({ stage: "work_unknown", work: [{ state: "done", closedToward: "dev-guard@rig", unknown: "successor_not_recorded" }] });
    expect(unlinked.summary).toContain("closed toward dev-guard@rig");
    // An older daemon ignores the filter and lists unrelated rows; they aren't taken for the successor.
    expect(await streamOutcome(client({ [DISP]: disposition({}), [S1]: manual, [NEXT]: { status: 200, data: [{ qitemId: "q-9", handedOffFrom: null }] } }), "S1"))
      .toMatchObject({ stage: "work_unknown", work: [{ unknown: "successor_not_recorded" }] });
    expect(await streamOutcome(client({ [DISP]: disposition({}), [S1]: manual, [NEXT]: { status: 500, data: {} } }), "S1"))
      .toMatchObject({ stage: "work_unknown", work: [{ unknown: "successor_read_failed" }] });
    // The walk is bounded.
    const loop = await streamOutcome(client({ [DISP]: disposition({}), [S1]: manual,
      [NEXT]: { status: 200, data: [{ qitemId: "qitem-stream-S1", handedOffFrom: "qitem-stream-S1" }] } }), "S1");
    expect(loop).toMatchObject({ stage: "work_unknown", work: [{ unknown: "too_many_handoffs" }] });
  });

  it("readers' actions: shown beside the outcome, and reader-linked work decides the stage when nothing automatic linked any", async () => {
    const ACTIONS = "/api/stream/S1/actions";
    const actions = (...current: Array<Record<string, unknown>>) => ({ status: 200, data: { streamItemId: "S1", current, history: current } });
    const a = (reader: string, action: string, over: Record<string, unknown> = {}) => ({ readerSession: reader, action, workQitemId: null, duplicateOf: null,
      reason: null, actedAt: "t5", ...over });
    // A decline alone changes nothing for others: still awaiting intake, with the reason shown.
    expect(await streamOutcome(client({ [ACTIONS]: actions(a("qa@rig", "decline", { reason: "not mine" })) }), "S1"))
      .toMatchObject({ stage: "awaiting_intake", readers: [{ reader: "qa@rig", action: "decline", reason: "not mine" }] });
    // No automatic work: the reader's linked work is what the poster follows, through handoffs.
    const linked = await streamOutcome(client({ [ACTIONS]: actions(a("qa@rig", "decline", { reason: "not mine" }), a("dev-lead@rig", "act", { workQitemId: "q-7", actedAt: "t6" })),
      "/api/queue/q-7": row("in-progress", { qitemId: "q-7", destinationSession: "dev-two@rig" }) }), "S1");
    expect(linked).toMatchObject({ stage: "work_open", work: [{ qitemId: "q-7", owner: "dev-two@rig" }],
      readers: [{ reader: "qa@rig", action: "decline" }, { reader: "dev-lead@rig", action: "act", work: "q-7" }] });
    expect(linked.summary).toBe("dev-lead@rig linked q-7; it's in-progress and now with dev-two@rig.");
    const fixed = await streamOutcome(client({ [ACTIONS]: actions(a("dev-lead@rig", "act", { workQitemId: "q-7" })),
      "/api/queue/q-7": row("done", { qitemId: "q-7", closureReason: "no-follow-on", resolution: "fixed in #1900", evidenceRef: "pr-1900" }) }), "S1");
    expect(fixed).toMatchObject({ stage: "work_closed", work: [{ resolution: "fixed in #1900", evidence: "pr-1900" }], note: expect.stringContaining("isn't proof") });
    // Automatic work already linked: its stage stands, and a second work row is flagged.
    const both = await streamOutcome(client({ [DISP]: disposition({}), "/api/queue/qitem-stream-S1": row("in-progress"),
      [ACTIONS]: actions(a("dev-lead@rig", "act", { workQitemId: "q-7" })) }), "S1");
    expect(both).toMatchObject({ stage: "work_open", work: [{ qitemId: "qitem-stream-S1" }], parallelWork: ["q-7", "qitem-stream-S1"] });
    // The automatic effect ended with intake; the work intake then linked is what the poster follows, and isn't parallel.
    const withIntake = await streamOutcome(client({ [DISP]: disposition({ applied: { outcome: "target_closed" } }), "/api/queue/q-7": row("pending", { qitemId: "q-7" }),
      [ACTIONS]: actions(a("intake@rig", "act", { workQitemId: "q-7" })) }), "S1");
    expect(withIntake).toMatchObject({ stage: "work_open", work: [{ qitemId: "q-7" }], application: { outcome: "target_closed" } });
    expect(withIntake).not.toHaveProperty("parallelWork");
    // One handed-on chain is one piece of work, not parallel work: A linked q-1, which was handed on to q-8, and B linked q-8.
    const chain = await streamOutcome(client({ [ACTIONS]: actions(a("a@rig", "act", { workQitemId: "q-1", actedAt: "t5" }), a("b@rig", "act", { workQitemId: "q-8", actedAt: "t6" })),
      "/api/queue/q-1": row("handed-off", { qitemId: "q-1", closureReason: "handed_off_to", closureTarget: "b@rig" }),
      "/api/queue/list?handedOffFrom=q-1": { status: 200, data: [{ qitemId: "q-8", handedOffFrom: "q-1" }] },
      "/api/queue/q-8": row("in-progress", { qitemId: "q-8", destinationSession: "b@rig" }) }), "S1");
    expect(chain).toMatchObject({ stage: "work_open", work: [{ qitemId: "q-8" }] });
    expect(chain).not.toHaveProperty("parallelWork");
    // Two actions in the same millisecond: record order (the action id) decides which is newest.
    const tied = await streamOutcome(client({ [ACTIONS]: actions(a("a@rig", "act", { workQitemId: "q-1", actedAt: "t5", actionId: "01A" }),
      a("b@rig", "act", { workQitemId: "q-2", actedAt: "t5", actionId: "01B" })),
      "/api/queue/q-1": row("done", { qitemId: "q-1", closureReason: "no-follow-on" }), "/api/queue/q-2": row("pending", { qitemId: "q-2" }) }), "S1");
    expect(tied).toMatchObject({ stage: "work_open", work: [{ qitemId: "q-2" }] });
    // A daemon without reader actions says so instead of implying there are none.
    expect(await streamOutcome(client({}), "S1")).toMatchObject({ stage: "awaiting_intake", readers: "unavailable" });
  });

  it("join, duplicate and no_action", async () => {
    const join = disposition({ disposition: "join", ownerSession: "qa-one@rig", workQitemId: "q-1", effect: { operation: "note", qitemId: "q-1" }, applied: { outcome: "noted" } });
    expect(await streamOutcome(client({ [DISP]: join, "/api/queue/q-1": row("blocked", { qitemId: "q-1", destinationSession: "qa-one@rig" }) }), "S1"))
      .toMatchObject({ stage: "work_open", summary: expect.stringContaining("Joined to q-1, which is blocked"), work: [{ qitemId: "q-1" }] });
    const duplicate = disposition({ disposition: "duplicate", workQitemId: "q-1", effect: { operation: "none", qitemId: null } });
    expect(await streamOutcome(client({ [DISP]: duplicate, "/api/queue/q-1": row("done", { qitemId: "q-1" }) }), "S1"))
      .toMatchObject({ stage: "duplicate", work: [{ qitemId: "q-1", state: "done" }] });
    expect(await streamOutcome(client({ [DISP]: disposition({ disposition: "no_action", effect: { operation: "none", qitemId: null } }) }), "S1"))
      .toMatchObject({ stage: "no_action", summary: expect.stringContaining("no work is warranted") });
  });

  it("an effect not applied yet, and one that ended with intake", async () => {
    expect(await streamOutcome(client({ [DISP]: disposition({ appliedAt: null, applied: null }) }), "S1")).toMatchObject({ stage: "effect_pending" });
    expect(await streamOutcome(client({ [DISP]: disposition({ applied: { outcome: "handed_to_intake", reason: "accepted by old-intake@rig" } }) }), "S1"))
      .toMatchObject({ stage: "with_intake", application: { outcome: "handed_to_intake" } });
  });

  it("an older daemon: no routing records, and a classification list that ignores the filter isn't mistaken for this item's", async () => {
    const old = client({ [DISP]: { status: 404, data: { error: "not found" } }, [LIST]: classified({ streamItemId: "OTHER" }) });
    expect(await streamOutcome(old, "S1")).toMatchObject({ stage: "unavailable" });
  });

  it("rig stream show adds the outcome beside the item", async () => {
    const logs: string[] = []; vi.spyOn(console, "log").mockImplementation(x => { logs.push(String(x)); });
    const fake = client({ "/api/stream/S1": { status: 200, data: { streamItemId: "S1", body: "obs" } }, [DISP]: disposition({}), "/api/queue/qitem-stream-S1": row("in-progress") });
    const deps = { lifecycleDeps: {} as StreamDeps["lifecycleDeps"], clientFactory: () => fake } as unknown as StreamDeps;
    const program = createProgram({ streamDeps: deps }); program.exitOverride();
    await program.parseAsync(["node", "rig", "stream", "show", "S1", "--json"]);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ streamItemId: "S1", body: "obs", outcome: { stage: "work_open" } });
  });
});
