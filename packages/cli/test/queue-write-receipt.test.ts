import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";
import { compactOutputEnabled } from "../src/queue-receipt.js";

/**
 * Slice 15 (OPR.0.7.0.15) P1 — queue writes print a short receipt when the
 * `output.compact` switch is on. Switch off, `--full`, and every error response
 * print today's output byte for byte.
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

const today = (body: unknown, json: boolean) => (json ? JSON.stringify(body) : JSON.stringify(body, null, 2));

/** Every write verb with a response that verb's route returns. */
const VERBS: Array<{ verb: string; argv: string[]; route: string; data: unknown; status: number }> = [
  { verb: "create", argv: ["create", "--destination", "worker@r", "--body", BODY, "--summary", "s", "--id", "qitem-20261010180000-aaaa"],
    route: "POST /api/queue/create", data: row(), status: 201 },
  { verb: "claim", argv: ["claim", "qitem-20261010180000-aaaa"], route: "POST /api/queue/qitem-20261010180000-aaaa/claim",
    data: row({ state: "in-progress", claimedAt: "2026-10-10T18:01:00.000Z", lastNudgeResult: "verified", lastNudgeAttempt: "2026-10-10T18:00:01.000Z" }), status: 200 },
  { verb: "unclaim", argv: ["unclaim", "qitem-20261010180000-aaaa"], route: "POST /api/queue/qitem-20261010180000-aaaa/unclaim", data: row(), status: 200 },
  { verb: "update", argv: ["update", "qitem-20261010180000-aaaa", "--note", "n"], route: "POST /api/queue/qitem-20261010180000-aaaa/update",
    data: row({ state: "in-progress" }), status: 200 },
  { verb: "block", argv: ["block", "qitem-20261010180000-aaaa", "--on", "external:ci", "--wake-after", "15m"],
    route: "POST /api/queue/qitem-20261010180000-aaaa/update",
    data: row({ state: "blocked", blockedOn: "external:ci" }, { blocker: { ref: "external:ci", owner: null, state: null },
      nextBackstop: { owner: "worker@r", mechanism: "watchdog:job-1", intervalSeconds: 900, dueAt: "2026-10-10T18:15:00.000Z" } }), status: 200 },
  { verb: "handoff", argv: ["handoff", "qitem-20261010180000-aaaa", "--to", "next@r", "--summary", "s"],
    route: "POST /api/queue/qitem-20261010180000-aaaa/handoff",
    data: { closed: row({ state: "handed-off", handedOffTo: "next@r", closureReason: "handed_off_to", closureTarget: "next@r" }, { nextBackstop: { owner: "worker@r", mechanism: "none (terminal obligation)", dueAt: null, intervalSeconds: null } }),
      created: row({ qitemId: "qitem-20261010180100-bbbb", destinationSession: "next@r", sourceSession: "worker@r", handedOffFrom: "qitem-20261010180000-aaaa" }) }, status: 201 },
  { verb: "handoff-and-complete", argv: ["handoff-and-complete", "qitem-20261010180000-aaaa", "--to", "next@r", "--summary", "s"],
    route: "POST /api/queue/qitem-20261010180000-aaaa/handoff-and-complete",
    data: { closed: row({ state: "done", closureReason: "handed_off_to", closureTarget: "next@r" }),
      created: row({ qitemId: "qitem-20261010180100-cccc", destinationSession: "next@r" }) }, status: 201 },
];

