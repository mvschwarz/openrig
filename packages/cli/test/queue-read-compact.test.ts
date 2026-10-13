import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { compactShow, compactTransitions, TRANSITIONS_SHOWN } from "../src/queue-read-compact.js";

/**
 * Slice 15 (OPR.0.7.0.15) P2 and P3: `queue show` and `queue transitions` print a compact status read
 * when the `output.compact` switch is on. Switch off, `--full`, and error responses print today's output.
 */

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

type Row = Record<string, unknown>;
const BODY = "Do the thing.\n".repeat(40) + "é";

/** The daemon's write response, shaped as `rowToItem` returns it. */
function row(over: Row = {}, waiting: Row = {}): Row {
  const id = (over.qitemId as string | undefined) ?? "qitem-20261010180000-aaaa";
  const state = (over.state as string | undefined) ?? "pending";
  return {
    pickup: { state: "unclaimed" },
    waiting: {
      obligation: id, owner: "worker@r", state, actionableSince: "2026-10-10T18:00:00.000Z", blocker: null,
      lastMeaningfulChange: { id: 7, at: "2026-10-10T18:00:00.000Z" },
      liveness: { subject: "worker@r", activity: "idle", needsInput: { count: 0, reason: null }, confidence: "oracle" },
      nextBackstop: { owner: "lead@r", mechanism: "queue-stuck-sweep:unclaimed", dueAt: "2026-10-10T19:00:00.000Z", intervalSeconds: 300 },
      deadlineAt: null,
      ...waiting,
    },
    qitemId: id, tsCreated: "2026-10-10T18:00:00.000Z", tsUpdated: "2026-10-10T18:00:00.000Z",
    sourceSession: "lead@r", destinationSession: "worker@r", state, priority: "routine", tier: null,
    tags: ["mission:m"], blockedOn: null, handedOffTo: null, handedOffFrom: null, expiresAt: null, chainOfRecord: null,
    body: BODY, summary: "Ship the receipt", evidenceRef: null, humanIntent: null, humanDetail: null, replyTo: null,
    humanQuestions: null, humanAnswers: null, closureReason: null, closureTarget: null, closureRequiredAt: null,
    claimedAt: null, lastNudgeAttempt: null, lastNudgeResult: null, lastHeartbeat: null, resolution: null, targetRepo: null,
    ...over,
  };
}

function makeDeps(routes: Record<string, { status: number; data: unknown } | Array<{ status: number; data: unknown }>>): QueueDeps {
  const pick = (key: string, fallback: { status: number; data: unknown }) => {
    const r = routes[key];
    return (Array.isArray(r) ? r.shift() : r) ?? fallback;
  };
  return {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async (p: string) => pick(`GET ${p}`, { status: 200, data: {} })),
      post: vi.fn(async (p: string) => pick(`POST ${p}`, { status: 500, data: { error: "unrouted" } })),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  };
}

let logs: string[];
let errors: string[];
let stderr: string[];

async function run(argv: string[], routes: Parameters<typeof makeDeps>[0]): Promise<string> {
  const program = createProgram({ queueDeps: makeDeps(routes) });
  program.exitOverride();
  await program.parseAsync(["node", "rig", "queue", ...argv]);
  return logs.join("\n");
}


const ID = "qitem-20261010180000-aaaa";

function transition(n: number, state: string, note: string, over: Row = {}): Row {
  return { transitionId: n, qitemId: ID, ts: `2026-10-10T18:${String(n).padStart(2, "0")}:00.000Z`, state, transitionNote: note,
    actorSession: "worker@r", closureReason: null, closureTarget: null, identityProvenance: "transport:v1", ownerNotificationKind: null,
    ownerNotificationLevel: "RECORD", ...over };
}
/** 12 transitions: created, claimed, parked on CI at #3, then 9 note-only updates while parked. */
const LOG: Row[] = [
  transition(1, "pending", "created"),
  transition(2, "in-progress", "claimed"),
  transition(3, "blocked", "parked: waiting on CI run 42"),
  ...Array.from({ length: 9 }, (_, i) => transition(4 + i, "blocked", `progress note ${i + 1}`)),
];

