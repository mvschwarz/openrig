// Slice 15: the hook bridge's second mode, for a person's own conversation (Claude Code or Codex, not a seat). It reads the
// return-route addresses OpenRig issued under the conversation's own key, polls their pending tasks with the installed
// `rig`, and wakes the conversation with each new task and its sender as the daemon recorded it. A seat, a missing key,
// another conversation's key, a running turn, a newer waiter and an already shown or closed task wake nothing. The `rig`
// it runs is OPENRIG_RIG_BIN's, else the one on PATH, else the project's own install; with none, it says so once per session.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
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
  processReader(): (pid: number) => Proc | null;
  conversationWaiter(opts: { input: Record<string, unknown>; out: { write(s: string, done?: (err?: Error | null) => void): unknown }; deps: Deps }): Promise<number>;
  conversationTurn(opts: { input: Record<string, unknown>; deps: Deps }): number;
  codexStart(opts: { input: Record<string, unknown>; deps: Deps }): number;
  codexEnd(opts: { input: Record<string, unknown>; deps: Deps }): number;
  codexWatch(opts: { sessionId: string; transcriptPath: string; codexPid?: number; codexPidStart?: string; deps: Deps }): Promise<number>;
  renderConversationTasks(fresh: unknown[]): string;
  findRig(opts?: { env?: Record<string, string | undefined>; projectDir?: string }): string | null;
  loginShellPath(opts?: { env?: Record<string, string | undefined> }): string | null;
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

  it("another conversation's key reads none of this conversation's addresses, and stops without waking", async () => {
    const { rig, calls } = fakeRig({ goals: [goal(KEY)], pending: [question()] });
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: OTHER_KEY, rig, waiterMs: 60_000, ...clock() } })).toBe(0);
    expect(s.text()).toBe("");
    expect(calls).toEqual([["queue", "list", "--tag", `conversation-key:${OTHER_KEY}`, "--all", "--limit", "100", "--json"]]);
    expect(readFileSync(stateFile("wake.log"), "utf8")).toMatch(/no address under this conversation's key/);
  });

  // #3964 review F2: every session with the plugin ran a two-hour waiter after every turn. Only a conversation that handed
  // work over with an address of its own waits now: its addresses come from its own turns' creates, and each turn's Stop
  // arms a fresh waiter that reads them again.
  it("with no address under its key, stops at the first read instead of polling to its deadline", async () => {
    const { rig, calls } = fakeRig({ goals: [] });
    let slept = 0;
    const c = clock();
    const s = sink();
    expect(await bridge.conversationWaiter({ input: { ...input, transcript_path: "/t.jsonl" }, out: s.out, deps: { env: env(), alive: () => true,
      key: KEY, rig, now: c.now, sleep: async () => { slept += 1; await c.sleep(); }, statSize: () => 100 } })).toBe(0);
    expect(calls).toEqual([["queue", "list", "--tag", `conversation-key:${KEY}`, "--all", "--limit", "100", "--json"]]);
    expect(slept).toBe(0);
    expect(s.text()).toBe("");
    expect(readFileSync(stateFile("wake.log"), "utf8")).toMatch(/no address under this conversation's key/);
  });

  it("keeps waiting when OpenRig can't be read (its addresses or their tasks), after a longer wait each time, and still wakes for the task", async () => {
    const { rig: answers } = fakeRig({ goals: [goal()], pending: [question()] });
    for (const [label, fails] of [
      ["the addresses", (args: string[]) => args[2] === "--tag"],
      ["the tasks at an address", (args: string[]) => args[2] === "--destination"],
    ] as const) {
      rmSync(join(data, "conversations"), { recursive: true, force: true });
      let failing = 3;
      const sleeps: number[] = [];
      let t = 1_000_000;
      const s = sink();
      // Three failed reads (a daemon restarting, say), then OpenRig answers and the team's task is there.
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: env(), alive: () => true, key: KEY,
        rig: (args: string[]) => (fails(args) && failing-- > 0 ? null : answers(args)),
        now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } } }), label).toBe(2);
      expect(sleeps, label).toEqual([30_000, 60_000, 120_000]);
      expect(s.text(), label).not.toBe("");
      expect(readFileSync(stateFile("wake.log"), "utf8"), label).toMatch(/OpenRig couldn't be read, trying again in 30 s/);
    }
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
    const { rig, calls } = fakeRig({ goals: [goal()], pending: [] });
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
    const codex = { pid: 3131, ppid: 1, start: "1a2b3c4d.31310", names: ["codex", "/usr/lib/codex/codex"] };
    expect(bridge.codexStart({ input: codexInput, deps: { env: env(), spawn: fakeSpawn, alive: () => true, codex } })).toBe(0);
    expect(spawned).toHaveLength(1);
    // The watcher is told which Codex process to outlive no longer than: its pid, and its start time, which tells a later
    // process given the same pid apart.
    expect(spawned[0]!.args.slice(1)).toEqual(["codex-watch", SESSION, "/rollout.jsonl", "3131", "1a2b3c4d.31310"]);
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
    expect(log).toMatch(/codex queue failed, trying again in 30 s: no daemon/);
    expect(log).toMatch(/queued for the thread \(stored, not proof it was read\): qitem-q1/);
    expect(log).toMatch(/stopped: the session ended/);
  });

  // #3964 review F2 and O3: a stopped daemon, or a `codex queue` that keeps failing, was retried every 15 seconds for as
  // long as the session lived, each try spawning `rig` or `codex`. The watcher now waits twice as long after each failed
  // tick, up to five minutes, and polls every 15 seconds again once a read and a queue work.
  it("backs off when OpenRig can't be read or codex queue fails, and polls every 15 seconds again once both work", async () => {
    const { rig: answers } = fakeRig({ goals: [goal(codexKey)], pending: [question()] });
    let up = false;
    let queueWorks = false;
    const queued: string[] = [];
    const queue = (text: string) => { if (!queueWorks) return { ok: false, detail: "codex busy" }; queued.push(text); return { ok: true, detail: "" }; };
    const waits: number[] = [];
    let t = 1_000_000;
    const sleep = async (ms: number) => {
      waits.push(ms);
      t += ms;
      if (waits.length === 3) up = true;
      if (waits.length === 5) queueWorks = true;
      if (waits.length === 7) bridge.codexEnd({ input: codexInput, deps: { env: env() } });
    };
    const code = await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", deps: { env: env(),
      rig: (args: string[]) => up ? answers(args) : null, queue, now: () => t, sleep, statSize: () => 10, pid: 77 } });
    expect(code).toBe(0);
    // Three failed reads, then two failed queues (the failures run on), then a queue that works, then an ordinary poll.
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 15_000, 15_000]);
    expect(queued).toHaveLength(1);
    const log = readFileSync(stateFile("wake.log", "codex"), "utf8");
    expect(log).toMatch(/OpenRig couldn't be read, trying again in 30 s/);
    expect(log).toMatch(/codex queue failed, trying again in 300 s: codex busy/);
  });

  // #3964 review R2: `codex queue --resume` (Codex 0.171.0) starts an idle thread's turn. An older Codex (0.162.1, say)
  // rejects the flag as an unknown argument, so every call failed and the person was never woken or told. Model-free: a
  // stub `codex` on PATH that answers as 0.162.1 does.
  it("on a Codex whose codex queue has no --resume, queues without it for the next turn and tells the thread once", async () => {
    const bin = join(data, "bin");
    const sent = join(data, "sent");
    mkdirSync(bin, { recursive: true });
    mkdirSync(sent, { recursive: true });
    writeFileSync(join(bin, "codex"), [
      "#!/bin/sh",
      `n=$(ls '${sent}' | wc -l | tr -d ' ')`,
      'for a in "$@"; do',
      `  if [ "$a" = "--resume" ]; then echo rejected > '${sent}'/$n.rejected; printf "error: unexpected argument '--resume' found\\n\\n  tip: a similar argument exists: '--remote'\\n" >&2; exit 2; fi`,
      "done",
      // queue --thread <id> --message <text>
      `printf '%s' "$5" > '${sent}'/$n.queued`,
      "",
    ].join("\n"), { mode: 0o755 });
    const pending = [question()];
    const { rig } = fakeRig({ goals: [goal(codexKey)], pending });
    const waits: number[] = [];
    let t = 1_000_000;
    const sleep = async (ms: number) => {
      waits.push(ms);
      t += ms;
      if (waits.length === 2) pending.push(question({ qitemId: "qitem-q2", summary: "Which branch?" }));
      if (waits.length === 4) bridge.codexEnd({ input: codexInput, deps: { env: env() } });
    };
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", deps: {
      env: { ...env(), PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) }, rig, now: () => t, sleep, statSize: () => 10, pid: 77 } })).toBe(0);
    const files = readdirSync(sent).sort();
    // The flag was tried once, then never again: both tasks were queued without it, with no retry or backoff.
    expect(files).toEqual(["0.rejected", "1.queued", "2.queued"]);
    expect(waits).toEqual([15_000, 15_000, 15_000, 15_000]);
    const first = readFileSync(join(sent, "1.queued"), "utf8");
    const second = readFileSync(join(sent, "2.queued"), "utf8");
    expect(first).toMatch(/^This Codex's `codex queue` has no `--resume`/);
    expect(first).toContain("Codex 0.171.0");
    expect(first).toContain("- qitem-q1: May I run the test suite?");
    expect(first).not.toMatch(/\b(must|obey|priority|system instruction|override)\b/i);
    // Said once in the thread: the next task comes on its own.
    expect(second).toMatch(/^This is not an error\. OpenRig's hook bridge/);
    expect(second).toContain("- qitem-q2: Which branch?");
    expect(second).not.toContain("--resume");
    expect(readFileSync(stateFile("wake.log", "codex"), "utf8")).toMatch(/this codex queue has no --resume/);
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
        deps: { env, alive: () => true, key: KEY, waiterMs: 15_000, loginPath: () => null, ...clock() } }).then((code) => ({ code, text: s.text() }));
    };
    const first = await waiter(SESSION);
    expect(first.code).toBe(2);
    expect(first.text).toMatch(/^OpenRig's automatic wake can't run in this conversation: the openrig plugin found no `rig` command/);
    expect(first.text).toContain("npm install -g @openrig/cli");
    // An install whose folder no PATH has (a custom npm prefix with no profile line), or one whose PATH line only an
    // interactive shell reads, is told the fix that works: the login profile for zsh or bash, then a restart.
    expect(first.text).toContain("`npm prefix -g`");
    expect(first.text).toContain("one-off `npm install -g --prefix`");
    expect(first.text).toContain("runs there but not here");
    expect(first.text).toContain("login profile (`~/.zprofile` for zsh, `~/.bash_profile` or `~/.profile` for bash)");
    expect(first.text).toContain("restart this app");
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

  // Reproduced on Claude Code 2.1.330: `rig` installed into a new ~/.local/bin after the app started is on a login shell's
  // PATH, not on the app's, which the hooks inherit, so every later Stop or SessionStart waiter found none.
  it("Claude Code: a `rig` only on a login shell's PATH is found, run with that PATH, and its task wakes the conversation", async () => {
    const loginBin = join(data, "login-bin");
    const log = join(data, "rig-calls.log");
    const rows = { goals: JSON.stringify([goal()]), pending: JSON.stringify([question()]),
      transitions: JSON.stringify(created("dev-build@starter", "transport:v1")) };
    mkdirSync(loginBin, { recursive: true });
    writeFileSync(join(loginBin, "rig"), [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$*" in',
      `  "queue list --tag "*) echo '${rows.goals}' ;;`,
      `  "queue list --destination "*) echo '${rows.pending}' ;;`,
      `  "queue transitions "*) echo '${rows.transitions}' ;;`,
      "  *) echo null ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
    const s = sink();
    const code = await bridge.conversationWaiter({ input, out: s.out,
      deps: { env: noRig(), alive: () => true, key: KEY, waiterMs: 15_000, loginPath: () => [loginBin, "/usr/bin", "/bin"].join(delimiter), ...clock() } });
    expect(code).toBe(2);
    expect(s.text()).toContain("- qitem-q1: May I run the test suite?");
    expect(readFileSync(log, "utf8")).toContain(`queue list --tag conversation-key:${KEY} --all --limit 100 --json\n`);
    expect(existsSync(join(data, "no-rig.json"))).toBe(false);
  });

  it("Claude Code: a seat, or a conversation with no key, is never told", async () => {
    for (const [extra, key] of [[{ OPENRIG_SESSION_NAME: "dev-impl@team" }, KEY], [{}, null]] as const) {
      const s = sink();
      expect(await bridge.conversationWaiter({ input, out: s.out, deps: { env: { ...noRig(), ...extra }, alive: () => true, key, ...clock() } })).toBe(0);
      expect(s.text()).toBe("");
    }
  });

  it("Codex: the watcher queues the same notice once for the plugin's install and keeps looking until its session ends; a found `rig` re-arms it", async () => {
    const queued: string[] = [];
    const queue = (text: string) => { queued.push(text); return { ok: true, detail: "" }; };
    const OTHER = "0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011";
    const THIRD = "1f1e2d3c-4b5a-6978-8a9b-acbdcedf0022";
    // Each watch with no `rig` looks again after a wait; its session ends during that wait, as a SessionEnd would.
    const watch = (sessionId: string, deps: Record<string, unknown> = {}) => {
      const c = clock();
      const sleep = async () => { bridge.codexEnd({ input: { session_id: sessionId }, deps: { env: noRig() } }); await c.sleep(); };
      return bridge.codexWatch({ sessionId, transcriptPath: "",
        deps: { env: noRig(), projectDir: join(data, "project"), queue, pid: 77, loginPath: () => null, now: c.now, sleep, ...deps } });
    };
    // The same session started twice, then another session: one notice.
    for (const session of [SESSION, SESSION, OTHER]) expect(await watch(session)).toBe(0);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatch(/^OpenRig's automatic wake can't run in this conversation/);
    expect(existsSync(join(data, "no-rig.json"))).toBe(true);
    const log = readFileSync(join(data, "conversations", `codex-${OTHER}`, "wake.log"), "utf8");
    expect(log).toMatch(/no rig yet: looking again every 30 s while this session runs/);
    expect(log).toMatch(/stopped: the session ended/);
    // A watcher that finds a `rig` clears the marker; the next session without one is told again.
    let ticks = 0;
    const c = clock();
    const sleep = async () => { ticks += 1; if (ticks === 1) bridge.codexEnd({ input: { session_id: THIRD }, deps: { env: noRig() } }); await c.sleep(); };
    expect(await watch(THIRD, { rig: () => [], now: c.now, sleep })).toBe(0);
    expect(existsSync(join(data, "no-rig.json"))).toBe(false);
    expect(await watch("2f1e2d3c-4b5a-6978-8a9b-acbdcedf0033")).toBe(0);
    expect(queued).toHaveLength(2);
  });

  // wake1 attempt 1 (0.7.24): the person's shell started before `npm install -g --prefix ~/.local` made ~/.local/bin, so
  // Codex's PATH, which the hooks inherit, had no `rig`, while the agent's own commands (run in a login shell) found it.
  // The watcher queued its notice and returned, and the team's question never came in.
  it("Codex: a `rig` that turns up later on a login shell's PATH is found at a later tick, run with that PATH, and its tasks come in", async () => {
    const codexKey = `codex:${SESSION}`;
    const loginBin = join(data, "login-bin");
    const log = join(data, "rig-calls.log");
    // A stand-in `rig` that answers the watcher's three reads and records each call.
    const rows = { goals: JSON.stringify([goal(codexKey)]), pending: JSON.stringify([question()]),
      transitions: JSON.stringify(created("dev-build@starter", "transport:v1")) };
    const installRig = () => {
      mkdirSync(loginBin, { recursive: true });
      writeFileSync(join(loginBin, "rig"), [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        'case "$*" in',
        `  "queue list --tag "*) echo '${rows.goals}' ;;`,
        `  "queue list --destination "*) echo '${rows.pending}' ;;`,
        `  "queue transitions "*) echo '${rows.transitions}' ;;`,
        "  *) echo null ;;",
        "esac",
        "",
      ].join("\n"), { mode: 0o755 });
    };
    const loginPaths: string[] = [];
    const loginPath = () => { const p = [loginBin, "/usr/bin", "/bin"].join(delimiter); loginPaths.push(p); return p; };
    const queued: string[] = [];
    const queue = (text: string) => { queued.push(text); return { ok: true, detail: "" }; };
    const c = clock();
    let ticks = 0;
    const sleep = async () => {
      ticks += 1;
      if (ticks === 2) installRig(); // Installed during the session, after the notice.
      if (ticks === 5) bridge.codexEnd({ input: { session_id: SESSION }, deps: { env: noRig() } });
      await c.sleep();
    };
    const code = await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "",
      deps: { env: noRig(), projectDir: join(data, "project"), queue, pid: 77, loginPath, now: c.now, sleep } });
    expect(code).toBe(0);
    expect(queued[0]).toMatch(/^OpenRig's automatic wake can't run in this conversation/);
    expect(queued).toHaveLength(2);
    expect(queued[1]).toContain("- qitem-q1: May I run the test suite?");
    expect(readFileSync(log, "utf8")).toContain(`queue list --tag conversation-key:${codexKey} --all --limit 100 --json\n`);
    const wake = readFileSync(stateFile("wake.log", "codex"), "utf8");
    expect(wake).toMatch(/no rig yet: looking again every 30 s/);
    expect(wake).toMatch(new RegExp(`watching for ${codexKey}`));
    expect(wake).toMatch(/queued for the thread \(stored, not proof it was read\): qitem-q1/);
    // Found, the `rig` clears the install's marker, so a later loss is told again.
    expect(existsSync(join(data, "no-rig.json"))).toBe(false);
    // The login shell was asked only while no `rig` was found: at the start and after each wait until the install.
    expect(loginPaths.length).toBeGreaterThanOrEqual(2);
    expect(loginPaths.length).toBeLessThanOrEqual(3);
  });

  it("reads a login shell's PATH from after whatever its profile prints", () => {
    const shell = join(data, "fake-shell");
    writeFileSync(shell, ["#!/bin/sh", "echo 'Welcome to the lane'", "PATH='/opt/x/bin:/usr/bin'", 'eval "$2"', ""].join("\n"), { mode: 0o755 });
    expect(bridge.loginShellPath({ env: { SHELL: shell, PATH: "/usr/bin:/bin" } })).toBe("/opt/x/bin:/usr/bin");
    writeFileSync(shell, ["#!/bin/sh", "exit 3", ""].join("\n"), { mode: 0o755 });
    expect(bridge.loginShellPath({ env: { SHELL: shell, PATH: "/usr/bin:/bin" } })).toBeNull();
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
    const rejectInput = join(data, "reject-hook-input.cjs");
    writeFileSync(rejectInput, `Object.defineProperty(process, "stdin", {
      get() { throw new Error("a seat hook must not read stdin"); }
    });`);
    for (const mode of ["conversation-waiter", "conversation-turn", "codex-start", "codex-end"]) {
      const started = Date.now();
      // The seat guard exits without reading: writing input races that exit (EPIPE on macOS).
      // Give it no input; the preload also catches a guard moved after the stdin read.
      execFileSync(process.execPath, ["--require", rejectInput, bridgePath, mode], { stdio: ["ignore", "pipe", "pipe"],
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


describe("conversation delivery beyond the first listing page", () => {
  function pagedRig(goals: Array<Record<string, unknown>>, pending: Array<Record<string, unknown>>) {
    const { rig: read } = fakeRig({ goals, pending });
    return (args: string[]) => {
      const rows = read(args);
      return Array.isArray(rows) && args[1] === "list" ? rows.slice(0, Number(args[args.indexOf("--limit") + 1])) : rows;
    };
  }
  it("brings in every pending task when the newest 50 don't include an older question", async () => {
    const pending = Array.from({ length: 51 }, (_, n) => question({ qitemId: `qitem-backlog-${n}` }));
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: {
      env: env(), alive: () => true, key: KEY, rig: pagedRig([goal()], pending), ...clock()
    } })).toBe(2);
    expect(s.text()).toContain("qitem-backlog-50:");
  });
  it("still finds the original issued route behind 100 newer inherited handoffs", async () => {
    const goals = Array.from({ length: 100 }, (_, n) => goal(KEY, { qitemId: `qitem-handoff-${n}`, returnRouteBasis: "inherited" }));
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: {
      env: env(), alive: () => true, key: KEY, rig: pagedRig([...goals, goal()], [question()]), ...clock()
    } })).toBe(2);
    expect(s.text()).toContain("qitem-q1:");
  });
  it("doesn't forget a shown task after more than 500 tasks in the same session", async () => {
    const pending = Array.from({ length: 501 }, (_, n) => question({ qitemId: `qitem-many-${n}` }));
    const { rig } = fakeRig({ goals: [goal()], pending });
    expect(await bridge.conversationWaiter({ input, out: sink().out, deps: {
      env: env(), alive: () => true, key: KEY, rig, ...clock()
    } })).toBe(2);
    const shown = JSON.parse(readFileSync(stateFile("shown.json"), "utf8"));
    expect(shown).toContain("qitem-many-0");
    expect(shown).toHaveLength(501);
  });
});