describe("queue write receipt (output.compact)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
    logs = []; errors = []; stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr.push(String(s)); return true; }) as typeof process.stderr.write);
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

  describe("unchanged unless the switch is on", () => {
    for (const v of VERBS) {
      for (const json of [false, true]) {
        it(`${v.verb}${json ? " --json" : ""}: switch off prints today's output, and so does --full`, async () => {
          const argv = [...v.argv, ...(json ? ["--json"] : [])];
          expect(await run(argv, { [v.route]: { status: v.status, data: v.data } })).toBe(today(v.data, json));
          logs = [];
          expect(await run([...argv, "--full"], { [v.route]: { status: v.status, data: v.data } })).toBe(today(v.data, json));
        });
        it(`${v.verb}${json ? " --json" : ""}: switch on with --full prints today's output byte for byte`, async () => {
          vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
          expect(await run([...v.argv, ...(json ? ["--json"] : []), "--full"], { [v.route]: { status: v.status, data: v.data } }))
            .toBe(today(v.data, json));
        });
      }
    }
  });

  describe("switch on: the receipt", () => {
    beforeEach(() => { vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1"); });

    for (const v of VERBS) {
      it(`${v.verb}: shows identity, state, owner, tsCreated and body size, never the body, and names the full read`, async () => {
        const plain = await run(v.argv, { [v.route]: { status: v.status, data: v.data } });
        logs = [];
        const json = JSON.parse(await run([...v.argv, "--json"], { [v.route]: { status: v.status, data: v.data } })) as Row;
        const rows = (v.data as Row).closed ? [(v.data as Row).closed as Row, (v.data as Row).created as Row] : [v.data as Row];
        for (const r of rows) {
          expect(plain).toContain(String(r.qitemId));
          expect(plain).toContain(` · ${String(r.state)} · owner ${String(r.destinationSession)}`);
          expect(plain).toContain(`created ${String(r.tsCreated)}`);
          expect(plain).toContain(`body ${Buffer.byteLength(BODY).toLocaleString("en-US")} bytes`);
          expect(plain).toContain(`rig queue show '${String(r.qitemId)}' --full --json`);
        }
        expect(plain).not.toContain("Do the thing.");
        expect(plain).toMatch(/receipt: (bodies|body) and \d+ other fields not shown \(output\.compact\)/);
        expect(plain.length).toBeLessThan(today(v.data, false).length);
        const jsonRows = rows.length === 2 ? [json.closed as Row, json.created as Row] : [json];
        jsonRows.forEach((jr, i) => {
          expect(jr).toMatchObject({ qitemId: rows[i]!.qitemId, state: rows[i]!.state, destinationSession: rows[i]!.destinationSession,
            tsCreated: rows[i]!.tsCreated, bodyBytes: Buffer.byteLength(BODY) });
          expect(jr).not.toHaveProperty("body");
        });
        const receipt = json.receipt as Row;
        expect(receipt.omitted).toEqual(expect.arrayContaining([rows.length === 2 ? "created.body" : "body"]));
        if (rows.length === 2) expect(receipt.fullCommands).toHaveLength(2);
        else expect(receipt.fullCommand).toBe(`rig queue show '${String(rows[0]!.qitemId)}' --full --json`);
      });
    }

    it("lists every response field it does not show, nested waiting fields included", async () => {
      const v = VERBS[0]!;
      const json = JSON.parse(await run([...v.argv, "--json"], { [v.route]: { status: v.status, data: v.data } })) as Row;
      const shown = new Set(Object.keys(json));
      const omitted = (json.receipt as Row).omitted as string[];
      for (const k of Object.keys(v.data as Row)) {
        if (k === "waiting" || k === "lastNudgeResult" || k === "lastNudgeAttempt") continue; // projected / carried by wake
        expect(shown.has(k) || omitted.includes(k), k).toBe(true);
      }
      expect(omitted).toEqual(expect.arrayContaining(["tags", "chainOfRecord", "waiting.liveness", "waiting.lastMeaningfulChange"]));
    });

    for (const v of VERBS) {
      it(`${v.verb} --json: every kept field sits at today's key, path and type; additions are only bodyBytes, wake, host and receipt`, async () => {
        const json = JSON.parse(await run([...v.argv, "--json"], { [v.route]: { status: v.status, data: v.data } })) as Row;
        const todays = JSON.parse(today(v.data, true)) as Row;
        const pairs: Array<[Row, Row]> = todays.closed ? [[json.closed as Row, todays.closed as Row], [json.created as Row, todays.created as Row]] : [[json, todays]];
        const ADDED = new Set(["bodyBytes", "wake", "host", "receipt"]);
        for (const [receipt, full] of pairs) {
          for (const [k, val] of Object.entries(receipt)) {
            if (ADDED.has(k)) continue;
            if (k === "waiting") {
              for (const [wk, wv] of Object.entries(val as Row)) expect(wv, `waiting.${wk}`).toEqual((full.waiting as Row)[wk]);
              continue;
            }
            expect(val, k).toEqual(full[k]);
          }
          // The fields jq filters rely on, present even when null or routine.
          for (const k of ["qitemId", "state", "destinationSession", "sourceSession", "tsCreated", "tsUpdated", "priority", "summary", "lastNudgeResult", "lastNudgeAttempt"]) {
            expect(receipt, k).toHaveProperty(k);
          }
          expect((receipt.pickup as Row).state).toBe((full.pickup as Row).state);
          expect((receipt.waiting as Row).nextBackstop).toEqual((full.waiting as Row).nextBackstop);
          expect((receipt.waiting as Row).blocker).toEqual((full.waiting as Row).blocker);
        }
      });
    }

    it("a parked write shows the blocker and its timer backstop", async () => {
      const v = VERBS.find((x) => x.verb === "block")!;
      const plain = await run(v.argv, { [v.route]: { status: v.status, data: v.data } });
      expect(plain).toContain("parked qitem-20261010180000-aaaa · blocked · owner worker@r");
      expect(plain).toContain("blocked on external:ci");
      expect(plain).toContain("backstop: watchdog:job-1 · due 2026-10-10T18:15:00.000Z · owner worker@r");
    });

    it("a parked write with no timer says so in the daemon's own words", async () => {
      const data = row({ state: "blocked", blockedOn: "external:ci" }, { blocker: { ref: "external:ci", owner: null, state: null },
        nextBackstop: { owner: "worker@r", mechanism: "UNVERIFIED: no timed backstop", dueAt: null, intervalSeconds: null } });
      const plain = await run(["block", "qitem-20261010180000-aaaa", "--on", "external:ci"], { "POST /api/queue/qitem-20261010180000-aaaa/update": { status: 200, data } });
      expect(plain).toContain("backstop: UNVERIFIED: no timed backstop · owner worker@r");
    });

    it("a handoff shows the closed row's closure and the new row", async () => {
      const v = VERBS.find((x) => x.verb === "handoff")!;
      const plain = await run(v.argv, { [v.route]: { status: v.status, data: v.data } });
      expect(plain).toMatch(/^closed qitem-20261010180000-aaaa · handed-off · owner worker@r/m);
      expect(plain).toContain("closure: handed_off_to → next@r");
      expect(plain).toMatch(/^created qitem-20261010180100-bbbb · pending · owner next@r/m);
      expect(plain).toContain("rig queue show 'qitem-20261010180000-aaaa' --full --json · rig queue show 'qitem-20261010180100-bbbb' --full --json");
    });

    it("advisories, handoff advisories and warnings appear whole", async () => {
      const advisory = { code: "unmatched_destination_seat", destinationSession: "wrkr@r", availableDestinations: ["worker@r"], message: "No seat named wrkr@r; did you mean worker@r?" };
      const handoffAdvisory = { status: "unverified", target: "x@other", reason: "no-live-local-successor", message: "Successor custody for 'x@other' is unverified on this daemon." };
      const data = { ...row({ state: "done", closureReason: "handed_off_to", closureTarget: "x@other", handoffAdvisory }), advisories: [advisory] };
      const route = { "POST /api/queue/qitem-20261010180000-aaaa/update": { status: 200, data } };
      const argv = ["update", "qitem-20261010180000-aaaa", "--state", "done", "--closure-reason", "handed_off_to", "--closure-target", "x@other"];
      const plain = await run(argv, route);
      expect(plain).toContain(`advisory: ${advisory.message}`);
      expect(plain).toContain(`advisory: ${handoffAdvisory.message}`);
      logs = [];
      const json = JSON.parse(await run([...argv, "--json"], route)) as Row;
      expect(json.advisories).toEqual([advisory]);
      expect(json.handoffAdvisory).toEqual(handoffAdvisory);
    });

    it("an unrecognized response shape prints whole rather than guess", async () => {
      const data = { surprise: true };
      expect(await run(["claim", "qitem-x"], { "POST /api/queue/qitem-x/claim": { status: 200, data } })).toBe(today(data, false));
    });
  });

  describe("switch on: failed and indeterminate writes read exactly as today", () => {
    beforeEach(() => { vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1"); });

    it("a refusal prints whole with exit 1", async () => {
      const data = { error: "unknown_target_repo", message: "target_repo \"x\" does not match any repo in rig r's workspace; check rig whoami --full --json | jq .workspace.repos to see declared repos", rigName: "r", knownRepos: ["a"] };
      for (const json of [false, true]) {
        logs = []; process.exitCode = undefined;
        const out = await run(["create", "--destination", "worker@r", "--body", "b", "--summary", "s", "--target-repo", "x", ...(json ? ["--json"] : [])],
          { "POST /api/queue/create": { status: 400, data } });
        expect(out).toBe(today(data, json));
        expect(process.exitCode).toBe(1);
      }
    });

    it("an indeterminate cross-host create prints whole, warns on stderr and exits 2", async () => {
      const data = { error: "remote_queue_write_failed", hostId: "far", failureClass: "unreachable", outcome: "indeterminate", detail: "socket hang up" };
      const out = await run(["create", "--destination", "worker@r", "--host", "far", "--body", "b", "--summary", "s", "--id", "qitem-fixed", "--json"],
        { "POST /api/queue/create": { status: 502, data } });
      const printed = JSON.parse(out) as Row;
      expect(printed).toMatchObject({ ...data, qitemId: "qitem-fixed" });
      expect(printed.recovery).toEqual(expect.stringContaining("--id 'qitem-fixed'"));
      expect(errors.join("\n")).toContain("The write outcome is INDETERMINATE");
      expect(process.exitCode).toBe(2);
    });

    it("a missing row prints whole with the host hint", async () => {
      const out = await run(["claim", "qitem-gone"], {
        "POST /api/queue/qitem-gone/claim": { status: 404, data: { error: "qitem_not_found" } },
        "GET /healthz": { status: 200, data: { selfHostId: "h1" } },
      });
      expect(JSON.parse(out)).toMatchObject({ error: "qitem_not_found", hint: expect.stringContaining('daemon "h1"') });
      expect(process.exitCode).toBe(1);
    });
  });

  describe("switch on: wake evidence is only what the write proves", () => {
    beforeEach(() => { vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1"); });
    const create = async (extra: string[], data: Row) =>
      run(["create", "--destination", "worker@r", "--body", BODY, "--summary", "s", ...extra], { "POST /api/queue/create": { status: 201, data } });

    it("suppressed with --no-nudge", async () => {
      const out = await create(["--no-nudge"], row());
      expect(out).toContain("wake: --no-nudge: no wake was requested");
    });

    it("staging failed: the row saved, the wake did not", async () => {
      const out = await create([], row({ lastNudgeResult: "failed:wake not retained: outbox locked", lastNudgeAttempt: "2026-10-10T18:00:00.500Z" }));
      expect(out).toContain("wake: failed:wake not retained: outbox locked at 2026-10-10T18:00:00.500Z — the row saved but its wake was NOT staged");
    });

    it("an idempotent create that returned an existing row says no new wake, and its warning stays on stderr", async () => {
      const createWarning = { code: "qitem_body_not_saved", message: "qitem q already exists with a different body. The supplied body was not saved; the existing row is returned unchanged. No new work or delivery was created." };
      const out = await create(["--id", "qitem-20261010180000-aaaa"], { ...row({ lastNudgeResult: "verified", lastNudgeAttempt: "2026-10-09T00:00:00.000Z" }), createWarning });
      expect(out).toContain("wake: an existing row was returned; this write started no new wake (the row's earlier wake result: verified at 2026-10-09T00:00:00.000Z)");
      expect(out).toContain(`WARNING: ${createWarning.message}`);
      expect(errors.join("\n")).toContain(`Warning: ${createWarning.message}`);
    });

    it.each(["verified", "delivered-ack-pending", "retained:typing_guard", "failed:tmux reports no session", "indeterminate:timeout"])(
      "no outbox: shows the daemon's recorded result %s as recorded", async (result) => {
        const out = await create([], row({ lastNudgeResult: result, lastNudgeAttempt: "2026-10-10T18:00:01.000Z" }));
        expect(out).toContain(`wake: ${result} at 2026-10-10T18:00:01.000Z — the daemon's recorded wake result`);
      });

    it("outbox path: a null result is one honest line, never 'scheduled'", async () => {
      const out = await create([], row());
      const wakeLines = out.split("\n").filter((l) => l.includes("wake:"));
      expect(wakeLines).toEqual(["  wake: no wake result recorded yet (delivery, if staged, follows the write)"]);
      expect(out.toLowerCase()).not.toMatch(/scheduled|delivered|failed/);
      logs = [];
      const json = JSON.parse(await create(["--json"], row())) as Row;
      expect(json.wake).toEqual({ evidence: "none-recorded", detail: "no wake result recorded yet (delivery, if staged, follows the write)" });
    });

    it("--id with a null result notes that an existing row starts no new wake", async () => {
      const out = await create(["--id", "qitem-20261010180000-aaaa"], row());
      expect(out).toContain("wake: no wake result recorded yet (delivery, if staged, follows the write); if --id named an existing row, it was returned with no new wake");
    });

    it("--verify keeps persisted and the whole delivery object", async () => {
      const id = "qitem-20261010180000-aaaa";
      const program = createProgram({ queueDeps: {
        ...makeDeps({
          "POST /api/queue/create": { status: 201, data: row() },
          [`GET /api/queue/${id}`]: { status: 200, data: { qitemId: id, deliveryOutcome: "posted" } },
        }),
        deliveryVerify: { timeoutMs: 50, intervalMs: 0, sleep: async () => {} },
      } });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "create", "--destination", "worker@r", "--body", "b", "--summary", "s", "--verify", "--json"]);
      const json = JSON.parse(logs.at(-1)!) as Row;
      expect(json).toMatchObject({ qitemId: id, persisted: true, delivery: { outcome: "posted", connectorAccepted: true, humanReadership: "unknown", nextAction: null } });
      expect(json).not.toHaveProperty("body");
    });

    it("claim, unclaim, update and block start no wake: no wake line, and the row's earlier wake fields stay as data", async () => {
      for (const verb of ["claim", "unclaim", "update", "block"]) {
        const w = VERBS.find((x) => x.verb === verb)!;
        const earlier = { ...(w.data as Row), lastNudgeResult: "verified", lastNudgeAttempt: "2026-10-10T18:00:01.000Z" };
        logs = [];
        const plain = await run(w.argv, { [w.route]: { status: w.status, data: earlier } });
        expect(plain, verb).not.toContain("wake:");
        expect(plain, verb).not.toContain("verified");
        expect(plain, verb).not.toContain("2026-10-10T18:00:01.000Z");
      }
      const v = VERBS.find((x) => x.verb === "claim")!;
      logs = [];
      const json = JSON.parse(await run([...v.argv, "--json"], { [v.route]: { status: v.status, data: v.data } })) as Row;
      expect(json).not.toHaveProperty("wake");
      expect(json).toMatchObject({ lastNudgeResult: "verified", lastNudgeAttempt: "2026-10-10T18:00:01.000Z" });
    });

    it("a --host create names the host and the remote read", async () => {
      const out = await create(["--host", "far"], row());
      expect(out).toContain("host: far (the row lives on that daemon)");
      expect(out).toContain("OPENRIG_URL='<daemon-url of host far>' rig queue show 'qitem-20261010180000-aaaa' --full --json");
    });
  });
});

describe("the output.compact switch", () => {
  let home: string;
  beforeEach(() => {
    vi.unstubAllEnvs();
    home = fs.mkdtempSync(path.join(process.env.OPENRIG_HOME ?? "/tmp", "compact-"));
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr.push(String(s)); return true; }) as typeof process.stderr.write);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const store = (value?: unknown) => ({ get: (key: string) => { expect(key).toBe("output.compact"); return value ?? false; } });

  it("is off by default", () => {
    expect(compactOutputEnabled(store())).toBe(false);
  });
  it.each(["1", "true"])("env %s is on", (v) => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", v);
    expect(compactOutputEnabled(store(false))).toBe(true);
  });
  it.each(["0", "false"])("env %s is off, even over a config of true", (v) => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", v);
    expect(compactOutputEnabled(store(true))).toBe(false);
  });
  it.each(["yes", "on", "TRUE", " 1", "2"])("an unrecognized env value %j is off, with a note, even over a config of true", (v) => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", v);
    expect(compactOutputEnabled(store(true))).toBe(false);
    expect(stderr.join("")).toContain("output.compact is off for this command");
  });
  it("an empty env defers to the config", () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "");
    expect(compactOutputEnabled(store(true))).toBe(true);
  });
  it("an unreadable config is off", () => {
    expect(compactOutputEnabled({ get: () => { throw new Error("bad config"); } })).toBe(false);
  });
  it("rig config set output.compact true turns it on through the real config store", async () => {
    const { ConfigStore } = await import("../src/config-store.js");
    const real = new ConfigStore(path.join(home, "config.json"));
    expect(compactOutputEnabled(real)).toBe(false);
    real.set("output.compact", "true");
    expect(compactOutputEnabled(real)).toBe(true);
    real.set("output.compact", "false");
    expect(compactOutputEnabled(real)).toBe(false);
  });
});
