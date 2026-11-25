import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { deriveCanonicalSessionName } from "../src/domain/session-name.js";

// The documented agy example: its runner, run against a stand-in `agy acp` (an ACP agent on stdio, no model) and a
// stand-in OpenRig, and its fallback launcher's missing-conversation report. Input arrives without a TTY, so one line is
// one block.
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/agy");
const RUNNER = join(EXAMPLE, "openrig-agy-runner.mjs");
const KEY = "test-gemini-key-not-real";

const FAKE_AGY = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
if (process.argv.includes("--version")) { process.stdout.write("1.5.13\\n"); process.exit(0); }
log({ start: { argv: process.argv.slice(2), HOME: process.env.HOME ?? null, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
  token: "OPENRIG_ACTIVITY_HOOK_TOKEN" in process.env } });
let session = null; let held = null; const waiting = new Map();
const OPTIONS = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
const ask = (id, title) => send({ id, method: "session/request_permission", params: { sessionId: session,
  toolCall: { toolCallId: id, title, kind: "execute" }, options: OPTIONS } });
const talk = (text) => send({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); log(message);
  if (message.method === undefined) { const done = waiting.get(message.id); waiting.delete(message.id); done?.(message); return; }
  const reply = (result) => send({ id: message.id, result });
  const fail = (code, text) => send({ id: message.id, error: { code, message: text } });
  switch (message.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: JSON.parse(process.env.FAKE_CAPS ?? "{}"), agentInfo: { name: "agy" } });
    case "session/new": session = "sess-new-1"; return reply({ sessionId: session, models: { currentModelId: "gemini-3.1-pro-low" } });
    case "session/set_model": return reply({});
    // agy 1.5.13: session/resume of an unknown id fails; session/load of one succeeds silently.
    case "session/resume": return fail(-32603, "Failed to read session");
    case "session/load": session = message.params.sessionId; return reply({});
    case "session/list": return reply({ sessions: [] });
    case "session/cancel": if (held) { held(); held = null; } return;
    case "session/prompt": {
      const text = message.params.prompt.map((part) => part.text).join("");
      // A request in the turn, refused by the seat; the turn ends, then agy talks again with no prompt open.
      if (text === "DENYBG") { waiting.set("perm-deny", () => { reply({ stopReason: "end_turn" }); setTimeout(() => talk("background output"), 200); }); return ask("perm-deny", "Run rm -rf build"); }
      // A turn cancelled by /abort; agy then talks and asks for permission with no prompt open.
      if (text === "HOLDCANCEL") { held = () => { reply({ stopReason: "cancelled" }); setTimeout(() => talk("finishing up"), 200); setTimeout(() => ask("perm-after-cancel", "Run git push"), 400); }; return; }
      reply({ stopReason: "end_turn" });
      // A background task finishes after the turn ended, and agy asks for permission with no prompt open.
      if (text === "BACKGROUND") setTimeout(() => ask("perm-late", "Run rig queue update"), 300);
      return;
    }
    default: return fail(-32601, "Method not found");
  }
});
`;

interface Hook { body: Record<string, unknown> }

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fakeOpenRig(mode: "permit" | "deny" = "permit") {
  const hooks: Hook[] = [];
  const submits: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (req.method === "POST" && req.url === "/api/activity/hooks") { hooks.push({ body }); return json(200, { ok: true }); }
      if (req.method === "POST" && req.url === "/api/activity/permission-requests") {
        submits.push(body);
        if (mode === "deny") return json(409, { ok: false, code: "denied_by_seat", error: "This seat's operator chose to refuse its runner's permission requests." });
        return json(200, { ok: true, state: "permitted", optionId: "allow", reason: "no one can be asked: no person is registered" });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hooks, submits };
}

function start(openrig: { url: string }, opts: { args?: string[]; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agy-example-"));
  const fake = join(dir, "fake-agy.mjs");
  writeFileSync(fake, FAKE_AGY);
  chmodSync(fake, 0o755);
  const agyHome = join(dir, "agy-home");
  mkdirSync(agyHome);
  const keyFile = join(dir, "gemini-api-key");
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const logFile = join(dir, "agy.log");
  const launchResult = join(dir, "launch", "result.json");
  mkdirSync(join(dir, "launch"));
  const args = opts.args ?? ["--agy-home", agyHome, "--agy", fake, "--key-file", keyFile, "--model", "gemini-4-neon-high"];
  const child: ChildProcess = spawn(process.execPath, [RUNNER, ...args], { cwd: dir, stdio: "pipe", env: {
    PATH: process.env["PATH"]!, FAKE_LOG: logFile, OPENRIG_HOME: join(dir, "home"),
    OPENRIG_URL: openrig.url, OPENRIG_ACTIVITY_HOOK_TOKEN: "test-token",
    OPENRIG_SESSION_NAME: deriveCanonicalSessionName("dev", "agy", "test-rig"), OPENRIG_NODE_ID: "node-1", OPENRIG_OCCUPANT_GENERATION: "gen-1", OPENRIG_RUNTIME: "agy",
    OPENRIG_LAUNCH_RESULT: launchResult, OPENRIG_LAUNCH_ATTEMPT: "attempt-1", ...opts.env,
  } });
  let out = "";
  child.stdout!.on("data", (data: Buffer) => { out += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { out += data.toString(); });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  cleanups.push(async () => {
    child.kill("SIGKILL");
    // The runner's own child (the fake harness) can still be writing in the folder: wait for the runner, then retry
    // the removal, as macOS can report ENOTEMPTY while the last write lands.
    await Promise.race([exited, new Promise((done) => setTimeout(done, 2_000))]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return {
    dir, agyHome, exited,
    out: () => out,
    type: (line: string) => child.stdin!.write(`${line}\n`),
    log: (): Array<Record<string, unknown>> => existsSync(logFile)
      ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [],
    launch: (): Record<string, unknown> | undefined => existsSync(launchResult) ? JSON.parse(readFileSync(launchResult, "utf8")) as Record<string, unknown> : undefined,
    launchText: () => existsSync(launchResult) ? readFileSync(launchResult, "utf8") : "",
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

const events = (hooks: Hook[]) => hooks.filter((hook) => hook.body.hookEvent).map((hook) => `${String(hook.body.hookEvent)}/${String(hook.body.subtype)}`);
const requests = (log: Array<Record<string, unknown>>, method: string) => log.filter((entry) => entry.method === method);

describe("the documented agy example runner", () => {
  it("gives agy the key in its environment only, pins the model, then writes the launch record and reports the model", async () => {
    const openrig = await fakeOpenRig();
    const seat = start(openrig, { env: { OPENRIG_RUN_ID: "run-1" } });
    const record = await waitFor(seat.launch, "the launch record");
    expect(record).toMatchObject({ format: 1, attempt: "attempt-1", harness: "agy", nativeRef: "sess-new-1" });
    const log = seat.log();
    expect((log[0] as { start: Record<string, unknown> }).start).toEqual({ argv: ["acp"], HOME: seat.agyHome, GEMINI_API_KEY: KEY, token: false });
    expect(log.filter((entry) => typeof entry.method === "string").map((entry) => entry.method)).toEqual(["initialize", "session/new", "session/set_model"]);
    expect(requests(log, "session/set_model")[0]?.params).toEqual({ sessionId: "sess-new-1", modelId: "gemini-4-neon-high" });
    const observed = await waitFor(() => openrig.hooks.find((hook) => hook.body.observations), "the model observation");
    expect(observed.body).toMatchObject({ runId: "run-1", observations: { model: { id: "gemini-4-neon-high" } } });
    await waitFor(() => seat.out().includes("ready"), "the ready line");
    expect(seat.out()).not.toContain(KEY);
    expect(seat.launchText()).not.toContain(KEY);
    expect(JSON.stringify(openrig.hooks)).not.toContain(KEY);
  });

  it("starts nothing when the key file can't be read", async () => {
    const openrig = await fakeOpenRig();
    const seat = start(openrig, { args: ["--agy", "/nonexistent/agy", "--key-file", "/nonexistent/key"] });
    expect(await seat.exited).toBe(2);
    expect(seat.out()).toMatch(/key file couldn't be read/);
    expect(seat.launch()).toBeUndefined();
  });

  it("treats a permission request agy raises after its turn ended as a turn agy started, and sends it through OpenRig", async () => {
    const openrig = await fakeOpenRig();
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("BACKGROUND");
    await waitFor(() => events(openrig.hooks).includes("UserPromptSubmit/agent_initiated"), "the agent-initiated turn");
    expect(events(openrig.hooks)).toContain("Stop/end_turn");
    expect(events(openrig.hooks).indexOf("Stop/end_turn")).toBeLessThan(events(openrig.hooks).indexOf("UserPromptSubmit/agent_initiated"));
    const answer = await waitFor(() => seat.log().find((entry) => entry.id === "perm-late" && entry.method === undefined), "the answer to agy");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(openrig.submits).toHaveLength(1);
    expect(openrig.submits[0]).toMatchObject({ nativeRef: "sess-new-1", toolCall: { title: "Run rig queue update", kind: "execute" } });
  });

  // The implicit turn's quiet end comes 20 s after agy's last output, so these cells wait it out.
  it("keeps a refusal's needs input through output agy sends after the turn and through its quiet end, until the next prompt", async () => {
    const openrig = await fakeOpenRig("deny");
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("DENYBG");
    await waitFor(() => events(openrig.hooks).includes("Notification/permission_prompt"), "the refusal");
    await waitFor(() => seat.out().includes("agy continued on its own"), "agy's output after the turn");
    await new Promise((done) => setTimeout(done, 21_000));
    const seen = events(openrig.hooks);
    expect(seen).not.toContain("UserPromptSubmit/agent_initiated");
    expect(seen).not.toContain("Stop/implicit_quiet");
    expect(seen.at(-1)).toBe("Notification/permission_prompt");
    // The next prompt is what clears it.
    seat.type("hello");
    await waitFor(() => events(openrig.hooks).includes("Stop/end_turn"), "the next prompt's turn");
    expect(events(openrig.hooks).slice(seen.length)).toEqual(expect.arrayContaining(["UserPromptSubmit/accepted", "Stop/end_turn"]));
  }, 40_000);

  it("answers a permission request cancelled after a cancel, even past output agy sends after the turn, until the next prompt", async () => {
    const openrig = await fakeOpenRig();
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("HOLDCANCEL");
    await waitFor(() => requests(seat.log(), "session/prompt").length === 1, "the held prompt");
    seat.type("/abort");
    const late = await waitFor(() => seat.log().find((entry) => entry.id === "perm-after-cancel" && entry.method === undefined), "the late request's answer");
    expect(late.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(openrig.submits).toHaveLength(0);
    // A genuine prompt, once agy's own turn has gone quiet, has its permission go through OpenRig again.
    seat.type("BACKGROUND");
    const answer = await waitFor(() => seat.log().find((entry) => entry.id === "perm-late" && entry.method === undefined), "the next prompt's request", 30_000);
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(openrig.submits).toHaveLength(1);
  }, 40_000);

  it("reopens only by session/resume, and reports a conversation agy can't reopen and doesn't list as missing", async () => {
    const openrig = await fakeOpenRig();
    const seat = start(openrig, { env: { OPENRIG_RESUME_REF: "gone-1", FAKE_CAPS: JSON.stringify({ sessionCapabilities: { resume: {}, list: {} } }) } });
    expect(await seat.exited).toBe(3);
    expect(seat.launch()).toMatchObject({ harness: "agy", error: "missing" });
    const log = seat.log();
    expect(requests(log, "session/resume")).toHaveLength(1);
    expect(requests(log, "session/load")).toHaveLength(0);
    expect(requests(log, "session/new")).toHaveLength(0);
  });
});

describe("the documented agy presets", () => {
  it("loads the runner preset as the default, with every limit read as text", () => {
    const loaded = loadCommunityHarnessPreset("agy", EXAMPLE);
    expect(loaded).toMatchObject({ ok: true, preset: { runner: true, launchResult: true, firstInput: true, resume: true, namesConversation: false } });
    if (!loaded.ok) return;
    expect(loaded.preset.command).toMatch(/openrig-agy-runner\.mjs .*--key-file .*--model /);
    expect(loaded.preset.limits.length).toBeGreaterThan(0);
  });

  it("loads the plain preset as the fallback, and its launcher reports a missing conversation under the preset's own name", () => {
    expect(loadCommunityHarnessPreset("agy-plain", EXAMPLE)).toMatchObject({ ok: true, preset: { runner: false, launchResult: true, resume: true } });
    const dir = mkdtempSync(join(tmpdir(), "agy-plain-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const result = join(dir, "result.json");
    const run = spawnSync("sh", [join(EXAMPLE, "openrig-agy-launch"), "--agy-home", dir, "--agy", "/nonexistent/agy"], { encoding: "utf8",
      env: { PATH: process.env["PATH"]!, HOME: dir, OPENRIG_RESUME_REF: "gone-1", OPENRIG_RUNTIME: "agy-plain", OPENRIG_LAUNCH_RESULT: result, OPENRIG_LAUNCH_ATTEMPT: "attempt-1" } });
    expect(run.status).toBe(1);
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ attempt: "attempt-1", harness: "agy-plain", error: "missing" });
  });
});

describe("the documented fallback launcher on a Gemini API key", () => {
  // A stand-in agy: logs its arguments and whether it got the key, and answers the headless first turn with an id.
  const FAKE_PLAIN = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), key: process.env.GEMINI_API_KEY ?? null }) + "\\n");
if (process.argv.includes("-p")) process.stdout.write(JSON.stringify({ conversation_id: "conv-1", response: "ready" }));
`;
  // Stand-ins for the launcher's own helpers, first on PATH: the parse (jq) and the report's move (mv). Each logs only
  // whether it got a key, never a value, then does the helper's job.
  const FAKE_JQ = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.HELPER_LOG, "jq " + ("GEMINI_API_KEY" in process.env ? "key" : "none") + "\\n");