describe("the lifetime of a live Codex conversation", () => {
  it("still queues a question after six hours without transcript growth while Codex is alive", async () => {
    let tick = 0;
    const queued: string[] = [];
    const { rig: read } = fakeRig({ goals: [goal(`codex:${SESSION}`)], pending: [question()] });
    const rig = (args: string[]) => args[2] === "--destination" && tick === 0 ? [] : read(args);
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", codexPid: 3131, deps: {
      env: env(), rig, alive: () => queued.length === 0, statSize: () => 1,
      now: () => 1_000_000 + tick * 7 * 3600 * 1000,
      sleep: async () => { tick += 1; },
      queue: (text: string) => { queued.push(text); return { ok: true }; }
    } })).toBe(0);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain("qitem-q1:");
  });
});

// After #3964: a large backlog, and a conversation that lives for days. A fresh backlog went into one `codex queue --message`
// argument, which past Linux's limit on one argument (128 KiB) fails with E2BIG on every try; another conversation's cleanup
// removed a live watcher's folder by the folder's own time, which a heartbeat rewriting its file leaves alone; and a Codex pid
// given to another process kept the watcher running.
describe("a large backlog and a long-lived conversation", () => {
  const codexKey = `codex:${SESSION}`;
  /** CodeRabbit's case on #3964: 501 fresh tasks with 300-character summaries. */
  const backlog = () => Array.from({ length: 501 }, (_, n) => question({ qitemId: `qitem-backlog-${n}`, summary: `Question ${n} `.padEnd(300, "x") }));
  const idsIn = (messages: string[]) => messages.flatMap((text) => [...text.matchAll(/^- (qitem-backlog-\d+):/gm)].map((m) => m[1]!));
  /** A clock whose nth wait ends the session, as Codex's SessionEnd does. */
  const endAt = (n: number) => {
    const c = clock();
    let waits = 0;
    return { now: c.now, sleep: async () => { waits += 1; if (waits === n) bridge.codexEnd({ input: { session_id: SESSION }, deps: { env: env() } }); await c.sleep(); } };
  };

  it("queues a backlog too big for one codex queue argument in batches that fit, every task once and in order, all marked shown", async () => {
    const bin = join(data, "bin");
    const sent = join(data, "sent");
    mkdirSync(bin, { recursive: true });
    mkdirSync(sent, { recursive: true });
    // A stand-in `codex` that stores each message it's given (queue --thread <id> --message <text> --resume). Given one
    // argument past the kernel's limit, it never runs: execve refuses it with E2BIG.
    writeFileSync(join(bin, "codex"), ["#!/bin/sh", `n=$(ls '${sent}' | wc -l | tr -d ' ')`, `printf '%s' "$5" > '${sent}'/$n.queued`, ""].join("\n"), { mode: 0o755 });
    const pending = backlog();
    const { rig } = fakeRig({ goals: [goal(codexKey)], pending });
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", deps: {
      env: { ...env(), PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) }, rig, statSize: () => 10, pid: 77, ...endAt(2) } })).toBe(0);
    expect(readFileSync(stateFile("wake.log", "codex"), "utf8")).not.toMatch(/codex queue failed/);
    const messages = readdirSync(sent).sort((a, b) => parseInt(a) - parseInt(b)).map((file) => readFileSync(join(sent, file), "utf8"));
    expect(messages.length).toBeGreaterThan(1);
    for (const text of messages) {
      expect(Buffer.byteLength(text)).toBeLessThan(128 * 1024);
      expect(text).toMatch(/^This is not an error\. OpenRig's hook bridge/);
    }
    expect(idsIn(messages)).toEqual(pending.map((row) => row.qitemId));
    expect(JSON.parse(readFileSync(stateFile("shown.json", "codex"), "utf8"))).toEqual(pending.map((row) => row.qitemId));
  });

  it("after a batch fails, queues the rest at the next tick: nothing lost, nothing queued twice, only what was stored marked shown", async () => {
    const pending = backlog();
    const { rig } = fakeRig({ goals: [goal(codexKey)], pending });
    const stored: string[] = [];
    let calls = 0;
    // The second batch's `codex queue` fails once (a busy Codex, say).
    const queue = (text: string) => { calls += 1; if (calls === 2) return { ok: false, detail: "codex busy" }; stored.push(text); return { ok: true, detail: "" }; };
    const waits: number[] = [];
    let shownAtFailure: string[] = [];
    let t = 1_000_000;
    const sleep = async (ms: number) => {
      waits.push(ms);
      t += ms;
      if (waits.length === 1) shownAtFailure = JSON.parse(readFileSync(stateFile("shown.json", "codex"), "utf8"));
      if (waits.length === 3) bridge.codexEnd({ input: { session_id: SESSION }, deps: { env: env() } });
    };
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", deps: { env: env(), rig, queue, now: () => t, sleep, statSize: () => 10, pid: 77 } })).toBe(0);
    expect(stored.length).toBeGreaterThan(2);
    // The first batch was stored and marked shown; the one that failed, and those after it, weren't, and came at the next tick.
    expect(shownAtFailure).toEqual(idsIn(stored.slice(0, 1)));
    expect(idsIn(stored)).toEqual(pending.map((row) => row.qitemId));
    expect(waits).toEqual([30_000, 15_000, 15_000]);
    expect(readFileSync(stateFile("wake.log", "codex"), "utf8")).toMatch(/codex queue failed, trying again in 30 s: codex busy/);
  });

  it("another conversation's cleanup keeps a live watcher's folder and an idle conversation whose Claude Code still runs, and removes ended ones", async () => {
    const root = join(data, "conversations");
    const folder = (name: string) => join(root, name);
    const day = 24 * 3600 * 1000;
    /** Sets a folder's and its files' times eight days back, as if nothing had touched them since. */
    const age = (name: string) => {
      const at = new Date(Date.now() - 8 * day);
      for (const file of readdirSync(folder(name))) utimesSync(join(folder(name), file), at, at);
      utimesSync(folder(name), at, at);
    };
    /** A Claude Code conversation's waiter that finds no address under its key: it records itself and ends. */
    const claudeWaiter = (session: string, key: string, deps: Deps = {}) => bridge.conversationWaiter({ input: { session_id: session, hook_event_name: "Stop", transcript_path: "" },
      out: sink().out, deps: { env: env(), key, rig: fakeRig().rig, alive: () => true, ...clock(), ...deps } });
    // The process table the cleanup reads: pid 4242 is still the Claude Code that KEY names; pid 5151, OTHER_KEY's, now
    // belongs to another process.
    const read = (pid: number): Proc | null => pid === 4242 ? { pid, ppid: 1, start: "1a2b3c4d.5000", names: ["claude"] }
      : pid === 5151 ? { pid, ppid: 1, start: "1a2b3c4d.9999", names: ["bash"] } : null;
    const ended = "0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011";
    const { rig } = fakeRig({ goals: [goal(codexKey)], pending: [question()] });
    const c = clock();
    let waits = 0;
    const sleep = async () => {
      waits += 1;
      if (waits === 1) {
        // A week goes by. The live watcher's folder, and three others: a Claude Code conversation idle all week whose process
        // still runs, one whose process is gone (its pid since given to another), and an ended Codex session's.
        await claudeWaiter("idle-session", KEY);
        await claudeWaiter("gone-session", OTHER_KEY);
        mkdirSync(folder(`codex-${ended}`));
        writeFileSync(join(folder(`codex-${ended}`), "watcher.json"), JSON.stringify({ pid: 999_999, beat: 1 }));
        for (const name of [`codex-${SESSION}`, "claude-idle-session", "claude-gone-session", `codex-${ended}`]) age(name);
      }
      if (waits === 2) {
        // The live watcher's heartbeat rewrote its file since, and that leaves the folder's own time a week back.
        expect(Date.now() - statSync(folder(`codex-${SESSION}`)).mtimeMs).toBeGreaterThan(7 * day);
        expect(Date.now() - statSync(stateFile("watcher.json", "codex")).mtimeMs).toBeLessThan(60_000);
        // Another conversation's waiter starts, and cleans up.
        await claudeWaiter("another-session", "claude:1a2b3c4d.8000:6363", { read });
      }
      if (waits === 3) bridge.codexEnd({ input: { session_id: SESSION }, deps: { env: env() } });
      await c.sleep();
    };
    expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", deps: { env: env(), rig,
      queue: () => ({ ok: true, detail: "" }), now: c.now, sleep, statSize: () => 10, pid: 77 } })).toBe(0);
    expect(readdirSync(root).sort()).toEqual(["claude-another-session", "claude-idle-session", `codex-${SESSION}`]);
    // The live watcher kept what it had shown, and ran on until its session ended.
    expect(JSON.parse(readFileSync(stateFile("shown.json", "codex"), "utf8"))).toEqual(["qitem-q1"]);
    expect(readFileSync(stateFile("wake.log", "codex"), "utf8")).toMatch(/stopped: the session ended/);
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("stops when its Codex's pid belongs to another process now, told apart by the start time", async () => {
    // A real process stands in for the session's Codex. A reused pid looks like this to the watcher: the pid answers, with a
    // start time other than the one the watcher was given.
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      const pid = child.pid!;
      const started = bridge.processReader()(pid)!.start;
      const watch = async (start: string, deps: Deps = {}) => {
        rmSync(join(data, "conversations"), { recursive: true, force: true });
        const { rig } = fakeRig({ goals: [goal(codexKey)], pending: [] });
        expect(await bridge.codexWatch({ sessionId: SESSION, transcriptPath: "/rollout.jsonl", codexPid: pid, codexPidStart: start,
          deps: { env: env(), rig, queue: () => ({ ok: true, detail: "" }), statSize: () => 10, pid: 77, ...endAt(3), ...deps } })).toBe(0);
        return readFileSync(stateFile("wake.log", "codex"), "utf8");
      };
      // The process it was given still runs: it watches until the session ends.
      expect(await watch(started)).toMatch(/stopped: the session ended/);
      // The pid now belongs to a process that started at another time: it stops, though the pid answers.
      const reused = await watch(`${started}0`);
      expect(reused).toMatch(/stopped: the session's codex process ended/);
      expect(reused).not.toMatch(/stopped: the session ended/);
      // When the start can't be read, only the pid is checked, as before: an unknown isn't taken for ended.
      expect(await watch(`${started}0`, { read: () => null })).toMatch(/stopped: the session ended/);
    } finally {
      child.kill();
    }
  });
});


