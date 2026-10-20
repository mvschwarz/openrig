// `rig gateway human quiet set|end|clear|show` and the quiet line in `rig gateway human list`. The verbs talk to a
// recording stub daemon over real HTTP; list's quiet and readiness lookups are injected or served by the same stub.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { allowFetchTarget } from "./fetch-guard.js";
import { createProgram } from "../src/index.js";
import { addHumanFragment } from "@openrig/daemon/gateway-human-registry";

const window = { kind: "daily", timezone: "Europe/Berlin", start: "22:00", end: "07:00", source: "manual", revision: 1,
  setBy: "orch@demo", setAt: "2026-10-20T12:00:00.000Z" };
const offState = { active: false, revision: 1, nextBoundary: { kind: "start", at: "2026-10-20T20:00:00.000Z" } };

describe("rig gateway human quiet", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevUrl: string | undefined;
  let server: Server;
  let requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }>;
  let reply: { status: number; body: unknown };
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "quiet-verb-"));
    prevHome = process.env.OPENRIG_HOME; process.env.OPENRIG_HOME = home;
    expect(addHumanFragment({ entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
      prefs: { deliveryClass: "B", availability: "focus" },
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://slack/mike", role: "primary" }] }, home).ok).toBe(true);
    requests = [];
    reply = { status: 200, body: { ok: true, entityId: "mike", window, state: offState } };
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

  it("set --daily sends the rule, the zone and the actor, and reads the window back in one line", async () => {
    await run("quiet", "set", "mike", "--daily", "22:00-07:00", "--tz", "Europe/Berlin", "--actor", "operator-alex");
    expect(requests).toEqual([{ method: "PUT", url: "/api/gateway/human/mike/quiet",
      body: { daily: "22:00-07:00", timezone: "Europe/Berlin", actor: "operator-alex" } }]);
    expect(logs).toEqual(["mike quiet: off (every day 22:00-07:00 Europe/Berlin; set by orch@demo, manual, revision 1; next starts 2026-10-20T20:00:00.000Z)"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("set --until without --tz uses this machine's zone, and says so in the request", async () => {
    await run("quiet", "set", "mike", "--until", "09:00");
    expect(requests[0]!.body).toMatchObject({ until: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it("set without --tz says which zone it stored and how to choose the person's own; with --tz it says nothing extra", async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await run("quiet", "set", "mike", "--daily", "22:00-07:00");
    expect(logs).toContain(`stored in ${zone}; pass --tz for the person's own zone`);
    logs.length = 0;
    await run("quiet", "set", "mike", "--daily", "22:00-07:00", "--tz", "Europe/Berlin");
    expect(logs.some((l) => l.startsWith("stored in "))).toBe(false);
  });

  it("end, clear and show reach their routes; an active window shows when it ends", async () => {
    reply = { status: 200, body: { ok: true, window, state: { active: true, occurrence: "2026-10-20", revision: 1,
      nextBoundary: { kind: "end", at: "2026-10-21T05:00:00.000Z" } } } };
    await run("quiet", "show", "mike");
    await run("quiet", "end", "mike");
    reply = { status: 200, body: { ok: true, window: null, state: { active: false, nextBoundary: null } } };
    await run("quiet", "clear", "mike");
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/gateway/human/mike/quiet", "POST /api/gateway/human/mike/quiet/end", "POST /api/gateway/human/mike/quiet/clear"]);
    expect(logs).toEqual([
      "mike quiet: on (every day 22:00-07:00 Europe/Berlin; set by orch@demo, manual, revision 1; ends 2026-10-21T05:00:00.000Z)",
      "mike quiet: on (every day 22:00-07:00 Europe/Berlin; set by orch@demo, manual, revision 1; ends 2026-10-21T05:00:00.000Z)",
      "mike quiet: none set",
    ]);
  });

  it("an occurrence ended early is named by its date, not as tonight's, however long ago it was", async () => {
    reply = { status: 200, body: { ok: true, window: { ...window, ended: { occurrence: "2026-10-19", by: "orch@demo", at: "2026-10-20T02:00:00.000Z" } },
      state: { active: false, revision: 1, nextBoundary: { kind: "start", at: "2026-10-22T20:00:00.000Z" } } } };
    await run("quiet", "show", "mike");
    expect(logs).toEqual(["mike quiet: off (every day 22:00-07:00 Europe/Berlin; set by orch@demo, manual, revision 1; next starts 2026-10-22T20:00:00.000Z; the 2026-10-19 occurrence ended early by orch@demo)"]);
  });

  it("an until-time window ended early says so without naming a night", async () => {
    reply = { status: 200, body: { ok: true, window: { kind: "until", timezone: "UTC", until: "2026-10-20T18:00:00.000Z", source: "manual", revision: 1,
      setBy: "orch@demo", setAt: "2026-10-20T12:00:00.000Z", ended: { occurrence: "until", by: "mike", at: "2026-10-20T13:00:00.000Z" } },
      state: { active: false, revision: 1, nextBoundary: null } } };
    await run("quiet", "end", "mike");
    expect(logs).toEqual(["mike quiet: off (until 2026-10-20T18:00:00.000Z (UTC); set by orch@demo, manual, revision 1; ended early by mike)"]);
  });

  it("a refusal prints the daemon's message and exits nonzero", async () => {
    reply = { status: 400, body: { error: "invalid_timezone", message: 'unknown timezone "Mars/Olympus": use an IANA name, for example Europe/Berlin or America/New_York' } };
    await run("quiet", "set", "mike", "--daily", "22:00-07:00", "--tz", "Mars/Olympus");
    expect(errors).toEqual(['refused: unknown timezone "Mars/Olympus": use an IANA name, for example Europe/Berlin or America/New_York']);
    expect(process.exitCode).toBe(1);
  });

  it("list shows the person's actual availability and their quiet hours", async () => {
    await run("list");
    const out = logs.join("\n");
    expect(out).toMatch(/^mike {2}"Mike" {2}class=B {2}focus {2}bindings=1/m);
    expect(out).toContain("  quiet: off (every day 22:00-07:00 Europe/Berlin; set by orch@demo, manual, revision 1; next starts 2026-10-20T20:00:00.000Z)");
    logs.length = 0;
    await run("list", "--json");
    const listed = JSON.parse(logs.at(-1)!).humans[0];
    expect(listed).toMatchObject({ availability: "focus", quiet: { window: { kind: "daily" }, state: { active: false } } });
  });

  it("list says when quiet hours couldn't be read, rather than implying there are none", async () => {
    reply = { status: 503, body: { error: "quiet_hours_unavailable", message: "fixture" } };
    await run("list");
    expect(logs.join("\n")).toContain("  quiet: unknown (quiet hours could not be read from the daemon: HTTP 503: quiet_hours_unavailable: fixture)");
  });
});
