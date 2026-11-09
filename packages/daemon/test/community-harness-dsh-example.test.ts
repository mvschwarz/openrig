import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";

// The documented dsh example runner, run against a stand-in `dsh` (an ACP agent on stdio, no model) and a stand-in
// OpenRig (the activity hooks and the answered-permission routes). Input arrives without a TTY, so one line is one block;
// the bracketed-paste framing is checked on the runner's own framer.
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/dsh");
const RUNNER = join(EXAMPLE, "openrig-dsh-runner.mjs");

const FAKE_DSH = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
// Like dsh 0.2.1-rc.2: its CLI reports its real version, and its ACP handshake reports 0.0.1.
if (process.argv.includes("--version")) {
  // FAKE_VERSION=stuck: a version lookup that ignores SIGTERM and doesn't exit for 30 seconds.
  if (process.env.FAKE_VERSION === "stuck") { process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 30_000); await new Promise(() => {}); }
  process.stdout.write("dsh 0.2.1-rc.2\\n"); process.exit(0);
}
log({ start: { argv: process.argv.slice(2), DSH_HOME: process.env.DSH_HOME ?? null, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
  DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? null, token: "OPENRIG_ACTIVITY_HOOK_TOKEN" in process.env } });
process.stdout.write("dsh: a log line that isn't JSON\\n");
let session = null; let held = null; let cancelled = false; const waiting = new Map(); let listCalls = 0;
const update = (u) => send({ method: "session/update", params: { sessionId: session, update: u } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); log(message);
  if (message.method === undefined) { const done = waiting.get(message.id); waiting.delete(message.id); done?.(message); return; }
  const reply = (result) => send({ id: message.id, result });
  const fail = (code, text) => send({ id: message.id, error: { code, message: text } });
  switch (message.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: JSON.parse(process.env.FAKE_CAPS ?? "{}"), agentInfo: { name: "dsh", version: "0.0.1" } });
    case "session/new": session = "sess-new-1"; return reply({ sessionId: session });
    case "session/resume": case "session/load": {
      if (process.env.FAKE_RESUME === "missing") return fail(-32002, "Resource not found");
      if (process.env.FAKE_RESUME === "error") return fail(-32603, "the session store is locked");
      // dsh 0.2.1-rc.2 answers -32602 both for an id it doesn't have and for a session active elsewhere.
      if (process.env.FAKE_RESUME === "notresumable") return fail(-32602, "session is not resumable");
      session = message.params.sessionId; return reply({});
    }
    case "session/list": {
      // FAKE_LIST_RAW: the exact results to answer, one per call, in order. FAKE_LIST: pages of saved session ids, as
      // JSON; the cursor is the next page's index.
      if (process.env.FAKE_LIST_RAW) { const raw = JSON.parse(process.env.FAKE_LIST_RAW); return reply(raw[listCalls++] ?? { sessions: [] }); }
      if (process.env.FAKE_LIST === "error") return fail(-32603, "the session index is locked");
      const pages = JSON.parse(process.env.FAKE_LIST ?? "[[]]");
      const page = Number(message.params?.cursor ?? 0);
      return reply({ sessions: (pages[page] ?? []).map((sessionId) => ({ sessionId, cwd: process.cwd() })),
        ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) });
    }
    case "session/cancel": cancelled = true; if (held) { held(); held = null; } return;
    case "session/prompt": {
      cancelled = false;
      const text = message.params.prompt.map((part) => part.text).join("");
      const end = (stopReason) => reply({ stopReason });
      if (text.includes("EXIT")) process.exit(0);
      const two = ["TWOASK", "TWOTALK", "TWOQUIT"].find((word) => text.includes(word));
      if (two) {
        // Two permission requests at once; the turn ends once both are answered. After the first answer, TWOTALK says
        // something and starts a tool, and TWOQUIT exits.
        let left = 2;
        const answered = () => {
          left -= 1;
          if (left === 1 && two === "TWOTALK") { say("first answered"); update({ sessionUpdate: "tool_call", toolCallId: "t6", title: "Read e.txt", kind: "read", status: "pending" }); }
          if (left === 1 && two === "TWOQUIT") setTimeout(() => process.exit(0), 200);
          if (left === 0) { say("both answered"); end("end_turn"); }
        };
        for (const [id, file] of [["perm-5", "e.txt"], ["perm-6", "f.txt"]]) {
          waiting.set(id, answered);
          send({ id, method: "session/request_permission", params: { sessionId: session, toolCall: { toolCallId: id, title: "Edit " + file, kind: "edit" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
        }
        return;
      }
      if (text.includes("QUIETASK")) {
        // Asks, then works on quietly after the answer until it's cancelled.
        waiting.set("perm-4", (response) => { say("outcome " + JSON.stringify(response.result?.outcome ?? null)); held = () => end("cancelled"); });
        return send({ id: "perm-4", method: "session/request_permission", params: { sessionId: session, toolCall: { toolCallId: "t5", title: "Edit d.txt", kind: "edit" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
      }
      if (text.includes("PERMIT")) {
        say("checking");
        waiting.set("perm-1", (response) => { say("outcome " + JSON.stringify(response.result?.outcome ?? null)); end(cancelled ? "cancelled" : "end_turn"); });
        return send({ id: "perm-1", method: "session/request_permission", params: { sessionId: session,
          toolCall: { toolCallId: "t1", title: "Edit a.txt", kind: "edit" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
      }
      if (text.includes("DENYHOLD")) {
        waiting.set("perm-3", () => { held = () => end("cancelled"); });
        return send({ id: "perm-3", method: "session/request_permission", params: { sessionId: session, toolCall: { toolCallId: "t4", title: "Edit c.txt", kind: "edit" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
      }
      if (text.includes("ASKEND")) {
        send({ id: "perm-2", method: "session/request_permission", params: { sessionId: session, toolCall: { toolCallId: "t3", title: "Edit b.txt", kind: "edit" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
        return setTimeout(() => end("end_turn"), 300);
      }
      if (text.includes("UNKNOWN")) { waiting.set("u1", () => end("end_turn")); return send({ id: "u1", method: "fs/unknown_method", params: {} }); }
      if (text.includes("HOLD")) { held = () => end("cancelled"); return; }
      say("ok");
      update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Read a.txt", kind: "read", status: "pending" });
      return end("end_turn");
    }
    default: return fail(-32601, "Method not found");
  }
});
`;

type Permissions = "absent" | "deny" | "stale" | "revoked" | "broken" | "permitted" | "answer" | "words" | "saidno" | "unknown" | "readfail" | "pending" | "lost" | "late" | "two" | "twoslow";
interface Hook { auth: string | undefined; body: Record<string, unknown>; at: number }

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fakeOpenRig(permissions: Permissions) {
  const hooks: Hook[] = [];
  const submits: Array<{ auth: string | undefined; body: Record<string, unknown>; at: number }> = [];
  const withdraws: Array<{ askId: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url ?? "/", "http://openrig.test");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (req.method === "POST" && url.pathname === "/api/activity/hooks") { hooks.push({ auth: req.headers.authorization, body, at: Date.now() }); return json(200, { ok: true }); }
      if (permissions === "absent") return json(404, { error: "not found" });
      if (req.method === "POST" && url.pathname === "/api/activity/permission-requests") {
        submits.push({ auth: req.headers.authorization, body, at: Date.now() });
        if (permissions === "deny") return json(409, { ok: false, code: "denied_by_seat", error: "This seat's operator chose to refuse its runner's permission requests." });
        if (permissions === "stale") return json(409, { ok: false, code: "stale_generation", error: "This request isn't from the seat's current occupant." });
        if (permissions === "broken") return json(500, { ok: false, code: "internal_error", error: "Something went wrong." });
        if (permissions === "revoked") return json(401, { ok: false, code: "activity_grant_revoked", error: "This activity grant was revoked; nothing was asked." });
        if (permissions === "permitted") return json(200, { ok: true, state: "permitted", optionId: "allow", reason: "no one can be asked: no person is registered" });
        if (permissions === "two") return json(200, { ok: true, askId: `ask-${submits.length}`, created: true });
        // Two asks, and OpenRig takes 1.5 s to answer the second one's submit.
        if (permissions === "twoslow") {
          const askId = `ask-${submits.length}`;
          if (askId === "ask-2") { setTimeout(() => json(200, { ok: true, askId, created: true }), 1_500); return; }
          return json(200, { ok: true, askId, created: true });
        }
        return json(200, { ok: true, askId: "ask-1", created: true });
      }
      const withdraw = url.pathname.match(/^\/api\/activity\/permission-requests\/([^/]+)\/withdraw$/);
      if (req.method === "POST" && withdraw) {
        withdraws.push({ askId: withdraw[1]!, body });
        // With two asks, a withdraw is answered after 500 ms, so a runner that's exiting is still there to post after it.
        if (permissions === "two") { setTimeout(() => json(200, { ok: true, state: "withdrawn" }), 500); return; }
        return json(200, { ok: true, state: "withdrawn" });
      }
      // Two asks: the first is answered at once, the second 2 s after it was submitted.
      const two = url.pathname.match(/^\/api\/activity\/permission-requests\/(ask-[12])$/);
      if ((permissions === "two" || permissions === "twoslow") && req.method === "GET" && two) {
        if (two[1] === "ask-1" || Date.now() - submits[1]!.at >= 2_000) return json(200, { ok: true, state: "answered", optionId: "allow" });
        setTimeout(() => json(200, { ok: true, state: "pending" }), 100);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/activity/permission-requests/ask-1") {
        if (permissions === "answer") return json(200, { ok: true, state: "answered", optionId: "allow" });
        if (permissions === "words") return json(200, { ok: true, state: "permitted", optionId: "allow", said: "Only a.txt, please." });
        if (permissions === "saidno") return json(200, { ok: true, state: "refused", reason: "said_no" });
        if (permissions === "unknown") return json(200, { ok: true, state: "deferred" });
        if (permissions === "readfail") return json(500, { ok: false, code: "internal_error", error: "Something went wrong." });
        if (permissions === "lost") return json(404, { ok: false, code: "not_found", error: "No permission request ask-1 for this seat." });
        // A person who answers after 11 s, longer than one beat interval.
        if (permissions === "late" && Date.now() - submits[0]!.at >= 11_000) return json(200, { ok: true, state: "answered", optionId: "allow" });
        setTimeout(() => json(200, { ok: true, state: "pending" }), 100);
        return;
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => server.close());
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, hooks, submits, withdraws };
}

function start(openrig: { url: string }, env: Record<string, string> = {}, binVar = "OPENRIG_DSH") {
  const dir = mkdtempSync(join(tmpdir(), "dsh-example-"));
  const fake = join(dir, "fake-dsh.mjs");
  writeFileSync(fake, FAKE_DSH);
  chmodSync(fake, 0o755);
  const logFile = join(dir, "dsh.log");
  const launchResult = join(dir, "launch", "result.json");
  mkdirSync(join(dir, "launch"));
  const child: ChildProcess = spawn(process.execPath, [RUNNER], { cwd: dir, stdio: "pipe", env: {
    PATH: process.env["PATH"]!, [binVar]: fake, FAKE_LOG: logFile, OPENRIG_HOME: join(dir, "home"),
    OPENRIG_URL: openrig.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "test-token",
    OPENRIG_SESSION_NAME: "dev-dsh@test-rig", OPENRIG_NODE_ID: "node-1", OPENRIG_OCCUPANT_GENERATION: "gen-1", OPENRIG_RUNTIME: "dsh",
    OPENRIG_LAUNCH_RESULT: launchResult, OPENRIG_LAUNCH_ATTEMPT: "attempt-1", ...env,
  } });
  let out = "";
  child.stdout!.on("data", (data: Buffer) => { out += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { out += data.toString(); });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  cleanups.push(() => { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  return {
    dir, exited,
    out: () => out,
    type: (line: string) => child.stdin!.write(`${line}\n`),
    log: (): Array<Record<string, unknown>> => existsSync(logFile)
      ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [],
    launch: (): Record<string, unknown> | undefined => existsSync(launchResult) ? JSON.parse(readFileSync(launchResult, "utf8")) as Record<string, unknown> : undefined,
  };
}

async function waitFor<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const seen = (hooks: Hook[]) => hooks.map((hook) => `${String(hook.body.hookEvent)}/${String(hook.body.subtype)}`);
const has = (hooks: Hook[], event: string) => hooks.find((hook) => `${String(hook.body.hookEvent)}/${String(hook.body.subtype)}` === event);
const requests = (log: Array<Record<string, unknown>>, method: string) => log.filter((entry) => entry.method === method);
const responseTo = (log: Array<Record<string, unknown>>, id: string) => log.find((entry) => entry.id === id && entry.method === undefined);

describe("the documented dsh example runner", () => {
  it("opens a conversation, writes the launch record, and only then reads ready, with uploads off and no hook token for dsh", async () => {
    const openrig = await fakeOpenRig("absent");
    // A DSH_HOME the person's shell exports (its startup files run after the seat's env:) isn't the seat's home.
    const seat = start(openrig, { DSH_HOME: join(tmpdir(), "a-persons-own-dsh-home") });
    const record = await waitFor(seat.launch, "the launch record");
    expect(record).toMatchObject({ format: 1, attempt: "attempt-1", harness: "dsh", nativeRef: "sess-new-1" });
    expect(String(record.producer)).toMatch(/openrig-dsh-runner .*dsh 0\.2\.1-rc\.2.*ACP 1/);
    const log = seat.log();
    expect(log.filter((entry) => typeof entry.method === "string").map((entry) => entry.method)).toEqual(["initialize", "session/new"]);
    const started = (log[0] as { start: Record<string, unknown> }).start;
    expect(started).toEqual({ argv: ["--profile", "acp"], DSH_HOME: join(seat.dir, "home", "state", "dsh", "node-1", "home"),
      DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_DISABLED: "1", token: false });
    const patch = readFileSync(join(String(started.DSH_HOME), "cordis.patch.yml"), "utf8");
    expect(patch).toMatch(/- id: session-log-deepseek\n\s+config:\n\s+enabled: false/);
    expect(patch).toMatch(/- id: plugin-package-inventory-deepseek\n\s+config:\n\s+enabled: false/);
    const idle = await waitFor(() => has(openrig.hooks, "Stop/idle_heartbeat"), "the first idle report");
    expect(idle.body).toMatchObject({ sessionName: "dev-dsh@test-rig", nodeId: "node-1", generation: "gen-1", runtime: "dsh" });
    expect(idle.body.livenessSeconds).toBeGreaterThan(0);
    expect(idle.auth).toBe("Bearer test-token");
  });

  it("takes its dsh binary and home from DSH_SEAT_BIN and DSH_SEAT_HOME, which a rig spec's env: can set, over an exported DSH_HOME", async () => {
    const openrig = await fakeOpenRig("absent");
    const home = mkdtempSync(join(tmpdir(), "dsh-prepared-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const seat = start(openrig, { DSH_SEAT_HOME: home, DSH_HOME: join(tmpdir(), "a-persons-own-dsh-home") }, "DSH_SEAT_BIN");
    await waitFor(seat.launch, "the launch record");
    expect((seat.log()[0] as { start: Record<string, unknown> }).start).toMatchObject({ argv: ["--profile", "acp"], DSH_HOME: home });
  });

  it("starts without waiting on a version lookup that ignores SIGTERM, and names the handshake's version", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { FAKE_VERSION: "stuck" });
    const record = await waitFor(seat.launch, "the launch record", 15_000);
    expect(record).toMatchObject({ nativeRef: "sess-new-1" });
    expect(String(record.producer)).toMatch(/dsh 0\.0\.1 \(as its ACP handshake reports it\); ACP 1/);
  }, 30_000);

  it("sends one submitted block as one prompt and reports working, then idle, in order", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("hello there");
    const stop = await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's end");
    const prompts = requests(seat.log(), "session/prompt");
    expect(prompts).toHaveLength(1);
    expect((prompts[0]!.params as { sessionId: string; prompt: unknown }).sessionId).toBe("sess-new-1");
    expect((prompts[0]!.params as { prompt: unknown }).prompt).toEqual([{ type: "text", text: "hello there" }]);
    const turn = seen(openrig.hooks).slice(seen(openrig.hooks).indexOf("UserPromptSubmit/accepted"));
    expect(turn).toEqual(["UserPromptSubmit/accepted", "active/agent_message", "PreToolUse/read", "Stop/end_turn"]);
    expect(has(openrig.hooks, "UserPromptSubmit/accepted")!.body.turnId).toBe("1");
    expect(stop.body.livenessSeconds).toBeGreaterThan(0);
    const sequences = openrig.hooks.map((hook) => Number(hook.body.sequence));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(seat.out()).toMatch(/you ▸ hello there/);
  });

  it("frames a bracketed paste as one block, keeps typed edits, and treats only a bare /abort or Ctrl-C as control", () => {
    // The runner's own framer, imported by plain Node, one chunk of terminal bytes at a time.
    const script = `import { InputFramer } from ${JSON.stringify(pathToFileURL(RUNNER).href)};
const framer = new InputFramer();
const chunks = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(chunks.map((chunk) => framer.push(chunk).filter((event) => event.type === "block" || event.type === "abort"))));`;
    const chunks = ["\x1b[200~From: a@rig\nline one\n/abort\x1b[201~", "\r", "\x1b[20", "0~a\r\nb\x1b[201~\r", "hi\x7f\x7fok\r", "/abort\r", "half typed\x03", "\r"];
    const framed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(chunks)], { encoding: "utf8", timeout: 20_000 })) as unknown;
    expect(framed).toEqual([
      [], [{ type: "block", text: "From: a@rig\nline one\n/abort" }], [], [{ type: "block", text: "a\nb" }],
      [{ type: "block", text: "ok" }], [{ type: "abort" }], [{ type: "abort" }], [],
    ]);
  });

  it("sends the cancel on /abort and reports cancelled only on the agent's own stop reason", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("HOLD this turn");
    await waitFor(() => has(openrig.hooks, "UserPromptSubmit/accepted"), "the accepted prompt");
    seat.type("/abort");
    await waitFor(() => requests(seat.log(), "session/cancel").length > 0, "the cancel notification");
    await waitFor(() => has(openrig.hooks, "Stop/cancelled"), "the cancelled turn end");
    const turn = seen(openrig.hooks).slice(seen(openrig.hooks).indexOf("UserPromptSubmit/accepted"));
    expect(turn.filter((event) => event.startsWith("Stop/"))).toEqual(["Stop/cancelled"]);
    expect(requests(seat.log(), "session/prompt")).toHaveLength(1);
  });

  // The working beat (contract section 4) runs on its own 10 s interval, so these two cells take that long.
  it("beats through a long, quiet turn, naming the accepted turn, and stops at the turn's end", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("HOLD this turn");
    const accepted = await waitFor(() => has(openrig.hooks, "UserPromptSubmit/accepted"), "the accepted prompt");
    const beat = await waitFor(() => has(openrig.hooks, "active/liveness"), "a working beat", 12_000);
    expect(beat.body).toMatchObject({ turnId: "1", livenessSeconds: 30, generation: "gen-1", runtime: "dsh" });
    expect(Number(beat.body.sequence)).toBeGreaterThan(Number(accepted.body.sequence));
    expect(typeof beat.body.occurredAt).toBe("string");
    seat.type("/abort");
    await waitFor(() => has(openrig.hooks, "Stop/cancelled"), "the cancelled turn end");
    const stopAt = seen(openrig.hooks).indexOf("Stop/cancelled");
    await new Promise((done) => setTimeout(done, 10_500)); // one more beat interval
    expect(seen(openrig.hooks).slice(stopAt + 1)).not.toContain("active/liveness");
  }, 35_000);

  it("holds the beat while a person's ask is open, then posts permission_resolved before beating again", async () => {
    const openrig = await fakeOpenRig("late");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("QUIETASK an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-4"), "the person's answer, given to the agent", 16_000);
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    const resolved = await waitFor(() => has(openrig.hooks, "active/permission_resolved"), "permission_resolved");
    expect(resolved.body).toMatchObject({ turnId: "1", askId: "ask-1" });
    // The ask was open for more than a beat interval, and no beat went out while it was.
    const asked = openrig.submits[0]!.at;
    expect(resolved.at - asked).toBeGreaterThanOrEqual(10_000);
    expect(openrig.hooks.filter((hook) => hook.body.subtype === "liveness" && hook.at > asked && hook.at < resolved.at)).toEqual([]);
    // The same turn works on quietly after the answer, and beats again.
    const after = await waitFor(() => openrig.hooks.find((hook) => hook.body.subtype === "liveness" && hook.at > resolved.at), "a beat after the answer", 12_000);
    expect(after.body.turnId).toBe("1");
    expect(Number(after.body.sequence)).toBeGreaterThan(Number(resolved.body.sequence));
    seat.type("/abort");
    await waitFor(() => has(openrig.hooks, "Stop/cancelled"), "the cancelled turn end");
  }, 45_000);

  it.each(["absent", "permitted"] as const)("permits with the agent's own allow when no one can be asked (OpenRig %s)", async (permissions) => {
    const openrig = await fakeOpenRig(permissions);
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's idle report");
    expect(has(openrig.hooks, "Notification/permission_prompt")).toBeUndefined();
    expect(has(openrig.hooks, "active/permission_resolved"), "OpenRig opened no ask").toBeUndefined();
    expect(seat.out()).toMatch(/\[permission\] permitted/);
  });

  // An ask OpenRig opened (the last two) showed the seat needing input, so the permit is followed by permission_resolved.
  it.each([
    ["OpenRig can't be reached", "absent", { OPENRIG_URL: "http://127.0.0.1:1" }, false],
    ["the submit is answered with a status the contract doesn't list", "broken", {}, false],
    ["the submit's grant was revoked, which can happen to the live occupant", "revoked", {}, false],
    ["reading the answer gets a state the contract doesn't list", "unknown", {}, true],
    ["reading the answer gets an unexpected reply", "lost", {}, true],
  ] as const)("permits with the agent's own allow when %s, since nobody can be asked", async (_case, permissions, env, opened) => {
    const openrig = await fakeOpenRig(permissions);
    const seat = start(openrig, env);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(has(openrig.hooks, "Notification/permission_prompt")).toBeUndefined();
    if (opened) {
      const resolved = await waitFor(() => has(openrig.hooks, "active/permission_resolved"), "permission_resolved");
      expect(resolved.body).toMatchObject({ turnId: "1", askId: "ask-1" });
    } else {
      await waitFor(() => /turn end/.test(seat.out()), "the turn's end in the pane");
      expect(has(openrig.hooks, "active/permission_resolved"), "OpenRig opened no ask").toBeUndefined();
    }
  });

  it.each([
    ["the submit says the request isn't the current occupant's", "stale"],
    ["the person said no and the agent has no reject option", "saidno"],
  ] as const)("answers cancelled and holds no attention when %s", async (_case, permissions) => {
    const openrig = await fakeOpenRig(permissions);
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "cancelled" } });
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's idle report");
    expect(has(openrig.hooks, "Notification/permission_prompt")).toBeUndefined();
    expect(has(openrig.hooks, "active/permission_resolved"), "nothing was answered or permitted").toBeUndefined();
  });

  it("keeps the seat's own refusal held through a cancel, so the cancelled turn reads needs input, not idle", async () => {
    const openrig = await fakeOpenRig("deny");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("DENYHOLD an edit");
    await waitFor(() => responseTo(seat.log(), "perm-3"), "the runner's answer to the permission request");
    seat.type("/abort");
    await waitFor(() => /turn end \(cancelled\)/.test(seat.out()), "the cancelled turn's end in the pane");
    await new Promise((done) => setTimeout(done, 500));
    const after = seen(openrig.hooks).slice(seen(openrig.hooks).indexOf("Notification/permission_prompt"));
    expect(after[0]).toBe("Notification/permission_prompt");
    expect(after.filter((event) => event.startsWith("Stop/"))).toEqual([]);
  });

  it("releases the hold when the turn ends with a person's ask still pending, and withdraws the ask", async () => {
    const openrig = await fakeOpenRig("pending");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("ASKEND now");
    await waitFor(() => openrig.withdraws.find((entry) => entry.askId === "ask-1" && entry.body.reason === "turn_ended"), "the ask withdrawn at the turn's end");
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's idle report");
  });

  it("keeps a permitted ask's cleanup after a failed read, answers the agent once, and withdraws the ask at the turn's end", async () => {
    const openrig = await fakeOpenRig("readfail");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await waitFor(() => openrig.withdraws.find((entry) => entry.askId === "ask-1" && entry.body.reason === "turn_ended"), "the ask withdrawn at the turn's end");
    expect(seat.log().filter((entry) => entry.id === "perm-1" && entry.method === undefined)).toHaveLength(1);
  });

  it("uses the seat's preset name for the launch record, the activity runtime and the exit", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RUNTIME: "dsh-work" });
    expect(await waitFor(seat.launch, "the launch record")).toMatchObject({ harness: "dsh-work", nativeRef: "sess-new-1" });
    expect((await waitFor(() => has(openrig.hooks, "Stop/idle_heartbeat"), "the first idle report")).body.runtime).toBe("dsh-work");
    seat.type("EXIT now");
    await waitFor(() => has(openrig.hooks, "Stop/dsh-work_exited"), "the exit report under the preset's name");
    expect(has(openrig.hooks, "Stop/dsh_exited")).toBeUndefined();
  });

  it("refuses a permission request at once, shows it and holds needs input when the seat opted in to refusal", async () => {
    const openrig = await fakeOpenRig("deny");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "cancelled" } });
    await waitFor(() => /turn end \(end_turn\)/.test(seat.out()), "the turn's end in the pane");
    await new Promise((done) => setTimeout(done, 500));
    const after = seen(openrig.hooks).slice(seen(openrig.hooks).indexOf("Notification/permission_prompt"));
    expect(after[0]).toBe("Notification/permission_prompt");
    expect(after.filter((event) => event.startsWith("Stop/"))).toEqual([]);
    expect(seat.out()).toMatch(/Edit a\.txt/);
    seat.type("next turn");
    await waitFor(() => openrig.hooks.some((hook) => hook.body.hookEvent === "UserPromptSubmit" && hook.body.turnId === "2"), "the next accepted prompt");
    await waitFor(() => seen(openrig.hooks).lastIndexOf("Stop/end_turn") > seen(openrig.hooks).indexOf("Notification/permission_prompt"), "the next turn's idle report");
  });

  it("asks the chosen person through the answered path and gives their option to the same live request once", async () => {
    const openrig = await fakeOpenRig("answer");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(openrig.submits).toHaveLength(1);
    expect(openrig.submits[0]!.auth).toBe("Bearer test-token");
    expect(openrig.submits[0]!.body).toMatchObject({ sessionName: "dev-dsh@test-rig", nodeId: "node-1", generation: "gen-1",
      nativeRef: "sess-new-1", turnId: "1", requestId: "perm-1", toolCall: { title: "Edit a.txt", kind: "edit" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" }] });
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's idle report");
    expect(has(openrig.hooks, "Notification/permission_prompt")).toBeUndefined();
    expect(openrig.withdraws).toEqual([]);
    // The person's answer reached the agent, so the seat's needs input clears for the rest of the turn, before its end.
    const events = seen(openrig.hooks);
    expect(has(openrig.hooks, "active/permission_resolved")!.body).toMatchObject({ turnId: "1", askId: "ask-1" });
    expect(events.indexOf("active/permission_resolved")).toBeLessThan(events.indexOf("Stop/end_turn"));
  });

  it("gives the agent its option, then queues the person's own words as a prompt, after the turn", async () => {
    const openrig = await fakeOpenRig("words");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    const prompts = () => requests(seat.log(), "session/prompt")
      .map((entry) => (entry.params as { prompt: Array<{ text: string }> }).prompt.map((part) => part.text).join(""));
    const next = await waitFor(() => prompts()[1], "the person's words as a queued prompt");
    expect(next).toContain("Only a.txt, please.");
    expect(next).toContain("Edit a.txt");
    expect(prompts()).toHaveLength(2);
    expect(seat.out()).toContain("Only a.txt, please.");
  });

  // Two asks open at once: the first answer reaches the agent at once, but the seat still waits on a person for the second,
  // so nothing that clears needs input is posted until that one is answered too; then permission_resolved goes out once.
  it("keeps the seat needing input while a second ask waits, and resolves once, after the last answer", async () => {
    const openrig = await fakeOpenRig("two");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("TWOASK two edits");
    for (const id of ["perm-5", "perm-6"]) {
      const answer = await waitFor(() => responseTo(seat.log(), id), `the answer to ${id}`, 8_000);
      expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    }
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's end");
    expect(openrig.submits).toHaveLength(2);
    const resolved = openrig.hooks.filter((hook) => hook.body.subtype === "permission_resolved");
    expect(resolved.map((hook) => hook.body.turnId)).toEqual(["1"]);
    expect(resolved[0]!.at - openrig.submits[1]!.at).toBeGreaterThanOrEqual(2_000); // after the later ask's answer
    // From the first ask on (the submit isn't one of the runner's ordered posts, so it can arrive before the accepted prompt).
    const from = Math.max(openrig.submits[0]!.at, has(openrig.hooks, "UserPromptSubmit/accepted")!.at);
    const between = openrig.hooks.filter((hook) => hook.at > from && hook.at < resolved[0]!.at);
    expect(between.map((hook) => `${String(hook.body.hookEvent)}/${String(hook.body.subtype)}`)).toEqual([]);
  });

  // The first answer reaches the agent before OpenRig has answered the second ask's submit, though it has already recorded
  // that prompt, so what the agent says and does in between mustn't read working.
  it("reports nothing that reads working while a second ask is still being submitted", async () => {
    const openrig = await fakeOpenRig("twoslow");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("TWOTALK two edits");
    for (const id of ["perm-5", "perm-6"]) {
      const answer = await waitFor(() => responseTo(seat.log(), id), `the answer to ${id}`, 8_000);
      expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    }
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's end");
    expect(seat.out()).toContain("first answered");
    expect(seat.out()).toContain("OpenRig asked a person (ask-2)");
    expect(seat.out().indexOf("first answered")).toBeLessThan(seat.out().indexOf("OpenRig asked a person (ask-2)"));
    const resolved = openrig.hooks.filter((hook) => hook.body.subtype === "permission_resolved");
    expect(resolved.map((hook) => hook.body.turnId)).toEqual(["1"]);
    const from = Math.max(openrig.submits[0]!.at, has(openrig.hooks, "UserPromptSubmit/accepted")!.at);
    expect(seen(openrig.hooks.filter((hook) => hook.at > from && hook.at < resolved[0]!.at))).toEqual([]);
  });

  // The agent exits after the first answer while the second ask still waits on a person: nothing after the exit says the
  // turn goes on.
  it("posts no permission_resolved after the agent's exit", async () => {
    const openrig = await fakeOpenRig("two");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("TWOQUIT two edits");
    await waitFor(() => responseTo(seat.log(), "perm-5") ?? responseTo(seat.log(), "perm-6"), "the first answer", 8_000);
    await seat.exited;
    expect(openrig.withdraws.map((entry) => entry.body)).toEqual([{ reason: "exited" }]);
    const events = seen(openrig.hooks);
    expect(events.at(-1)).toBe("Stop/dsh_exited");
    expect(events).not.toContain("active/permission_resolved");
  });

  it("withdraws a pending ask when the turn is cancelled, and answers the agent cancelled", async () => {
    const openrig = await fakeOpenRig("pending");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    await waitFor(() => openrig.submits.length > 0, "the submitted request");
    seat.type("/abort");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "cancelled" } });
    await waitFor(() => openrig.withdraws.length > 0, "the withdraw");
    expect(openrig.withdraws).toEqual([{ askId: "ask-1", body: { reason: "turn_cancelled" } }]);
    const log = seat.log();
    const cancelAt = log.findIndex((entry) => entry.method === "session/cancel");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(log.findIndex((entry) => entry.id === "perm-1" && entry.method === undefined));
    await waitFor(() => has(openrig.hooks, "Stop/cancelled"), "the cancelled turn end");
  });

  it("answers an agent request it doesn't know with -32601 and carries on", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("UNKNOWN request");
    const answer = await waitFor(() => responseTo(seat.log(), "u1"), "the runner's answer to the unknown request");
    expect((answer.error as { code: number }).code).toBe(-32601);
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's end");
  });

  it("gives the first startup turn to the agent as its first prompt, byte for byte", async () => {
    const openrig = await fakeOpenRig("absent");
    const dir = mkdtempSync(join(tmpdir(), "dsh-first-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = join(dir, "first.txt");
    const text = "identity\n'quoted' $literal\n";
    writeFileSync(first, text, { mode: 0o600 });
    const seat = start(openrig, { OPENRIG_FIRST_INPUT: first });
    const prompt = await waitFor(() => requests(seat.log(), "session/prompt")[0], "the first prompt");
    expect((prompt.params as { prompt: unknown }).prompt).toEqual([{ type: "text", text }]);
  });

  it("reopens exactly the conversation OpenRig names, by the method the agent advertises", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify({ sessionCapabilities: { resume: {} } }) });
    const record = await waitFor(seat.launch, "the launch record");
    expect(record).toMatchObject({ format: 1, attempt: "attempt-1", harness: "dsh", nativeRef: "sess-old-7" });
    const log = seat.log();
    expect(requests(log, "session/resume").map((entry) => (entry.params as { sessionId: string }).sessionId)).toEqual(["sess-old-7"]);
    expect(requests(log, "session/new")).toEqual([]);
  });

  it("reopens through session/load when that's what the agent advertises", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify({ loadSession: true }) });
    await waitFor(seat.launch, "the launch record");
    expect(requests(seat.log(), "session/load").map((entry) => (entry.params as { sessionId: string }).sessionId)).toEqual(["sess-old-7"]);
  });

  it("reports a conversation the agent says is gone as missing, and starts nothing new", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-gone", FAKE_RESUME: "missing" });
    expect(await seat.exited).toBe(3);
    expect(seat.launch()).toMatchObject({ format: 1, attempt: "attempt-1", harness: "dsh", error: "missing" });
    expect(requests(seat.log(), "session/new")).toEqual([]);
  });

  it("writes no record on any other resume failure, so the resume reads unconfirmed, and starts nothing new", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_RESUME: "error" });
    expect(await seat.exited).toBe(4);
    expect(seat.launch()).toBeUndefined();
    expect(requests(seat.log(), "session/new")).toEqual([]);
    expect(seat.out()).toMatch(/the session store is locked/);
  });

  // dsh answers -32602 for a conversation it doesn't have and for one active elsewhere, so that error can't mean missing.
  // dsh's session list can show a conversation exists, never that it doesn't: one another running dsh holds unsaved can
  // be left out. So the list is only positive evidence, and an unlisted conversation is still reopened.
  const listing = { sessionCapabilities: { list: {}, resume: {} } };

  it("still reopens a conversation dsh doesn't list, and resumes it when the reopen works", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify(listing), FAKE_LIST: JSON.stringify([["sess-other"]]) });
    expect(await waitFor(seat.launch, "the launch record")).toMatchObject({ nativeRef: "sess-old-7" });
    expect(requests(seat.log(), "session/resume").map((entry) => (entry.params as { sessionId: string }).sessionId)).toEqual(["sess-old-7"]);
    expect(requests(seat.log(), "session/new")).toEqual([]);
  });

  it("leaves an unlisted conversation that won't reopen (-32602) unconfirmed, never missing", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-gone", FAKE_CAPS: JSON.stringify(listing),
      FAKE_LIST: JSON.stringify([["sess-other"]]), FAKE_RESUME: "notresumable" });
    expect(await seat.exited).toBe(4);
    expect(seat.launch()).toBeUndefined();
    expect(requests(seat.log(), "session/resume")).toHaveLength(1);
    expect(requests(seat.log(), "session/new")).toEqual([]);
  });

  it("follows an empty-string cursor to the next page, unchanged, so a conversation listed there isn't reported missing", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify(listing), FAKE_RESUME: "missing",
      FAKE_LIST_RAW: JSON.stringify([{ sessions: [], nextCursor: "" }, { sessions: [{ sessionId: "sess-old-7", cwd: "/w" }] }]) });
    expect(await seat.exited).toBe(4);
    expect(seat.launch()).toBeUndefined();
    expect(requests(seat.log(), "session/list").map((entry) => (entry.params as { cursor?: string }).cursor)).toEqual([undefined, ""]);
  });

  it.each([
    ["a cursor that isn't a string", { sessions: [], nextCursor: 1 }],
    ["an entry without a sessionId", { sessions: [{}] }],
  ])("reads a list page with %s as deciding nothing, and still reopens", async (_case, page) => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify(listing), FAKE_LIST_RAW: JSON.stringify([page]) });
    expect(await waitFor(seat.launch, "the launch record")).toMatchObject({ nativeRef: "sess-old-7" });
    expect(requests(seat.log(), "session/list")).toHaveLength(1);
    expect(requests(seat.log(), "session/resume")).toHaveLength(1);
  });

  it("follows the list's pages before deciding, and reopens a conversation it finds", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify(listing),
      FAKE_LIST: JSON.stringify([["sess-a"], ["sess-old-7"]]) });
    expect(await waitFor(seat.launch, "the launch record")).toMatchObject({ nativeRef: "sess-old-7" });
    expect(requests(seat.log(), "session/list").map((entry) => (entry.params as { cursor?: string }).cursor)).toEqual([undefined, "1"]);
  });

  it("leaves a listed conversation that won't reopen unconfirmed, whatever dsh's error says", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify(listing),
      FAKE_LIST: JSON.stringify([["sess-old-7"]]), FAKE_RESUME: "notresumable" });
    expect(await seat.exited).toBe(4);
    expect(seat.launch()).toBeUndefined();
    expect(requests(seat.log(), "session/new")).toEqual([]);
  });

  it("decides nothing from a list that fails, so a resume dsh won't make stays unconfirmed", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig, { OPENRIG_RESUME_REF: "sess-old-7", FAKE_CAPS: JSON.stringify(listing),
      FAKE_LIST: "error", FAKE_RESUME: "notresumable" });
    expect(await seat.exited).toBe(4);
    expect(seat.launch()).toBeUndefined();
    expect(requests(seat.log(), "session/new")).toEqual([]);
  });

  it("reports the agent's exit as exited, never idle", async () => {
    const openrig = await fakeOpenRig("absent");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("EXIT now");
    await waitFor(() => has(openrig.hooks, "Stop/dsh_exited"), "the exit report");
    await seat.exited;
    expect(seen(openrig.hooks).slice(seen(openrig.hooks).indexOf("UserPromptSubmit/accepted"))).toEqual(["UserPromptSubmit/accepted", "Stop/dsh_exited"]);
  });

  it("is a preset this OpenRig loads as a runner, with launch-record identity and first input, and resume left undeclared", () => {
    expect(loadCommunityHarnessPreset("dsh", EXAMPLE)).toMatchObject({ ok: true, preset: {
      command: "openrig-dsh-runner.mjs", runner: true, launchResult: true, namesConversation: false, resume: false, firstInput: true,
    } });
  });
});
