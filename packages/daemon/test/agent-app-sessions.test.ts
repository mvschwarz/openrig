import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentAppPreset, type AgentAppSessionSpec } from "../src/domain/agent-app-presets.js";
import {
  agentAppSessionExists, checkAgentAppSessionId, listAgentAppSessions, parseSessionList, pickSeatSession,
  renderSessionArgv, shellLineFor, sqliteUtcToMs,
} from "../src/domain/agent-app-sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const appScript = resolve(here, "fixtures/agent-app/synth-session-app.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "agent-app-sessions-")); dirs.push(dir); return dir; };

const BASE = "format: 2\nname: synth\ncommand: synth-app\nmaintainer: Example Maintainer\nlimits: [fork unsupported]\n";
const SESSION = "session:\n  id_pattern: '^ses_[A-Za-z0-9]{8,40}$'\n  resume: [synth-app, --session, '{session_id}']\n  exists: [synth-app, export, '{session_id}']\n  list: [synth-app, session, list, --format, json]\n";
const load = (body: string) => { const dir = scratch(); writeFileSync(join(dir, "synth.yaml"), body); return loadAgentAppPreset("synth", dir); };
const SPEC: AgentAppSessionSpec = { idPattern: "^ses_[A-Za-z0-9]{8,40}$", resume: ["synth-app", "--session", "{session_id}"],
  exists: ["node", appScript, "export", "{session_id}"], list: ["node", appScript, "session", "list", "--format", "json"] };

describe("format 2 presets", () => {
  it("reads a session block", () => {
    expect(load(BASE + SESSION)).toMatchObject({ ok: true, preset: { session: {
      idPattern: "^ses_[A-Za-z0-9]{8,40}$", resume: ["synth-app", "--session", "{session_id}"],
      exists: ["synth-app", "export", "{session_id}"], list: ["synth-app", "session", "list", "--format", "json"] } } });
  });
  it("still reads format 1, which has no session block", () => {
    const found = load(BASE.replace("format: 2", "format: 1"));
    expect(found.ok && found.preset.session).toBeUndefined();
    expect(load(BASE.replace("format: 2", "format: 1") + SESSION)).toMatchObject({ ok: false, message: expect.stringContaining("unknown field session (format 1 has") });
  });
  it.each([
    ["format 3", BASE.replace("format: 2", "format: 3"), "it declares format 3; this OpenRig reads formats 1 and 2"],
    ["an unanchored pattern", BASE + SESSION.replace("'^ses_[A-Za-z0-9]{8,40}$'", "'ses_.*'"), "session: id_pattern must be a regular expression anchored with ^ and $"],
    ["a resume line instead of an argv", BASE + SESSION.replace("[synth-app, --session, '{session_id}']", "'synth-app --session {session_id}'"), "session: resume must be a non-empty list of strings"],
    ["resume without the placeholder", BASE + SESSION.replace("[synth-app, --session, '{session_id}']", "[synth-app, --continue]"), "session: resume must hold {session_id} as one element"],
    ["a placeholder inside an element", BASE + SESSION.replace("[synth-app, --session, '{session_id}']", "[synth-app, '--session={session_id}']"), "session: resume: {session_id} must be a whole element"],
    ["the placeholder as the program", BASE + SESSION.replace("[synth-app, --session, '{session_id}']", "['{session_id}']"), "session: resume: the first element is the program"],
    ["a list that takes the id", BASE + SESSION.replace("[synth-app, session, list, --format, json]", "[synth-app, '{session_id}']"), "session: list can't hold {session_id}"],
    ["an unknown session field", BASE + SESSION + "  fork: [synth-app, --fork]\n", "session: unknown field fork"],
  ])("refuses %s", (_label, body, text) => {
    const found = load(body);
    expect(found).toMatchObject({ ok: false, kind: "incompatible" });
    expect(!found.ok && found.message).toContain(text);
  });
});

describe("session ids on a command line", () => {
  it("accepts an id that passes the floor and the preset's pattern", () => {
    expect(checkAgentAppSessionId(SPEC, " ses_abc12345 ")).toEqual({ ok: true, id: "ses_abc12345" });
  });
  it.each([["", "empty"], ["ses_abc12345; rm -rf ~", "hold only letters"], ["ses_'x'aaaaaa", "hold only letters"], ["--help", "start with a letter or digit"], ["..", "start with a letter or digit"], ["a".repeat(201), "at most 200"], ["abc12345678", "doesn't match the preset's id_pattern"], [42, "empty"]])(
    "refuses %j without echoing it", (raw, text) => {
      const r = checkAgentAppSessionId(SPEC, raw);
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining(text) });
      if (typeof raw === "string" && raw) expect(!r.ok && r.error).not.toContain(raw);
    });
  it("fills only whole placeholder elements and quotes every element", () => {
    expect(renderSessionArgv(SPEC.resume, "ses_abc12345")).toEqual(["synth-app", "--session", "ses_abc12345"]);
    expect(shellLineFor(["opencode", "--session", "ses_abc12345"])).toBe("'opencode' '--session' 'ses_abc12345'");
    expect(shellLineFor(["a b", "it's"])).toBe(`'a b' 'it'"'"'s'`);
  });
});

