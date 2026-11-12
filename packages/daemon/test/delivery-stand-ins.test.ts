import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// packages/daemon/test -> packages/test-system/delivery/stand-ins
import { loadScript } from "../../test-system/delivery/stand-ins/core.mjs";
import { messagesTurnOf, startMessagesStandIn } from "../../test-system/delivery/stand-ins/messages.mjs";
import { responsesTurnOf, startResponsesStandIn } from "../../test-system/delivery/stand-ins/responses.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STAND_INS = resolve(HERE, "..", "..", "test-system", "delivery", "stand-ins");

// The request shapes below follow the vendors' wire contracts (Claude Code's gateway protocol page; Codex's Responses
// reader), not recordings from the real programs: those come when the suite may run the real TUIs.

type StandIn = Awaited<ReturnType<typeof startMessagesStandIn>>;
const open: StandIn[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });

async function start(kind: "messages" | "responses", options: Record<string, unknown>) {
  const standIn = kind === "messages" ? await startMessagesStandIn(options) : await startResponsesStandIn(options);
  open.push(standIn);
  return standIn;
}

function events(raw: string) {
  return raw.split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

const userTurn = (text: string) => ({ model: "claude-haiku-stand-in", stream: true, max_tokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>context</system-reminder>" }, { type: "text", text }] }] });
const codexTurn = (text: string) => ({ model: "gpt-stand-in", stream: true, instructions: "be brief",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] });

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("delivery suite stand-ins: the Claude Code Messages API", () => {
  it("streams a reply carrying the turn's marker, ending with message_delta and message_stop", async () => {
    const standIn = await start("messages", { script: { rules: [{ say: "got {{marker}}", chunks: 3 }] } });
    const res = await post(`${standIn.url}/v1/messages?beta=true`, userTurn("please read DLV-D01-a1b2 now"), { authorization: "Bearer token" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const stream = events(res.text);
    expect(stream.map((e) => e.event)).toEqual(["message_start", "content_block_start", "ping",
      "content_block_delta", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(stream.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("")).toBe("got DLV-D01-a1b2");
    expect(stream.at(-2)!.data.delta.stop_reason).toBe("end_turn");

    const [logged] = standIn.requests();
    expect(logged).toMatchObject({ seq: 1, method: "POST", path: "/v1/messages", query: "?beta=true", marker: "DLV-D01-a1b2", rule: 0, action: "say",
      turn: { kind: "user", text: "<system-reminder>context</system-reminder>\nplease read DLV-D01-a1b2 now" } });
    // The token is recorded as present, never kept.
    expect(logged.headers.authorization).toBe("(present)");
  });

  it("answers a request that doesn't stream with one message", async () => {
    const standIn = await start("messages", { script: { rules: [] } });
    const res = await post(`${standIn.url}/v1/messages`, { ...userTurn("title this DLV-x"), stream: false });
    expect(JSON.parse(res.text)).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok DLV-x" }] });
  });

  it("asks for a tool in the script's own shape, then answers its result", async () => {
    const tool = { name: "Bash", input: { command: "echo stand-in", description: "harmless" } };
    const standIn = await start("messages", { script: { rules: [{ when: "DLV-D05", tool, times: 1 }] } });
    const stream = events((await post(`${standIn.url}/v1/messages`, userTurn("run it DLV-D05-1"))).text);
    const startBlock = stream.find((e) => e.event === "content_block_start")!.data.content_block;
    expect(startBlock).toMatchObject({ type: "tool_use", name: "Bash", input: {} });
    expect(JSON.parse(stream.find((e) => e.event === "content_block_delta")!.data.delta.partial_json)).toEqual(tool.input);
    expect(stream.find((e) => e.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use");

    const result = { model: "m", stream: true, messages: [
      { role: "user", content: "run it DLV-D05-1" },
      { role: "assistant", content: [{ type: "tool_use", id: startBlock.id, name: "Bash", input: tool.input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: startBlock.id, content: "stand-in" }] },
    ] };
    const after = events((await post(`${standIn.url}/v1/messages`, result)).text);
    expect(after.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("")).toBe("done");
    expect(standIn.requests()[1]).toMatchObject({ turn: { kind: "tool_result", text: "stand-in" }, rule: null });
  });

  it("returns a scripted rate limit as an HTTP 429 with its headers", async () => {
    const standIn = await start("messages", { script: { rules: [{ error: { status: 429, headers: { "retry-after": "120", "x-should-retry": "false" },
      body: { type: "error", error: { type: "rate_limit_error", message: "stand-in throttle" } } } }] } });
    const res = await post(`${standIn.url}/v1/messages`, userTurn("DLV-D16"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(JSON.parse(res.text).error.type).toBe("rate_limit_error");
  });

  it("can fail after the stream starts, without a message_stop", async () => {
    const standIn = await start("messages", { script: { rules: [{ failInStream: { type: "overloaded_error", message: "stand-in overload" } }] } });
    const stream = events((await post(`${standIn.url}/v1/messages`, userTurn("DLV-x"))).text);
    expect(stream.at(-1)).toMatchObject({ event: "error", data: { error: { type: "overloaded_error" } } });
    expect(stream.some((e) => e.event === "message_stop")).toBe(false);
  });

  it("estimates count_tokens, and refuses and logs any other path", async () => {
    const standIn = await start("messages", { script: { rules: [] } });
    expect(JSON.parse((await post(`${standIn.url}/v1/messages/count_tokens`, userTurn("x"))).text).input_tokens).toBeGreaterThan(0);
    expect((await fetch(`${standIn.url}/api/hello`, { method: "HEAD" })).status).toBe(404);
    expect(standIn.requests().map((r) => [r.path, r.served])).toEqual([["/v1/messages/count_tokens", "other"], ["/api/hello", "not-found"]]);
  });

  it("reads the typed text and tool results out of the request's last turn", () => {
    expect(messagesTurnOf({ messages: [{ role: "user", content: "plain" }] })).toEqual({ kind: "user", text: "plain", parts: ["plain"] });
    expect(messagesTurnOf({ messages: [{ role: "assistant", content: "hi" }] })).toEqual({ kind: "other", text: "", parts: [] });
    expect(messagesTurnOf({})).toEqual({ kind: "other", text: "", parts: [] });
  });
});

describe("delivery suite stand-ins: the Codex Responses API", () => {
  it("streams a reply ending with response.completed", async () => {
    const standIn = await start("responses", { script: { rules: [{ say: "seen {{marker}}", chunks: 2 }] } });
    const res = await post(`${standIn.url}/v1/responses`, codexTurn("deliver DLV-D02-77"));
    const stream = events(res.text);
    expect(stream.map((e) => e.event)).toEqual(["response.created", "response.output_item.added",
      "response.output_text.delta", "response.output_text.delta", "response.output_item.done", "response.completed"]);
    expect(stream.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("")).toBe("seen DLV-D02-77");
    const completed = stream.at(-1)!.data.response;
    expect(completed.id).toBe(stream[0]!.data.response.id);
    expect(completed.output[0].content[0].text).toBe("seen DLV-D02-77");
    expect(standIn.requests()[0]).toMatchObject({ path: "/v1/responses", marker: "DLV-D02-77", turn: { kind: "user", text: "deliver DLV-D02-77" } });
  });

  it("asks for a tool as a function_call item, and reads its output as a tool result", async () => {
    const standIn = await start("responses", { script: { rules: [{ tool: { name: "shell", input: { command: ["echo", "stand-in"] } }, times: 1 }] } });
    const stream = events((await post(`${standIn.url}/v1/responses`, codexTurn("DLV-D05"))).text);
    const call = stream.find((e) => e.event === "response.output_item.done")!.data.item;
    expect(call).toMatchObject({ type: "function_call", name: "shell" });
    expect(JSON.parse(call.arguments)).toEqual({ command: ["echo", "stand-in"] });
    expect(stream.at(-1)!.event).toBe("response.completed");

    await post(`${standIn.url}/v1/responses`, { ...codexTurn("DLV-D05"), input: [...codexTurn("DLV-D05").input, call,
      { type: "function_call_output", call_id: call.call_id, output: "stand-in" }] });
    expect(standIn.requests()[1]).toMatchObject({ turn: { kind: "tool_result", text: "stand-in" }, action: "say" });
  });

  it("returns Codex's usage-limit answer as a 429, and an in-stream rate limit as response.failed", async () => {
    const resetsAt = 1_900_000_000;
    const standIn = await start("responses", { script: { rules: [
      { when: "limit", error: { status: 429, body: { error: { type: "usage_limit_reached", resets_at: resetsAt, plan_type: "plus" } } } },
      { when: "throttle", failInStream: { code: "rate_limit_exceeded", message: "stand-in throttle" } },
    ] } });
    const limit = await post(`${standIn.url}/v1/responses`, codexTurn("limit DLV-D16"));
    expect(limit.status).toBe(429);
    expect(JSON.parse(limit.text).error).toEqual({ type: "usage_limit_reached", resets_at: resetsAt, plan_type: "plus" });
    const stream = events((await post(`${standIn.url}/v1/responses`, codexTurn("throttle DLV-D16"))).text);
    expect(stream.at(-1)).toMatchObject({ event: "response.failed", data: { response: { error: { code: "rate_limit_exceeded" } } } });
    expect(stream.some((e) => e.event === "response.completed")).toBe(false);
  });

  it("refuses and logs a path it doesn't serve, such as a models list", async () => {
    const standIn = await start("responses", { script: { rules: [] } });
    expect((await fetch(`${standIn.url}/v1/models`)).status).toBe(404);
    expect(standIn.requests()[0]).toMatchObject({ method: "GET", path: "/v1/models", served: "not-found" });
  });

  it("reads the last input item as the turn", () => {
    expect(responsesTurnOf({ input: "just text" })).toEqual({ kind: "user", text: "just text", parts: ["just text"] });
    expect(responsesTurnOf({ input: [{ type: "reasoning", summary: [] }] })).toEqual({ kind: "other", text: "", parts: [] });
  });
});

describe("delivery suite stand-ins: what the log keeps about each turn", () => {
  it("keeps each part's exact bytes and sha256, so a multi-line message can be compared byte for byte", async () => {
    const message = "line one DLV-D15-1\n  indented 'quoted' \"double\" $(echo not-run) ✓\nlast";
    const standIn = await start("messages", { script: { rules: [] } });
    await post(`${standIn.url}/v1/messages`, userTurn(message));
    const { turn, userTurns } = standIn.requests()[0];
    expect(userTurns).toBe(1);
    expect(turn.parts).toHaveLength(2); // the program's own context block, then the delivered message
    expect(turn.parts[1]).toEqual({ text: message, bytes: Buffer.byteLength(message, "utf8"),
      sha256: createHash("sha256").update(message, "utf8").digest("hex"), markers: ["DLV-D15-1"] });
  });

  it("shows two sends merged into one turn as two markers in it, and counts the history's user turns", async () => {
    const standIn = await start("responses", { script: { rules: [] } });
    await post(`${standIn.url}/v1/responses`, { ...codexTurn("x"), input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "earlier DLV-D09-1" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second DLV-D09-2" }, { type: "input_text", text: "third DLV-D09-3" }] },
    ] });
    const { turn, userTurns } = standIn.requests()[0];
    expect(userTurns).toBe(2);
    expect(turn.parts.map((p: { markers: string[] }) => p.markers)).toEqual([["DLV-D09-2"], ["DLV-D09-3"]]);
  });

  it("doesn't count a message of tool results as a user turn", async () => {
    const standIn = await start("messages", { script: { rules: [] } });
    await post(`${standIn.url}/v1/messages`, { model: "m", stream: true, messages: [
      { role: "user", content: "go DLV-1" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
    ] });
    expect(standIn.requests()[0]).toMatchObject({ userTurns: 1, turn: { kind: "tool_result", parts: [{ text: "out", bytes: 3 }] } });
  });
});

describe("delivery suite stand-ins: the script and the harness controls", () => {
  it("holds a gated answer until the case releases the gate, having logged the request on arrival", async () => {
    const standIn = await start("responses", { script: { rules: [{ gate: "turn-1", say: "late" }] } });
    let settled = false;
    const pending = post(`${standIn.url}/v1/responses`, codexTurn("DLV-D02")).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    expect((await (await fetch(`${standIn.url}/_stand-in/requests`)).json())).toHaveLength(1);
    expect((await fetch(`${standIn.url}/_stand-in/release/turn-1`, { method: "POST" })).status).toBe(204);
    expect(events((await pending).text).at(-1)!.event).toBe("response.completed");
  });

  it("uses a rule only as many times as it says, then falls through", async () => {
    const standIn = await start("messages", { script: { rules: [{ say: "first", times: 1 }, { say: "after" }] } });
    const text = async () => events((await post(`${standIn.url}/v1/messages`, userTurn("DLV-x"))).text)
      .filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("");
    expect([await text(), await text(), await text()]).toEqual(["first", "after", "after"]);
  });

  it("writes every request to the JSONL log as it arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stand-in-log-"));
    try {
      const logPath = join(dir, "requests.jsonl");
      const standIn = await start("messages", { script: { rules: [] }, logPath });
      await post(`${standIn.url}/v1/messages`, userTurn("one DLV-1"));
      await post(`${standIn.url}/v1/messages`, userTurn("two DLV-2"));
      const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => [l.seq, l.marker])).toEqual([[1, "DLV-1"], [2, "DLV-2"]]);
      expect(lines[0].body.messages.at(-1).content.at(-1).text).toBe("one DLV-1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a rule with no action or two", () => {
    expect(() => loadScript({ rules: [{ when: "x" }] })).toThrow(/exactly one of/);
    expect(() => loadScript({ rules: [{ say: "a", tool: { name: "t" } }] })).toThrow(/has say, tool/);
    expect(() => loadScript({ rules: [{ say: "a", on: "assistant" }] })).toThrow(/on must be/);
  });

  it("runs from the command line and says where it listens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stand-in-cli-"));
    const scriptPath = join(dir, "script.json");
    writeFileSync(scriptPath, JSON.stringify({ rules: [{ say: "cli {{marker}}" }] }));
    const child = spawn(process.execPath, [join(STAND_INS, "responses.mjs"), "--script", scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let out = "";
        child.stdout.on("data", (d) => { out += d; const m = out.match(/READY (\S+)/); if (m) resolveUrl(m[1]!); });
        child.on("exit", (code) => reject(new Error(`exited ${code}`)));
      });
      const stream = events((await post(`${url}/v1/responses`, codexTurn("DLV-cli"))).text);
      expect(stream.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join("")).toBe("cli DLV-cli");
    } finally { child.kill("SIGTERM"); rmSync(dir, { recursive: true, force: true }); }
  });
});