describe("queue show and transitions (output.compact, P2/P3)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
    logs = []; errors = []; stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  const showRoute = (data: unknown = row()) => ({ [`GET /api/queue/${ID}`]: { status: 200, data } });
  const transitionsRoute = (data: unknown = LOG) => ({ [`GET /api/queue/${ID}/transitions`]: { status: 200, data } });

  describe("P2 queue show", () => {
    it("switch off: today's preview, every field kept, no notice", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "0");
      const out = JSON.parse(await run(["show", ID, "--json"], showRoute()));
      expect(out).toHaveProperty("tier", null);
      expect(out).toHaveProperty("evidenceRef", null);
      expect(out.readView.complete).toBe(false); // the body preview, as today
      expect(errors).toEqual([]);
    });

    it("switch on: status fields and body marker kept, empty fields left out and counted, the full read named", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      const data = row({ state: "blocked", blockedOn: "external:ci", closureReason: null }, { blocker: { ref: "external:ci", owner: null, state: null } });
      const out = JSON.parse(await run(["show", ID, "--json"], showRoute(data)));
      for (const key of ["qitemId", "state", "destinationSession", "sourceSession", "summary", "priority", "tags", "tsCreated", "tsUpdated",
        "pickup", "waiting", "body", "bodyBytes", "bodyTruncated", "readView", "blockedOn"]) expect(out, key).toHaveProperty(key);
      expect(out.waiting.blocker).toEqual({ ref: "external:ci", owner: null, state: null });
      expect(out, "the closure stays, null when there is none").toHaveProperty("closureReason", null);
      for (const key of ["tier", "evidenceRef", "handedOffTo", "humanQuestions", "targetRepo"]) expect(out, key).not.toHaveProperty(key);
      const empties = out.readView.omittedFields.find((f: { path: string }) => f.path === "empty fields");
      expect(empties.items).toBeGreaterThan(10);
      expect(out.readView.omittedFields[0].path).toBe("body (after preview)");
      expect(out.readView.complete).toBe(false);
      expect(errors.join("\n")).toContain(`${empties.items} empty fields not shown;`);
      expect(errors.join("\n")).toContain(`rig queue show '${ID}' --full --json`);
    });

    it("switch on, plain: the body marker line stays and the empty-field notice follows it", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      const text = await run(["show", ID], showRoute());
      expect(text).toContain("bounded preview — complete body is");
      expect(text).toMatch(/empty fields not shown/);
    });

    it("switch on, --full: byte-identical to the switch-off --full read", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "0");
      const before = await run(["show", ID, "--full", "--json"], showRoute());
      logs = [];
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      expect(await run(["show", ID, "--full", "--json"], showRoute())).toBe(before);
      expect(errors).toEqual([]);
    });

    it("an error response prints in full, whatever the switch", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      const text = await run(["show", ID, "--json"], { [`GET /api/queue/${ID}`]: { status: 404, data: { error: "qitem_not_found" } } });
      expect(text).toContain("qitem_not_found");
    });

    it("compactShow keeps non-empty values, including false and zero", () => {
      const { item, emptyOmitted } = compactShow({ qitemId: "q", state: "pending", flag: false, count: 0, note: " ", list: [], obj: {}, readView: { omittedFields: [], complete: true } });
      expect(item).toMatchObject({ flag: false, count: 0 });
      expect(emptyOmitted.sort()).toEqual(["list", "note", "obj"]);
    });
  });

  it("P2: an empty blocker and closure stay at their paths, so .blockedOn == null still reads", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    const out = JSON.parse(await run(["show", ID, "--json"], { [`GET /api/queue/${ID}`]: { status: 200, data: row() } }));
    expect(out).toHaveProperty("blockedOn", null);
    expect(out).toHaveProperty("closureReason", null);
  });

  describe("P3 queue transitions", () => {
    it("switch on: the latest disposition and its reason are kept, the rest counted on stderr (visible through jq), the array shape and order kept", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      const out = JSON.parse(await run(["transitions", ID, "--json"], transitionsRoute()));
      expect(Array.isArray(out)).toBe(true);
      expect(out).toHaveLength(TRANSITIONS_SHOWN);
      expect(out[0]).toMatchObject({ transitionId: 3, state: "blocked", transitionNote: "parked: waiting on CI run 42" });
      expect(out.at(-1)).toEqual(LOG.at(-1)); // .[-1] is still the latest
      expect(out.map((t: Row) => t.state)).toEqual(Array(TRANSITIONS_SHOWN).fill("blocked")); // a filter on retained fields runs
      expect(errors.join("\n")).toContain(`7 earlier transitions not shown (12 in all; the latest disposition is kept); full log: rig queue transitions '${ID}' --full --json`);
    });

    it("a closure is the disposition even when the state didn't change", () => {
      const log = [transition(1, "pending", "a"), transition(2, "in-progress", "b"), transition(3, "done", "closed", { closureReason: "no-follow-on" }),
        ...Array.from({ length: 6 }, (_, i) => transition(4 + i, "done", `late note ${i}`))];
      const { transitions, earlier } = compactTransitions(log);
      expect(transitions[0]).toMatchObject({ transitionId: 3, closureReason: "no-follow-on" });
      expect(earlier).toBe(log.length - TRANSITIONS_SHOWN);
    });

    it("when the disposition is already in the tail, the tail is the latest five", () => {
      const log = [...Array.from({ length: 8 }, (_, i) => transition(1 + i, "pending", `n${i}`)), transition(9, "in-progress", "claimed")];
      expect(compactTransitions(log).transitions.map((t) => t.transitionId)).toEqual([5, 6, 7, 8, 9]);
    });

    it("a short log prints whole, with no notice", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      const out = JSON.parse(await run(["transitions", ID, "--json"], transitionsRoute(LOG.slice(0, 3))));
      expect(out).toEqual(LOG.slice(0, 3));
      expect(errors).toEqual([]);
    });

    it("--full and the switch off both print the whole log as today", async () => {
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "0");
      const before = await run(["transitions", ID, "--json"], transitionsRoute());
      expect(JSON.parse(before)).toEqual(LOG);
      logs = [];
      vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
      expect(await run(["transitions", ID, "--json", "--full"], transitionsRoute())).toBe(before);
      expect(errors).toEqual([]);
    });
  });

  // P6: characters per form before and after on these fixed fixtures. Written only when asked.
  it.runIf(Boolean(process.env.S15_MEASURE_OUT))("P6 measurement", async () => {
    const sizes: Record<string, number> = {};
    for (const [label, argv, routes] of [
      ["show plain", ["show", ID], showRoute()],
      ["show --json", ["show", ID, "--json"], showRoute()],
      ["show --full --json", ["show", ID, "--full", "--json"], showRoute()],
      ["transitions plain", ["transitions", ID], transitionsRoute()],
      ["transitions --json", ["transitions", ID, "--json"], transitionsRoute()],
    ] as const) {
      for (const sw of ["0", "1"]) {
        vi.stubEnv("OPENRIG_OUTPUT_COMPACT", sw);
        logs = []; errors = [];
        const out = await run([...argv], routes as never);
        sizes[`${label} | ${sw === "1" ? "after" : "before"} | stdout`] = out.length;
        sizes[`${label} | ${sw === "1" ? "after" : "before"} | stderr`] = errors.join("\n").length;
      }
    }
    fs.writeFileSync(process.env.S15_MEASURE_OUT!, JSON.stringify(sizes, null, 2));
  });
});