describe("listing and picking a seat's session", () => {
  it("parses the list shape OpenCode 1.x and 2.0 print, dropping rows of another shape", () => {
    const v1 = `[\n  {\n    "id": "ses_eb0008bd3ffefl70GhSQLjB7M2",\n    "title": "New session - 2026-10-18T17:11:43.924Z",\n    "updated": 1792343503926,\n    "created": 1792343503925,\n    "projectId": "global",\n    "directory": "/tmp/w1"\n  }\n]\n`;
    expect(parseSessionList(v1)).toEqual([{ id: "ses_eb0008bd3ffefl70GhSQLjB7M2", created: 1792343503925, directory: "/tmp/w1" }]);
    expect(parseSessionList(`[{"id":"a","created":"x"},{"id":"ses_x","created":1}]`)).toEqual([{ id: "ses_x", created: 1, directory: null }]);
    expect(parseSessionList("Starting background server...\n[]")).toBeNull();
    expect(parseSessionList(`{"id":"x"}`)).toBeNull();
  });
  it("picks exactly one new session in the seat's directory, and nothing when it's ambiguous", () => {
    const seat = { cwds: new Set(["/w", "/private/w"]), launchedAtMs: 1000, heldIds: new Set<string>() };
    const rows = [
      { id: "ses_old00000", created: 999, directory: "/w" },
      { id: "ses_other000", created: 2000, directory: "/elsewhere" },
      { id: "ses_mine0000", created: 1500, directory: "/w" },
    ];
    expect(pickSeatSession(SPEC, rows, seat)).toBe("ses_mine0000");
    expect(pickSeatSession(SPEC, [...rows, { id: "ses_mate0000", created: 1600, directory: "/w" }], seat)).toBeNull();
    expect(pickSeatSession(SPEC, [...rows, { id: "ses_mate0000", created: 1600, directory: "/w" }], { ...seat, heldIds: new Set(["ses_mate0000"]) })).toBe("ses_mine0000");
    expect(pickSeatSession(SPEC, [{ id: "bad id!", created: 1500, directory: "/w" }], seat)).toBeNull();
    expect(pickSeatSession(SPEC, [{ id: "ses_real0000", created: 1500, directory: "/private/w" }], seat)).toBe("ses_real0000");
  });
  it("reads sessions.created_at as UTC", () => {
    expect(sqliteUtcToMs("2026-10-18 17:11:43")).toBe(Date.UTC(2026, 9, 18, 17, 11, 43));
    expect(sqliteUtcToMs(null)).toBeNull();
    expect(sqliteUtcToMs("not a date")).toBeNull();
  });
});

describe("asking the real synthetic app", () => {
  it("lists, checks and picks against a running process, without a shell", async () => {
    const home = scratch();
    const cwd = join(home, "work");
    mkdirSync(cwd);
    const env = { ...process.env, SYNTH_APP_HOME: home };
    expect(await listAgentAppSessions(SPEC, cwd, env)).toEqual([]);
    const launchedAtMs = Date.now();
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "ses_seeded0001.json"), JSON.stringify({ id: "ses_seeded0001", created: launchedAtMs + 5, updated: launchedAtMs + 5, directory: cwd, lines: ["hi"] }));
    const rows = await listAgentAppSessions(SPEC, cwd, env);
    expect(rows).toEqual([{ id: "ses_seeded0001", created: launchedAtMs + 5, directory: cwd }]);
    expect(pickSeatSession(SPEC, rows!, { cwds: new Set([cwd]), launchedAtMs, heldIds: new Set() })).toBe("ses_seeded0001");
    expect(await agentAppSessionExists(SPEC, "ses_seeded0001", cwd, env)).toBe(true);
    expect(await agentAppSessionExists(SPEC, "ses_missing0001", cwd, env)).toBe(false);
    expect(await agentAppSessionExists({ ...SPEC, exists: ["/definitely/not/a/program", "{session_id}"] }, "ses_x0000000", cwd, env)).toBeNull();
    expect(await listAgentAppSessions({ ...SPEC, list: ["node", "-e", "process.exit(3)"] }, cwd, env)).toBeNull();
    expect(await agentAppSessionExists({ ...SPEC, exists: undefined }, "ses_seeded0001", cwd, env)).toBeNull();
  });
});
