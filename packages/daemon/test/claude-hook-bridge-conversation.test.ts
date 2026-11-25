// Slice 15: the hook bridge's second mode, for a person's own conversation (Claude Code or Codex, not a seat). It reads the
// return-route addresses OpenRig issued under the conversation's own key, polls their pending tasks with the installed
// `rig`, and wakes the conversation with each new task and its sender as the daemon recorded it. A seat, a missing key,
// another conversation's key, a running turn, a newer waiter and an already shown or closed task wake nothing. The `rig`
// it runs is OPENRIG_RIG_BIN's, else the one on PATH, else the project's own install; with none, it says so once per session.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bridgePath = require.resolve("../assets/claude-hook-bridge.cjs");
type Proc = { pid: number; ppid: number; start: string; names: string[] };
type Deps = Record<string, unknown>;
const bridge = require(bridgePath) as {
  conversationKey(opts?: { pid?: number; env?: Record<string, string | undefined>; read?: (pid: number) => Proc | null }): string | null;
  conversationKeyTag(key: string): string;
  conversationWaiter(opts: { input: Record<string, unknown>; out: { write(s: string, done?: (err?: Error | null) => void): unknown }; deps: Deps }): Promise<number>;
  conversationTurn(opts: { input: Record<string, unknown>; deps: Deps }): number;
  codexStart(opts: { input: Record<string, unknown>; deps: Deps }): number;
  codexEnd(opts: { input: Record<string, unknown>; deps: Deps }): number;
  codexWatch(opts: { sessionId: string; transcriptPath: string; codexPid?: number; deps: Deps }): Promise<number>;
  renderConversationTasks(fresh: unknown[]): string;
  findRig(opts?: { env?: Record<string, string | undefined>; projectDir?: string }): string | null;
};

const KEY = "claude:1a2b3c4d.5000:4242";
const OTHER_KEY = "claude:1a2b3c4d.6000:5151";
const ROUTE = "conversation-3f2a9c1b7e44@kernel";
const SESSION = "8164b7ca-7d46-4615-98d0-8a74931b6ecd";
const goal = (key = KEY, extra: Record<string, unknown> = {}) => ({ qitemId: "qitem-goal", summary: "Add word counts", state: "handed-off",
  tags: [`conversation-key:${key}`], returnRoute: ROUTE, returnRouteBasis: "issued-actor", ...extra });
const question = (extra: Record<string, unknown> = {}) => ({ qitemId: "qitem-q1", state: "pending", destinationSession: ROUTE,
  sourceSession: "dev-build@starter", summary: "May I run the test suite?", ...extra });
const created = (actor: string, provenance: string | null) => [{ transitionId: 7, actorSession: actor, identityProvenance: provenance, state: "pending" },
  { transitionId: 9, actorSession: "wake-ladder@system", identityProvenance: null, state: "pending" }];

/** A `rig` that answers from fixtures, keyed by what OpenRig holds, and records every call. The tag read answers only for
 *  the exact tag a row carries, as the daemon's exact tag filter does. */
function fakeRig(rows: { goals?: Array<Record<string, unknown>>; pending?: Array<Record<string, unknown>>; transitions?: unknown } = {}) {
  const calls: string[][] = [];
  const rig = (args: string[]) => {
    calls.push(args);
    if (args[0] === "queue" && args[1] === "list" && args[2] === "--tag") return (rows.goals ?? []).filter((g) => (g.tags as string[]).includes(args[3]!));
    if (args[0] === "queue" && args[1] === "list" && args[2] === "--destination") return (rows.pending ?? []).filter((r) => r.destinationSession === args[3]);
    if (args[0] === "queue" && args[1] === "transitions") return rows.transitions ?? created("dev-build@starter", "transport:v1");
    return null;
  };
  return { rig, calls };
}

let data: string;
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "bridge-conversation-")); });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

