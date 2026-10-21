// `rig gateway human mode save|saved|apply|current|end|room|decide|decisions`: a person's modes, beside quiet hours, and
// the decisions made on their behalf inside a mode's decision room. The verbs talk to a recording stub daemon over real HTTP.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { allowFetchTarget } from "./fetch-guard.js";
import { createProgram } from "../src/index.js";
import { addHumanFragment } from "@openrig/daemon/gateway-human-registry";

describe("rig gateway human mode", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevUrl: string | undefined;
  let server: Server;
  let requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }>;
  let reply: { status: number; body: unknown };
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "mode-verb-"));
    prevHome = process.env.OPENRIG_HOME; process.env.OPENRIG_HOME = home;
    expect(addHumanFragment({ entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
      prefs: { deliveryClass: "B", availability: "focus" },
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://slack/mike", role: "primary" }] }, home).ok).toBe(true);
    requests = [];
    reply = { status: 200, body: { ok: true } };
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        requests.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null });
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    prevUrl = process.env.OPENRIG_URL; process.env.OPENRIG_URL = url;
    allowFetchTarget(url);
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    process.exitCode = undefined;
    logs = []; errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  });

  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = prevUrl;
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const run = async (...args: string[]) => {
    const p = createProgram(); p.exitOverride();
    await p.parseAsync(["node", "rig", "gateway", "human", ...args]);
  };
  const application = { applicationId: "a-1", modeName: "asleep", startedAt: "2026-10-20T21:00:00.000Z", scheduledEnd: "2026-10-21T07:00:00.000Z",
    endedAt: null, endReason: null, effects: [
      { consumer: "availability", state: "active", detail: null },
      { consumer: "decision-room", state: "active", detail: null },
      { consumer: "quiet", state: "failed", detail: "unknown timezone" },
    ] };

  it("save sends the three settings as given; a setting left out reads unchanged, and no decision room is assumed", async () => {
    reply = { status: 200, body: { ok: true, mode: { name: "asleep", availability: { value: "away", expectedBack: "07:00" }, decisionRoom: null,
      delivery: { quiet: null, account: null } } } };
    await run("mode", "save", "mike", "asleep", "--availability", "away", "--expected-back", "07:00", "--tz", "UTC", "--actor", "op");
    expect(requests[0]).toMatchObject({ method: "PUT", url: "/api/gateway/human/mike/modes/asleep",
      body: { availability: "away", expectedBack: "07:00", decisionRoom: null, exclusions: [], quiet: null, timezone: "UTC", actor: "op" } });
    expect(logs).toEqual(["asleep: availability away, back 07:00; decision room none (nothing is decided for them); delivery: quiet hours unchanged"]);
  });

  it("apply prints each effect's real state, so a failed one never reads as active", async () => {
    reply = { status: 200, body: { ok: true, application, ended: null, atDesk: false, unresolved: [] } };
    await run("mode", "apply", "mike", "asleep", "--until", "07:00", "--tz", "UTC");
    expect(requests[0]).toMatchObject({ method: "POST", url: "/api/gateway/human/mike/modes/asleep/apply", body: { until: "07:00", timezone: "UTC" } });
    expect(logs).toEqual(["asleep on since 2026-10-20T21:00:00.000Z, until 2026-10-21T07:00:00.000Z\n  availability: active\n  decision-room: active\n  quiet: failed (unknown timezone)"]);
  });

  it("apply --until without --tz uses this machine's zone, as save does, and says which zone it used", async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    reply = { status: 200, body: { ok: true, application, ended: null, atDesk: false, unresolved: [] } };
    await run("mode", "apply", "mike", "asleep", "--until", "07:00");
    expect(requests[0]!.body).toMatchObject({ until: "07:00", timezone: zone });
    expect(logs.at(-1)).toBe(`until 07:00 in ${zone}; pass --tz for the person's own zone`);
  });

  it("current says at desk, and lists a restoration still owed from an earlier mode", async () => {
    reply = { status: 200, body: { ok: true, current: null, atDesk: true, unresolved: [
      { applicationId: "a-0", modeName: "away-from-desk", endedAt: "2026-10-20T18:00:00.000Z",
        effect: { consumer: "availability", state: "pending", detail: "couldn't read the current availability" } }] } };
    await run("mode", "current", "mike");
    expect(requests[0]).toMatchObject({ method: "GET", url: "/api/gateway/human/mike/mode" });
    expect(logs).toEqual(["mike is at desk: no mode on",
      "  still pending from away-from-desk (ended 2026-10-20T18:00:00.000Z): availability (couldn't read the current availability)"]);
  });

  it("end records a scheduled end when asked; --json passes the daemon's answer through", async () => {
    reply = { status: 200, body: { ok: true, ended: { ...application, endedAt: "2026-10-21T07:00:00.000Z", endReason: "scheduled" }, atDesk: true, unresolved: [] } };
    await run("mode", "end", "mike", "--scheduled", "--json");
    expect(requests[0]).toMatchObject({ method: "POST", url: "/api/gateway/human/mike/mode/end", body: { reason: "scheduled" } });
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ended: { endReason: "scheduled" } });
  });

  it("a refusal is reported and exits non-zero", async () => {
    reply = { status: 400, body: { error: "end_required", message: "needs an end time" } };
    await run("mode", "apply", "mike", "asleep");
    expect(errors).toEqual(["refused: needs an end time"]);
    expect(process.exitCode).toBe(1);
  });

  it("room shows the person's own words and how to decide inside it, or says to ask them; decisions lists what was decided", async () => {
    reply = { status: 200, body: { ok: true, decisionRoom: { applicationId: "a-1", modeName: "asleep", words: "design choices", exclusions: ["publishing"] } } };
    await run("mode", "room", "mike");
    reply = { status: 200, body: { ok: true, decisionRoom: null, why: "at desk: no mode is on, so ask them" } };
    await run("mode", "room", "mike");
    reply = { status: 200, body: { ok: true, modeName: "asleep", decisions: [{ qitemId: "q-1",
      decision: { decidedBy: "designer@rig", reversible: true, choices: [{ questionId: "design", chosen: "a" }], reason: "recommended" } }] } };
    await run("mode", "decisions", "mike", "a-1");
    expect(requests.map((r) => r.url)).toEqual(["/api/gateway/human/mike/decision-room", "/api/gateway/human/mike/decision-room",
      "/api/gateway/human/mike/mode/applications/a-1/decisions"]);
    expect(logs).toEqual([`mike's asleep decision room: "design choices" except publishing\n  decide with: rig gateway human mode decide <qitemId> --application a-1 ...`,
      "mike: no decision room (at desk: no mode is on, so ask them); ask them",
      "q-1 by designer@rig (reversible): design=a; recommended"]);
  });

  it("account prints how the mode ended against its scheduled time, each effect, what was decided and what's waiting, and what isn't tracked", async () => {
    reply = { status: 200, body: { ok: true, account: {
      mode: { modeName: "asleep", settings: { name: "asleep", availability: { value: "away", expectedBack: null }, decisionRoom: null, delivery: { quiet: null, account: null } },
        startedAt: "2026-10-20T21:00:00.000Z", scheduledEnd: "2026-10-21T07:00:00.000Z", endedAt: "2026-10-21T07:00:40.000Z", endReason: "scheduled" },
      effects: [{ consumer: "availability", state: "ended", detail: "restored to focus" }, { consumer: "quiet", state: "kept", detail: "changed by hand" }],
      unresolved: [], now: null, decisions: [],
      waiting: [{ qitemId: "q-2", standing: "stale", reason: "superseded", summary: "Rename the repo?" }],
      notTracked: ["work done while the mode was on: no record ties work to a person"] } } };
    await run("mode", "account", "mike", "a-1");
    expect(requests[0]!.url).toBe("/api/gateway/human/mike/mode/applications/a-1/account");
    expect(logs).toEqual([
      "asleep: availability away; decision room none (nothing is decided for them); delivery: quiet hours unchanged",
      "  on 2026-10-20T21:00:00.000Z, ended 2026-10-21T07:00:40.000Z (scheduled; scheduled for 2026-10-21T07:00:00.000Z)",
      "  availability: ended (restored to focus)", "  quiet: kept (changed by hand)", "  now: at desk", "  decided for them: nothing",
      "  waiting for them: q-2 stale (superseded): Rename the repo?",
      "  not tracked: work done while the mode was on: no record ties work to a person",
    ]);
  });

  it("decide records each question's choice and the reason, and needs to be told whether it can be undone", async () => {
    await run("mode", "decide", "q-1", "--application", "a-1", "--choose", "design=a", "--reason", "recommended");
    expect(errors).toEqual(["Say whether it can be undone: --reversible or --irreversible."]);
    expect(requests).toEqual([]);
    process.exitCode = undefined;
    reply = { status: 200, body: { ok: true, item: { delegatedDecision: { modeName: "asleep", reversible: true, choices: [{ questionId: "design", chosen: "a" }, { questionId: "ship", chosen: "yes" }] } } } };
    await run("mode", "decide", "q-1", "--application", "a-1", "--choose", "design=a", "ship=yes", "--reason", "recommended", "--reversible", "--actor", "designer@rig");
    expect(requests[0]).toMatchObject({ method: "POST", url: "/api/queue/q-1/delegated-decision", body: { applicationId: "a-1",
      choices: [{ questionId: "design", chosen: "a" }, { questionId: "ship", chosen: "yes" }], reason: "recommended", reversible: true, actor: "designer@rig" } });
    expect(logs).toEqual(["q-1: decided on the person's behalf under asleep (reversible): design=a, ship=yes"]);
  });
});