describe("the installed rig's JSON read over a long conversation", () => {
  it.skipIf(process.platform === "win32")("reads an ordinary handover history larger than spawnSync's default stdout buffer", async () => {
    const goals = Array.from({ length: 4000 }, (_, n) => goal(KEY, {
      qitemId: `qitem-history-${n}`, summary: `Goal ${n} `.padEnd(300, "x")
    }));
    const fixture = join(data, "rig-data.json");
    writeFileSync(fixture, JSON.stringify({ goals, pending: [question()], transitions: created("dev-build@starter", "transport:v1") }));
    expect(Buffer.byteLength(JSON.stringify(goals))).toBeGreaterThan(1024 * 1024);
    const rig = join(data, "rig");
    writeFileSync(rig, `#!${process.execPath}\nconst rows = require(${JSON.stringify(fixture)});\nconst args = process.argv.slice(2);\nconst limit = Number(args[args.indexOf('--limit') + 1]);\nconst value = args[1] === 'transitions' ? rows.transitions : args[2] === '--tag' ? rows.goals.slice(0, limit) : rows.pending.slice(0, limit);\nprocess.stdout.write(JSON.stringify(value));\n`, { mode: 0o755 });
    const s = sink();
    expect(await bridge.conversationWaiter({ input, out: s.out, deps: {
      env: { ...env(), OPENRIG_RIG_BIN: rig }, alive: () => true, key: KEY, ...clock(), waiterMs: 1
    } })).toBe(2);
    expect(s.text()).toContain("qitem-q1:");
  });
});
