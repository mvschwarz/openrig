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
log({ start: { argv: process.argv.slice(2), DSH_HOME: process.env.DSH_HOME ?? null, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
  DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? null, token: "OPENRIG_ACTIVITY_HOOK_TOKEN" in process.env } });
process.stdout.write("dsh: a log line that isn't JSON\\n");
let session = null; let held = null; let cancelled = false; const waiting = new Map();
const update = (u) => send({ method: "session/update", params: { sessionId: session, update: u } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); log(message);
  if (message.method === undefined) { const done = waiting.get(message.id); waiting.delete(message.id); done?.(message); return; }
  const reply = (result) => send({ id: message.id, result });
  const fail = (code, text) => send({ id: message.id, error: { code, message: text } });
  switch (message.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: JSON.parse(process.env.FAKE_CAPS ?? "{}"), agentInfo: { name: "dsh", version: "0.2.1-rc.2" } });
    case "session/new": session = "sess-new-1"; return reply({ sessionId: session });
    case "session/resume": case "session/load": {
      if (process.env.FAKE_RESUME === "missing") return fail(-32002, "Resource not found");
      if (process.env.FAKE_RESUME === "error") return fail(-32603, "the session store is locked");
      session = message.params.sessionId; return reply({});
    }
    case "session/cancel": cancelled = true; if (held) { held(); held = null; } return;
    case "session/prompt": {
      cancelled = false;
      const text = message.params.prompt.map((part) => part.text).join("");
      const end = (stopReason) => reply({ stopReason });
      if (text.includes("EXIT")) process.exit(0);
      if (text.includes("PERMIT")) {
        say("checking");
        waiting.set("perm-1", (response) => { say("outcome " + JSON.stringify(response.result?.outcome ?? null)); end(cancelled ? "cancelled" : "end_turn"); });
        return send({ id: "perm-1", method: "session/request_permission", params: { sessionId: session,
          toolCall: { toolCallId: "t1", title: "Edit a.txt", kind: "edit" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" }] } });
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

type Permissions = "absent" | "deny" | "stale" | "revoked" | "broken" | "permitted" | "answer" | "saidno" | "unknown" | "readfail" | "pending" | "lost";
interface Hook { auth: string | undefined; body: Record<string, unknown> }

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fakeOpenRig(permissions: Permissions) {
  const hooks: Hook[] = [];
  const submits: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
  const withdraws: Array<{ askId: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url ?? "/", "http://openrig.test");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (req.method === "POST" && url.pathname === "/api/activity/hooks") { hooks.push({ auth: req.headers.authorization, body }); return json(200, { ok: true }); }
      if (permissions === "absent") return json(404, { error: "not found" });
      if (req.method === "POST" && url.pathname === "/api/activity/permission-requests") {
        submits.push({ auth: req.headers.authorization, body });
        if (permissions === "deny") return json(409, { ok: false, code: "denied_by_seat", error: "This seat's operator chose to refuse its runner's permission requests." });
        if (permissions === "stale") return json(409, { ok: false, code: "stale_generation", error: "This request isn't from the seat's current occupant." });
        if (permissions === "broken") return json(500, { ok: false, code: "internal_error", error: "Something went wrong." });
        if (permissions === "revoked") return json(401, { ok: false, code: "activity_grant_revoked", error: "This activity grant was revoked; nothing was asked." });
        if (permissions === "permitted") return json(200, { ok: true, state: "permitted", optionId: "allow", reason: "no one can be asked: no person is registered" });
        return json(200, { ok: true, askId: "ask-1", created: true });
      }
      const withdraw = url.pathname.match(/^\/api\/activity\/permission-requests\/([^/]+)\/withdraw$/);
      if (req.method === "POST" && withdraw) { withdraws.push({ askId: withdraw[1]!, body }); return json(200, { ok: true, state: "withdrawn" }); }
      if (req.method === "GET" && url.pathname === "/api/activity/permission-requests/ask-1") {
        if (permissions === "answer") return json(200, { ok: true, state: "answered", optionId: "allow" });
        if (permissions === "saidno") return json(200, { ok: true, state: "refused", reason: "said_no" });
        if (permissions === "unknown") return json(200, { ok: true, state: "deferred" });
        if (permissions === "readfail") return json(500, { ok: false, code: "internal_error", error: "Something went wrong." });
        if (permissions === "lost") return json(404, { ok: false, code: "not_found", error: "No permission request ask-1 for this seat." });
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

function start(openrig: { url: string }, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-example-"));
  const fake = join(dir, "fake-dsh.mjs");
  writeFileSync(fake, FAKE_DSH);
  chmodSync(fake, 0o755);
  const logFile = join(dir, "dsh.log");
  const launchResult = join(dir, "launch", "result.json");
  mkdirSync(join(dir, "launch"));
  const child: ChildProcess = spawn(process.execPath, [RUNNER], { cwd: dir, stdio: "pipe", env: {
    PATH: process.env["PATH"]!, OPENRIG_DSH: fake, FAKE_LOG: logFile, OPENRIG_HOME: join(dir, "home"),
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
    const seat = start(openrig);
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

  it.each(["absent", "permitted"] as const)("permits with the agent's own allow when no one can be asked (OpenRig %s)", async (permissions) => {
    const openrig = await fakeOpenRig(permissions);
    const seat = start(openrig);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await waitFor(() => has(openrig.hooks, "Stop/end_turn"), "the turn's idle report");
    expect(has(openrig.hooks, "Notification/permission_prompt")).toBeUndefined();
    expect(seat.out()).toMatch(/\[permission\] permitted/);
  });

  it.each([
    ["OpenRig can't be reached", "absent", { OPENRIG_URL: "http://127.0.0.1:1" }],
    ["the submit is answered with a status the contract doesn't list", "broken", {}],
    ["the submit's grant was revoked, which can happen to the live occupant", "revoked", {}],
    ["reading the answer gets a state the contract doesn't list", "unknown", {}],
    ["reading the answer gets an unexpected reply", "lost", {}],
  ] as const)("permits with the agent's own allow when %s, since nobody can be asked", async (_case, permissions, env) => {
    const openrig = await fakeOpenRig(permissions);
    const seat = start(openrig, env);
    await waitFor(seat.launch, "the launch record");
    seat.type("PERMIT an edit");
    const answer = await waitFor(() => responseTo(seat.log(), "perm-1"), "the runner's answer to the permission request");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(has(openrig.hooks, "Notification/permission_prompt")).toBeUndefined();
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