try { const id = JSON.parse(readFileSync(0, "utf8")).conversation_id; if (id) process.stdout.write(id + "\\n"); } catch {}
`;
  const FAKE_MV = `#!/bin/sh
if [ "\${GEMINI_API_KEY+set}" = set ]; then echo "mv key" >> "$HELPER_LOG"; else echo "mv none" >> "$HELPER_LOG"; fi
exec /bin/mv "$@"
`;
  function launch(extra: string[], keyFile?: string, helpers = false) {
    const dir = mkdtempSync(join(tmpdir(), "agy-plain-key-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, "fake-agy.mjs");
    writeFileSync(fake, FAKE_PLAIN);
    chmodSync(fake, 0o755);
    const key = keyFile ?? join(dir, "gemini-api-key");
    if (!keyFile) writeFileSync(key, `${KEY}\n`, { mode: 0o600 });
    const log = join(dir, "agy.log"), result = join(dir, "result.json"), helperLog = join(dir, "helpers.log"), bin = join(dir, "bin");
    if (helpers) {
      mkdirSync(bin);
      writeFileSync(join(bin, "jq"), FAKE_JQ, { mode: 0o755 });
      writeFileSync(join(bin, "mv"), FAKE_MV, { mode: 0o755 });
    }
    const run = spawnSync("sh", [join(EXAMPLE, "openrig-agy-launch"), "--agy-home", dir, "--agy", fake, "--key-file", key, ...extra], { encoding: "utf8",
      env: { PATH: helpers ? `${bin}:${process.env["PATH"]!}` : process.env["PATH"]!, HOME: dir, FAKE_LOG: log, HELPER_LOG: helperLog,
        OPENRIG_RUNTIME: "agy-plain", OPENRIG_LAUNCH_RESULT: result, OPENRIG_LAUNCH_ATTEMPT: "attempt-1" } });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; key: string | null }) : [];
    const helperCalls = existsSync(helperLog) ? readFileSync(helperLog, "utf8").split("\n").filter(Boolean) : [];
    return { run, calls, helperCalls, record: existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) as Record<string, unknown> : undefined };
  }

  it("gives agy the key in its environment only, and pins the model for the first turn and the terminal UI", () => {
    const { run, calls, record } = launch(["--model", "gemini-4-neon-high"]);
    expect(run.status).toBe(0);
    expect(calls).toEqual([
      { argv: ["--model", "gemini-4-neon-high", "-p", "Reply with exactly: ready", "--output-format", "json"], key: KEY },
      { argv: ["--model", "gemini-4-neon-high", "--conversation", "conv-1"], key: KEY },
    ]);
    expect(record).toMatchObject({ harness: "agy-plain", nativeRef: "conv-1" });
    expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
  });

  it("keeps the key out of the launcher's own helpers: the parse and the report's move get none, while agy gets it", () => {
    const { run, calls, helperCalls, record } = launch(["--model", "gemini-4-neon-high"], undefined, true);
    expect(run.status).toBe(0);
    expect(helperCalls).toEqual(["jq none", "mv none"]);
    expect(calls.map((call) => call.key)).toEqual([KEY, KEY]);
    expect(record).toMatchObject({ harness: "agy-plain", nativeRef: "conv-1" });
  });

  it("passes a model name with a space as one argument", () => {
    const { calls } = launch(["--model", "my model"]);
    expect(calls.map((call) => call.argv.slice(0, 2))).toEqual([["--model", "my model"], ["--model", "my model"]]);
  });

  it("starts nothing when the key file can't be read", () => {
    const { run, calls, record } = launch([], "/nonexistent/gemini-api-key");
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/key file couldn't be read/);
    expect(calls).toEqual([]);
    expect(record).toBeUndefined();
  });
});