const sink = () => { let text = ""; return { out: { write: (s: string, done?: (err?: Error | null) => void) => { text += s; done?.(); return true; } }, text: () => text }; };
/** A clock the fake sleep advances, so a waiter's polls and deadline run without waiting. */
const clock = (step = 15_000) => { let t = 1_000_000; return { now: () => t, sleep: async () => { t += step; } }; };
const input = { session_id: SESSION, hook_event_name: "Stop", transcript_path: "" };
const env = () => ({ CLAUDE_PLUGIN_DATA: data });
const stateFile = (name: string, runtime = "claude") => join(data, "conversations", `${runtime}-${SESSION}`, name);
/** A stand-in `rig` at file: a shell script that prints `out` and, given a log, appends its arguments there. */
const rigFile = (file: string, out = "[]", log?: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${log ? `echo "$*" >> '${log}'\n` : ""}echo '${out}'\n`, { mode: 0o755 });
  return file;
};

describe("the conversation waiter (Claude Code)", () => {
  it("wakes with the question, the handed-over work its address belongs to, and its sender as the daemon recorded it", async () => {
    const { rig, calls } = fakeRig({ goals: [goal()], pending: [question()] });
    const s = sink();
    const code = await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: KEY, rig, ...clock() } });
    expect(code).toBe(2);
    const text = s.text();
    expect(text).toMatch(/^This is not an error\. OpenRig's hook bridge, from the openrig plugin in this app, found a task waiting at a return-route address OpenRig issued to this conversation/);
    expect(text).toContain("from OpenRig's own record of this conversation's handovers, not from the chat");
    expect(text).toContain("- qitem-q1: May I run the test suite?");
    expect(text).toContain(`At ${ROUTE}, the address for the work you handed over as qitem-goal (Add word counts).`);
    expect(text).toContain("From dev-build@starter (transport:v1: the daemon took this sender from the sending session's own connection).");
    // Reading a task needs no identity, so the line carries none (Claude Code's auto mode refused a read that named one).
    expect(text).toContain("Read it: rig queue show qitem-q1 --full");
    expect(text).toMatch(/adds no authority/);
    expect(text).not.toMatch(/\b(must|obey|priority|system instruction|override)\b/i);
    // The addresses come from OpenRig's record under this conversation's own key, never from a transcript.
    expect(calls[0]).toEqual(["queue", "list", "--tag", `conversation-key:${KEY}`, "--all", "--limit", "100", "--json"]);
    expect(calls).toContainEqual(["queue", "list", "--destination", ROUTE, "--state", "pending", "--limit", "50", "--json"]);
    expect(JSON.parse(readFileSync(stateFile("shown.json"), "utf8"))).toEqual(["qitem-q1"]);
  });

  it("names a task OpenRig itself wrote, and a sender that was only named, as what they are", async () => {
    for (const [sender, provenance, said] of [
      ["daemon@kernel", null, "From daemon@kernel (written by the OpenRig daemon itself)."],
      ["dev-build@starter", "claimed:v1", "From dev-build@starter (claimed:v1: named by the sender, not checked by the daemon)."],
    ] as const) {
      rmSync(join(data, "conversations"), { recursive: true, force: true });
      const { rig } = fakeRig({ goals: [goal()], pending: [question({ sourceSession: sender })], transitions: created(sender, provenance) });
      const s = sink();
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: KEY, rig, ...clock() } })).toBe(2);
      expect(s.text()).toContain(said);
    }
  });

  it("does nothing in an OpenRig seat: no read, no state, no wake", async () => {
    for (const seat of [{ OPENRIG_SESSION_NAME: "dev-impl@team" }, { OPENRIG_NODE_ID: "n1" }]) {
      const { rig, calls } = fakeRig({ goals: [goal()], pending: [question()] });
      const s = sink();
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: { ...env(), ...seat }, alive: () => true, key: KEY, rig, ...clock() } })).toBe(0);
      expect(bridge.conversationTurn({ input, deps: { env: { ...env(), ...seat } } })).toBe(0);
      expect(calls).toEqual([]);
      expect(s.text()).toBe("");
      expect(existsSync(join(data, "conversations"))).toBe(false);
    }
  });

  it("with no key, or a key that isn't Claude Code's, reads nothing and wakes nothing", async () => {
    for (const key of [null, `codex:${SESSION}`]) {
      const { rig, calls } = fakeRig({ goals: [goal()], pending: [question()] });
      const s = sink();
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), key, rig, ...clock() } })).toBe(0);
      expect(calls).toEqual([]);
      expect(s.text()).toBe("");
    }
  });

  it("another conversation's key reads none of this conversation's addresses, and runs to its deadline without waking", async () => {
    const { rig, calls } = fakeRig({ goals: [goal(KEY)], pending: [question()] });
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: OTHER_KEY, rig, waiterMs: 60_000, ...clock() } })).toBe(0);
    expect(s.text()).toBe("");
    expect(calls.every((args) => args[2] === "--tag" && args[3] === `conversation-key:${OTHER_KEY}`)).toBe(true);
    expect(readFileSync(stateFile("wake.log"), "utf8")).toMatch(/deadline/);
  });

  it("takes only addresses OpenRig issued for this conversation's own creates", async () => {
    for (const row of [
      goal(KEY, { returnRouteBasis: "named" }),                 // an address the caller named, not issued to this conversation
      goal(KEY, { returnRouteBasis: "inherited" }),
      goal(KEY, { returnRoute: `${ROUTE}@host-b` }),            // kept for another host, whose prompts don't come here
    ]) {
      const { rig } = fakeRig({ goals: [row], pending: [question()] });
      const s = sink();
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: KEY, rig, waiterMs: 30_000, ...clock() } })).toBe(0);
      expect(s.text()).toBe("");
    }
    // A row an older daemon returned without the requested tag (it ignored the filter) is never taken.
    const untagged = (args: string[]) => args[2] === "--tag" ? [goal(OTHER_KEY)] : args[2] === "--destination" ? [question()] : [];
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: KEY, rig: untagged, waiterMs: 30_000, ...clock() } })).toBe(0);
    expect(s.text()).toBe("");
  });

  it("never wakes into a running turn, and a newer waiter supersedes it", async () => {
    const { rig } = fakeRig({ goals: [goal()], pending: [question()] });
    const c = clock();
    // A prompt submitted after this waiter armed: a task waits, but nothing is written into the running turn, until the
    // turn's own Stop starts a newer waiter, which replaces this one.
    bridge.conversationTurn({ input, deps: { env: env(), now: () => c.now() + 1 } });
    let ticks = 0;
    const sleep = async () => { ticks += 1; if (ticks === 3) writeFileSync(stateFile("waiter.json"), JSON.stringify({ pid: 999_999 })); await c.sleep(); };
    const held = sink();
    expect(await bridge.conversationWaiter({ input, out: held.out, deps: { env: env(), alive: () => true, key: KEY, rig, now: c.now, sleep, pid: 123 } })).toBe(0);
    expect(held.text()).toBe("");
    expect(readFileSync(stateFile("wake.log"), "utf8")).toMatch(/superseded/);
    // The Stop waiter, armed after that turn's prompt, wakes with the task.
    const woke = sink();
    expect(await bridge.conversationWaiter({ input, out: woke.out, deps: { env: env(), alive: () => true, key: KEY, rig, now: () => c.now() + 10, sleep: c.sleep, pid: 124 } })).toBe(2);
    expect(woke.text()).toContain("qitem-q1");
  });

  it("a task already shown in this session, or one closed before it was shown (superseded), wakes nothing", async () => {
    const first = fakeRig({ goals: [goal()], pending: [question()] });
    expect(await bridge.conversationWaiter({ input, out: sink().out, deps: { env: env(), alive: () => true, key: KEY, rig: first.rig, ...clock() } })).toBe(2);
    // The agent left it pending: the next waiter doesn't wake for it again, so a pending task can't loop the conversation.
    const again = sink();
    expect(await bridge.conversationWaiter({ input, out: again.out, deps: { env: env(), alive: () => true, key: KEY, rig: first.rig, waiterMs: 45_000, ...clock() } })).toBe(0);
    expect(again.text()).toBe("");
    // A relay the seat's prompt clearing closed as superseded before any waiter read it isn't a pending task.
    const closed = fakeRig({ goals: [goal()], pending: [question({ qitemId: "qitem-q2", state: "canceled", closureReason: "superseded" })] });
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: KEY, rig: closed.rig, waiterMs: 45_000, ...clock() } })).toBe(0);
    expect(s.text()).toBe("");
  });

  it("stops when its Claude Code process has exited, rather than polling to its deadline", async () => {
    const { rig, calls } = fakeRig({ goals: [goal()], pending: [] });
    const s = sink();
    // The key names claude pid 4242; that process is gone.
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: (pid: number) => pid !== 4242, key: KEY, rig, ...clock() } })).toBe(0);
    expect(calls).toEqual([]);
    expect(readFileSync(stateFile("wake.log"), "utf8")).toMatch(/stopped: the conversation's claude process ended/);
  });

  it("a failed write wakes nothing and leaves the task to be shown again", async () => {
    const { rig } = fakeRig({ goals: [goal()], pending: [question()] });
    const out = { write: (_s: string, done?: (err?: Error | null) => void) => { done?.(new Error("EPIPE")); return false; } };
    expect(await bridge.conversationWaiter({ input, out, deps: { env: env(), alive: () => true, key: KEY, rig, ...clock() } })).toBe(0);
    expect(existsSync(stateFile("shown.json"))).toBe(false);
  });

  it("reads the routes again only when the transcript grows, so an idle conversation costs a file size per poll", async () => {
    const { rig, calls } = fakeRig({ goals: [] });
    let size = 100;
    let ticks = 0;
    const c = clock();
    const sleep = async () => { ticks += 1; if (ticks === 3) size = 250; await c.sleep(); };
    expect(await bridge.conversationWaiter({ input: { ...input, transcript_path: "/t.jsonl" }, out: sink().out,
      deps: { env: env(), alive: () => true, key: KEY, rig, now: c.now, sleep, statSize: () => size, waiterMs: 90_000 } })).toBe(0);
    expect(calls.filter((args) => args[2] === "--tag")).toHaveLength(2);
  });
});

describe("the Codex watcher", () => {
  const codexInput = { session_id: SESSION, transcript_path: "/rollout.jsonl", cwd: "/project" };
  const codexKey = `codex:${SESSION}`;

  it("SessionStart starts one detached watcher; a live one is kept; SessionEnd stops it", () => {
    const spawned: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = (_cmd: string, args: string[], options: Record<string, unknown>) => { spawned.push({ args, options }); return { pid: 4321, unref() {} }; };
    expect(bridge.codexStart({ input: codexInput, deps: { env: env(), spawn: fakeSpawn, alive: () => true, codexPid: 3131 } })).toBe(0);
    expect(spawned).toHaveLength(1);
    // The watcher is told which Codex process to outlive no longer than.
    expect(spawned[0]!.args.slice(1)).toEqual(["codex-watch", SESSION, "/rollout.jsonl", "3131"]);
    expect(spawned[0]!.options).toMatchObject({ detached: true, stdio: "ignore", cwd: "/project" });
    // A resumed or compacted session starts again: the live watcher is enough.
    expect(bridge.codexStart({ input: codexInput, deps: { env: env(), spawn: fakeSpawn, alive: () => true } })).toBe(0);
    expect(spawned).toHaveLength(1);
    bridge.codexEnd({ input: codexInput, deps: { env: env() } });
    expect(existsSync(stateFile("stop.json", "codex"))).toBe(true);
    // A seat, or input with no session id, starts nothing.
    expect(bridge.codexStart({ input: codexInput, deps: { env: { ...env(), OPENRIG_NODE_ID: "n1" }, spawn: fakeSpawn, alive: () => false } })).toBe(0);
    expect(bridge.codexStart({ input: { cwd: "/project" }, deps: { env: env(), spawn: fakeSpawn, alive: () => false } })).toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it("queues each new task for the thread with codex queue, retries a failed queue, and stops when the session ends", async () => {
    const { rig, calls } = fakeRig({ goals: [goal(codexKey)], pending: [question()] });
    const queued: string[] = [];
    let attempts = 0;
    const queue = (text: string) => { attempts += 1; if (attempts === 1) return { ok: false, detail: "no daemon" }; queued.push(text); return { ok: true, detail: "" }; };
    const c = clock();
    let ticks = 0;
    const sleep = async () => { ticks += 1; if (ticks === 4) bridge.codexEnd({ input: codexInput, deps: { env: env() } }); await c.sleep(); };
    const code = await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", deps: { env: env(), rig, queue, now: c.now, sleep, statSize: () => 10, pid: 77 } });
    expect(code).toBe(0);
    expect(attempts).toBe(2);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain("- qitem-q1: May I run the test suite?");
    expect(queued[0]).toContain("From dev-build@starter (transport:v1:");
    expect(calls[0]).toEqual(["queue", "list", "--tag", `conversation-key:${codexKey}`, "--all", "--limit", "100", "--json"]);
    const log = readFileSync(stateFile("wake.log", "codex"), "utf8");
    expect(log).toMatch(/codex queue failed, tried again next tick: no daemon/);
    expect(log).toMatch(/queued for the thread \(stored, not proof it was read\): qitem-q1/);
    expect(log).toMatch(/stopped: the session ended/);
  });

  it("stops when its Codex process is gone, though no SessionEnd came", async () => {
    const { rig } = fakeRig({ goals: [goal(codexKey)], pending: [] });
    let up = true;
    const c = clock();
    let ticks = 0;
    const sleep = async () => { ticks += 1; if (ticks === 2) up = false; await c.sleep(); };
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", codexPid: 3131,
      deps: { env: env(), rig, queue: () => ({ ok: true, detail: "" }), now: c.now, sleep, statSize: () => 10, pid: 77, alive: (pid: number) => pid === 3131 && up } })).toBe(0);
    expect(readFileSync(stateFile("wake.log", "codex"), "utf8")).toMatch(/stopped: the session's codex process ended/);
  });

  it("does nothing in a seat or without a session id", async () => {
    const { rig, calls } = fakeRig({ goals: [goal(codexKey)], pending: [question()] });
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "", deps: { env: { ...env(), OPENRIG_SESSION_NAME: "a@b" }, rig } })).toBe(0);
    expect(await bridge.codexWatch({ sessionId: "not-a-session", transcriptPath: "", deps: { env: env(), rig } })).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("the `rig` the plugin runs (findRig, shared by the hooks and the MCP launcher)", () => {
  const at = (rel: string) => join(data, rel);

  it("is OPENRIG_RIG_BIN when it names a runnable file, ahead of PATH and the project", () => {
    const chosen = rigFile(at("custom/rig-dev"));
    rigFile(at("path/rig"));
    rigFile(at("project/node_modules/.bin/rig"));
    expect(bridge.findRig({ env: { OPENRIG_RIG_BIN: chosen, PATH: at("path"), CLAUDE_PROJECT_DIR: at("project") } })).toBe(chosen);
  });

  it("is the first `rig` on PATH, ahead of the project's own install", () => {
    const onPath = rigFile(at("second/rig"));
    rigFile(at("project/node_modules/.bin/rig"));
    expect(bridge.findRig({ env: { PATH: [at("first"), at("second")].join(delimiter), CLAUDE_PROJECT_DIR: at("project") } })).toBe(onPath);
    // An OPENRIG_RIG_BIN that names nothing runnable doesn't hide a working one.
    expect(bridge.findRig({ env: { OPENRIG_RIG_BIN: at("missing/rig"), PATH: at("second") } })).toBe(onPath);
  });

  it("is the project's own install when nothing else names one: Claude Code's CLAUDE_PROJECT_DIR, or the folder given", () => {
    const local = rigFile(at("project/node_modules/.bin/rig"));
    expect(bridge.findRig({ env: { PATH: at("empty"), CLAUDE_PROJECT_DIR: at("project") } })).toBe(local);
    expect(bridge.findRig({ env: { PATH: at("empty") }, projectDir: at("project") })).toBe(local);
  });

  it("is none when nothing names a runnable `rig`: a file that can't run, or a folder named rig, isn't one", () => {
    mkdirSync(at("path/rig"), { recursive: true });
    mkdirSync(at("project/node_modules/.bin"), { recursive: true });
    writeFileSync(at("project/node_modules/.bin/rig"), "#!/bin/sh\n", { mode: 0o644 });
    expect(bridge.findRig({ env: { OPENRIG_RIG_BIN: at("missing/rig"), PATH: at("path"), CLAUDE_PROJECT_DIR: at("project") } })).toBeNull();
    expect(bridge.findRig({ env: {} })).toBeNull();
  });
});

describe("with no `rig` to run", () => {
  const noRig = () => ({ CLAUDE_PLUGIN_DATA: data, PATH: join(data, "no-bin"), CLAUDE_PROJECT_DIR: join(data, "project") });

  it("Claude Code: says once for the plugin's install that the wake can't run and how to fix it; later Stops and other sessions stay quiet", async () => {
    const waiter = (session: string, env = noRig()) => {
      const s = sink();
      return bridge.conversationWaiter({ input: { ...input, session_id: session }, out: s.out,
        deps: { env, alive: () => true, key: KEY, waiterMs: 15_000, ...clock() } }).then((code) => ({ code, text: s.text() }));
    };
    const first = await waiter(SESSION);
    expect(first.code).toBe(2);
    expect(first.text).toMatch(/^OpenRig's automatic wake can't run in this conversation: the openrig plugin found no `rig` command/);
    expect(first.text).toContain("npm install -g @openrig/cli");
    expect(first.text).toContain("OPENRIG_RIG_BIN");
    expect(first.text).not.toMatch(/\b(must|obey|priority|system instruction|override)\b/i);
    // The marker sits in the plugin's data folder, beside every conversation's.
    expect(existsSync(join(data, "no-rig.json"))).toBe(true);
    // Every later Stop in this session: nothing written, no wake, and no polling to a deadline.
    for (let stop = 0; stop < 3; stop++) expect(await waiter(SESSION)).toEqual({ code: 0, text: "" });
    expect(readFileSync(stateFile("wake.log"), "utf8").match(/no rig: told once for this plugin install/g)).toHaveLength(1);
    // Another session (another project's, say) isn't told again.
    expect(await waiter("second-session")).toEqual({ code: 0, text: "" });
    // A `rig` found again clears the marker, so losing it later is told once more, in the next session without one.
    const local = rigFile(join(data, "project/node_modules/.bin/rig"));
    expect(await waiter("third-session")).toEqual({ code: 0, text: "" });
    expect(existsSync(join(data, "no-rig.json"))).toBe(false);
    rmSync(local);
    const fourth = await waiter("fourth-session");
    expect(fourth).toEqual({ code: 2, text: first.text });
    expect(await waiter("fifth-session")).toEqual({ code: 0, text: "" });
  });

  it("Claude Code: a seat, or a conversation with no key, is never told", async () => {
    for (const [extra, key] of [[{ OPENRIG_SESSION_NAME: "dev-impl@team" }, KEY], [{}, null]] as const) {
      const s = sink();
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: { ...noRig(), ...extra }, alive: () => true, key, ...clock() } })).toBe(0);
      expect(s.text()).toBe("");
    }
  });

  it("Codex: the watcher queues the same notice once for the plugin's install and stops; a found `rig` re-arms it", async () => {
    const queued: string[] = [];
    const queue = (text: string) => { queued.push(text); return { ok: true, detail: "" }; };
    const OTHER = "0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011";
    const THIRD = "1f1e2d3c-4b5a-6978-8a9b-acbdcedf0022";
    const watch = (sessionId: string, deps: Record<string, unknown> = {}) => bridge.codexWatch({ sessionId, transcriptPath: "",
      deps: { env: noRig(), projectDir: join(data, "project"), queue, pid: 77, ...clock(), ...deps } });
    // The same session started twice, then another session: one notice.
    for (const session of [SESSION, SESSION, OTHER]) expect(await watch(session)).toBe(0);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatch(/^OpenRig's automatic wake can't run in this conversation/);
    expect(existsSync(join(data, "no-rig.json"))).toBe(true);
    // A watcher that finds a `rig` clears the marker; the next session without one is told again.
    let ticks = 0;
    const c = clock();
    const sleep = async () => { ticks += 1; if (ticks === 1) bridge.codexEnd({ input: { session_id: THIRD }, deps: { env: noRig() } }); await c.sleep(); };
    expect(await watch(THIRD, { rig: () => [], now: c.now, sleep })).toBe(0);
    expect(existsSync(join(data, "no-rig.json"))).toBe(false);
    expect(await watch("2f1e2d3c-4b5a-6978-8a9b-acbdcedf0033")).toBe(0);
    expect(queued).toHaveLength(2);
  });

  it("finds a `rig` installed only in the project and reads OpenRig through it (Claude Code's project, a Codex session's folder)", async () => {
    const log = join(data, "rig-calls.log");
    rigFile(join(data, "project/node_modules/.bin/rig"), "[]", log);
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: noRig(), alive: () => true, key: KEY, waiterMs: 15_000, ...clock() } })).toBe(0);
    expect(s.text()).toBe("");
    expect(readFileSync(log, "utf8")).toBe(`queue list --tag conversation-key:${KEY} --all --limit 100 --json\n`);
    const c = clock();
    let ticks = 0;
    const sleep = async () => { ticks += 1; if (ticks === 1) bridge.codexEnd({ input: { session_id: SESSION }, deps: { env: noRig() } }); await c.sleep(); };
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "", deps: { env: { CLAUDE_PLUGIN_DATA: data, PATH: join(data, "no-bin") },
      projectDir: join(data, "project"), queue: () => ({ ok: true, detail: "" }), pid: 77, now: c.now, sleep } })).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(`queue list --tag conversation-key:codex:${SESSION} --all --limit 100 --json\n`);
  });
});

describe("the conversation key", () => {
  /** A process table: pid -> [ppid, names]. */
  const table = (rows: Record<number, [number, string[]]>) => (pid: number): Proc | null =>
    rows[pid] ? { pid, ppid: rows[pid]![0], start: `boot.${pid * 10}`, names: rows[pid]![1] } : null;
  const UUID = "019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";

  it("is the nearest Claude Code process, by start time and pid, for a Bash command and a hook alike", () => {
    const read = table({ 50: [40, ["node", "node"]], 40: [30, ["bash", "/bin/bash"]], 30: [20, ["claude", "claude"]], 20: [1, ["zsh", "-zsh"]],
      60: [30, ["node", "node"]] });
    expect(bridge.conversationKey({ pid: 50, env: {}, read })).toBe("claude:boot.300:30");
    expect(bridge.conversationKey({ pid: 60, env: {}, read })).toBe("claude:boot.300:30");
  });

  it("is Codex's root session id when Codex is nearest, CODEX_SESSION_ID before CODEX_THREAD_ID", () => {
    const read = table({ 50: [40, ["node", "node"]], 40: [30, ["bash", "bash"]], 30: [1, ["codex", "/usr/lib/codex/codex"]] });
    expect(bridge.conversationKey({ pid: 50, env: { CODEX_SESSION_ID: UUID, CODEX_THREAD_ID: "11111111-2222-3333-4444-555555555555" }, read })).toBe(`codex:${UUID}`);
    expect(bridge.conversationKey({ pid: 50, env: { CODEX_THREAD_ID: UUID.toUpperCase() }, read })).toBe(`codex:${UUID}`);
    expect(bridge.conversationKey({ pid: 50, env: {}, read }), "Codex nearest with no id: no key").toBeNull();
    expect(bridge.conversationKey({ pid: 50, env: { CODEX_SESSION_ID: "not-a-uuid" }, read })).toBeNull();
  });

  it("never takes an outer Codex's id for a Claude Code conversation inside it", () => {
    // Claude Code launched from a Codex shell inherits CODEX_SESSION_ID; its own commands still key to Claude Code.
    const nested = table({ 50: [40, ["node", "node"]], 40: [30, ["claude", "claude"]], 30: [20, ["bash", "bash"]], 20: [1, ["codex", "codex"]] });
    expect(bridge.conversationKey({ pid: 50, env: { CODEX_SESSION_ID: UUID, CLAUDECODE: "1" }, read: nested })).toBe("claude:boot.400:40");
    // With the ancestors hidden (a sandbox), Codex's id is taken only where Claude Code isn't the runner.
    const hidden = table({ 50: [1, ["node", "node"]] });
    expect(bridge.conversationKey({ pid: 50, env: { CODEX_SESSION_ID: UUID }, read: hidden })).toBe(`codex:${UUID}`);
    expect(bridge.conversationKey({ pid: 50, env: { CODEX_SESSION_ID: UUID, CLAUDECODE: "1" }, read: hidden })).toBeNull();
    expect(bridge.conversationKey({ pid: 50, env: {}, read: hidden })).toBeNull();
    expect(bridge.conversationKey({ pid: 50, env: {}, read: () => null })).toBeNull();
  });

  // Linux: a real process tree, with a stand-in `claude` (node, run under that name). Its Bash-style child and its
  // hook-style child derive the same key; another `claude` derives another.
  it.skipIf(process.platform !== "linux")("is the same for a command and a hook of one real claude process, and differs between two", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    try {
      const claude = join(dir, "claude");
      symlinkSync(process.execPath, claude);
      const keyScript = join(dir, "key.cjs");
      writeFileSync(keyScript, `process.stdout.write(String(require(${JSON.stringify(bridgePath)}).conversationKey({ env: {} })) + "\\n");`);
      const app = join(dir, "app.cjs");
      // As Claude Code runs them: a Bash command through bash -c, a hook through sh -c with exec.
      writeFileSync(app, `const { execFileSync } = require("node:child_process");
        const bash = execFileSync("/bin/sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${keyScript}"`)}], { encoding: "utf8" }).trim();
        const hook = execFileSync("/bin/sh", ["-c", ${JSON.stringify(`exec "${process.execPath}" "${keyScript}"`)}], { encoding: "utf8" }).trim();
        process.stdout.write(JSON.stringify({ pid: process.pid, bash, hook }));`);
      const run = () => JSON.parse(execFileSync(claude, [app], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } })) as { pid: number; bash: string; hook: string };
      const one = run();
      const two = run();
      expect(one.bash).toMatch(new RegExp(`^claude:[^:]+:${one.pid}$`));
      expect(one.hook).toBe(one.bash);
      expect(two.bash).toBe(two.hook);
      expect(two.bash).not.toBe(one.bash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the conversation hooks, run as Claude Code runs them", () => {
  it("exit at once in a seat and with no hook input, never waiting on stdin or the daemon", () => {
    for (const mode of ["conversation-waiter", "conversation-turn", "codex-start", "codex-end"]) {
      const started = Date.now();
      execFileSync(process.execPath, [bridgePath, mode], { input: JSON.stringify({ session_id: SESSION }),
        env: { PATH: process.env.PATH ?? "", OPENRIG_SESSION_NAME: "dev-impl@team", CLAUDE_PLUGIN_DATA: data }, timeout: 10_000 });
      expect(Date.now() - started, mode).toBeLessThan(5_000);
    }
    expect(existsSync(join(data, "conversations"))).toBe(false);
    // Outside a seat the same turn hook records its marker, so the quiet above is the seat guard, not a missing mode.
    execFileSync(process.execPath, [bridgePath, "conversation-turn"], { input: JSON.stringify({ session_id: SESSION }),
      env: { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_DATA: data }, timeout: 10_000 });
    expect(existsSync(stateFile("turn.json"))).toBe(true);
  });
});
