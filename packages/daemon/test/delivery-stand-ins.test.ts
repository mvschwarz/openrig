import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:http";
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
    expect(logged).toMatchObject({ seq: 1, method: "POST", path: "/v1/messages", marker: "DLV-D01-a1b2", rule: 0, action: "say",
      turn: { kind: "user", text: "<system-reminder>context</system-reminder>\nplease read DLV-D01-a1b2 now" } });
    // The token is recorded as present, never kept.
    expect(logged.headers.authorization).toBe("(present)");
    expect(logged.headers["content-type"]).toBe("application/json");
    expect(logged.query).toEqual({ beta: "true" });
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
    expect(messagesTurnOf({ messages: [{ role: "user", content: "plain" }] })).toEqual({ kind: "user", text: "plain", parts: [{ text: "plain", source: "text" }] });
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
    expect(responsesTurnOf({ input: "just text" })).toEqual({ kind: "user", text: "just text", parts: [{ text: "just text", source: "text" }] });
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
    expect(turn.parts[1]).toEqual({ text: message, source: "text", bytes: Buffer.byteLength(message, "utf8"),
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

  it("keeps a message typed during a tool run beside the tool's result, and matches and marks it (Claude)", async () => {
    const standIn = await start("messages", { script: { rules: [{ on: "tool_result", when: "DLV-D02", say: "saw {{marker}}" }] } });
    const stream = events((await post(`${standIn.url}/v1/messages`, { model: "m", stream: true, messages: [
      { role: "user", content: "start DLV-D02-0" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "tool out" }, { type: "text", text: "while busy DLV-D02-1" }] },
    ] })).text);
    expect(stream.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("")).toBe("saw DLV-D02-1");
    const { turn, marker, userTurns } = standIn.requests()[0];
    expect(marker).toBe("DLV-D02-1");
    expect(userTurns).toBe(2);
    expect(turn.kind).toBe("tool_result");
    expect(turn.parts.map((p: { source: string; text: string }) => [p.source, p.text])).toEqual([["tool_result", "tool out"], ["text", "while busy DLV-D02-1"]]);
  });

  it("keeps a message typed during a tool run after the tool's output (Codex)", async () => {
    const standIn = await start("responses", { script: { rules: [] } });
    await post(`${standIn.url}/v1/responses`, { ...codexTurn("x"), input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "start DLV-D02-0" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "tool out" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "while busy DLV-D02-1" }] },
    ] });
    const { turn, marker } = standIn.requests()[0];
    expect(marker).toBe("DLV-D02-1");
    expect(turn.kind).toBe("tool_result");
    expect(turn.parts.map((p: { source: string; text: string }) => [p.source, p.text])).toEqual([["tool_result", "tool out"], ["text", "while busy DLV-D02-1"]]);
  });

  it("keeps each text block of a tool result as its own part, not joined (Claude and Codex)", async () => {
    const claude = await start("messages", { script: { rules: [] } });
    await post(`${claude.url}/v1/messages`, { model: "m", stream: true, messages: [
      { role: "user", content: "go DLV-1" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "first block" }, { type: "text", text: "second block" }] }] },
    ] });
    expect(claude.requests()[0].turn.parts.map((p: { source: string; text: string; bytes: number }) => [p.source, p.text, p.bytes]))
      .toEqual([["tool_result", "first block", 11], ["tool_result", "second block", 12]]);

    const codex = await start("responses", { script: { rules: [] } });
    await post(`${codex.url}/v1/responses`, { ...codexTurn("x"), input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go DLV-1" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      // Current Codex sends a tool's output as a list of input_text items.
      { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "first block" }, { type: "input_text", text: "second block" }] },
    ] });
    expect(codex.requests()[0].turn.parts.map((p: { source: string; text: string }) => [p.source, p.text]))
      .toEqual([["tool_result", "first block"], ["tool_result", "second block"]]);
  });

  it.each([
    ["empty", []],
    ["image-only", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]],
  ])("dispatches a Claude tool result with no text (%s) as a tool round, with or without typed text beside it", async (_label, content) => {
    const standIn = await start("messages", { script: { rules: [{ on: "tool_result", say: "round" }] } });
    const history = [{ role: "user", content: "go DLV-1" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] }];
    for (const extra of [[], [{ type: "text", text: "typed DLV-2" }]]) {
      await post(`${standIn.url}/v1/messages`, { model: "m", stream: true, messages: [...history,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }, ...extra] }] });
    }
    const [alone, mixed] = standIn.requests();
    expect([alone.turn.kind, alone.rule, alone.turn.parts]).toEqual(["tool_result", 0, []]);
    expect([mixed.turn.kind, mixed.rule, mixed.marker]).toEqual(["tool_result", 0, "DLV-2"]);
    expect(mixed.turn.parts.map((p: { source: string; text: string }) => [p.source, p.text])).toEqual([["text", "typed DLV-2"]]);
  });

  it.each([
    ["empty", []],
    ["image-only", [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }]],
  ])("dispatches a Codex tool output with no text (%s) as a tool round, with or without typed text after it", async (_label, output) => {
    const standIn = await start("responses", { script: { rules: [{ on: "tool_result", say: "round" }] } });
    const history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "go DLV-1" }] },
      { type: "function_call", call_id: "c1", name: "view_image", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output }];
    for (const extra of [[], [{ type: "message", role: "user", content: [{ type: "input_text", text: "typed DLV-2" }] }]]) {
      await post(`${standIn.url}/v1/responses`, { ...codexTurn("x"), input: [...history, ...extra] });
    }
    const [alone, mixed] = standIn.requests();
    expect([alone.turn.kind, alone.rule, alone.turn.parts]).toEqual(["tool_result", 0, []]);
    expect([mixed.turn.kind, mixed.rule, mixed.marker]).toEqual(["tool_result", 0, "DLV-2"]);
  });

  it("keeps the request body's raw size and sha256, to tie the parsed log to the wire", async () => {
    const standIn = await start("messages", { script: { rules: [] } });
    const raw = JSON.stringify(userTurn("wire DLV-1"));
    await fetch(`${standIn.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    expect(standIn.requests()[0]).toMatchObject({ rawBytes: Buffer.byteLength(raw), rawSha256: createHash("sha256").update(raw).digest("hex") });
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

  it("never logs a credential sent under a custom header or query name, only that it was present", async () => {
    const sentinel = "sk-SENTINEL-must-not-be-logged-0123456789";
    const dir = mkdtempSync(join(tmpdir(), "stand-in-sentinel-"));
    try {
      const logPath = join(dir, "requests.jsonl");
      const standIn = await start("responses", { script: { rules: [] }, logPath });
      await post(`${standIn.url}/v1/responses?api-key=${sentinel}&beta=1`, codexTurn("DLV-x"), { "x-provider-key": sentinel, "x-custom-auth": `Bearer ${sentinel}` });
      const served = await (await fetch(`${standIn.url}/_stand-in/requests`)).text();
      for (const recorded of [readFileSync(logPath, "utf8"), served]) {
        expect(recorded).not.toContain(sentinel);
        expect(recorded).toContain("x-provider-key");
        expect(recorded).toContain("api-key");
      }
      expect(standIn.requests()[0]).toMatchObject({ query: { "api-key": "(present)", beta: "1" }, headers: { "x-provider-key": "(present)", "x-custom-auth": "(present)" } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("listens on loopback only", async () => {
    await expect(startResponsesStandIn({ script: { rules: [] }, host: "0.0.0.0" })).rejects.toThrow(/loopback only/);
    const standIn = await start("messages", { script: { rules: [] }, host: "localhost" });
    expect(standIn.url).toContain("localhost");
  });

  it("brackets an IPv6 loopback address in its URL, and is reachable there", async () => {
    const standIn = await start("responses", { script: { rules: [] }, host: "::1" });
    expect(standIn.url).toBe(`http://[::1]:${standIn.port}`);
    // The test setup's fetch guard doesn't count [::1] as loopback, so this reaches it with node:http, still on this box.
    const raw = await new Promise<string>((resolveBody, reject) => {
      const req = request({ host: "::1", port: standIn.port, path: "/v1/responses", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (d) => { body += d; }); res.on("end", () => resolveBody(body));
      });
      req.on("error", reject); req.end(JSON.stringify(codexTurn("DLV-v6")));
    });
    expect(events(raw).at(-1)!.event).toBe("response.completed");
  });

  it("refuses a rule with no action or two", () => {
    expect(() => loadScript({ rules: [{ when: "x" }] })).toThrow(/exactly one of/);
    expect(() => loadScript({ rules: [{ say: "a", tool: { name: "t" } }] })).toThrow(/has say, tool/);
    expect(() => loadScript({ rules: [{ say: "a", on: "assistant" }] })).toThrow(/on must be/);
  });

  it("finds the turn before a trailing system message, as Claude Code 2.1.322 sends its environment", () => {
    // The shape recorded from a real Claude Code 2.1.322 seat on the stand-in: the turn, then a system message.
    const body = { model: "m", stream: true, messages: [
      { role: "user", content: [{ type: "text", text: "<system-reminder>context</system-reminder>" }, { type: "text", text: "start DLV-start-1" }] },
      { role: "system", content: [{ type: "text", text: "# Environment\nPrimary working directory: /w" }] },
    ] };
    expect(messagesTurnOf(body)).toMatchObject({ kind: "user", parts: [{ source: "text" }, { text: "start DLV-start-1", source: "text" }] });
    expect(messagesTurnOf({ messages: [{ role: "system", content: "only" }] })).toMatchObject({ kind: "other", parts: [] });
  });

  it("logs which conversation each request belongs to, so a side request quoting a delivery isn't counted as one", async () => {
    // Shapes recorded from real seats on the stand-ins: Codex 0.167.2's turn and its task-title side request, and
    // Claude Code 2.1.322's session in metadata.user_id.
    const codex = await start("responses", { script: { rules: [] } });
    const turn = { ...codexTurn("please DLV-T1"), tools: [{ type: "function", name: "exec" }], client_metadata: { thread_id: "thread-1", session_id: "thread-1" } };
    const title = { ...codexTurn("Generate a concise title for: please DLV-T1"), tools: [], client_metadata: { "x-codex-window-id": "w:0" },
      text: { format: { type: "json_schema", strict: true, name: "title", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } } };
    await post(`${codex.url}/v1/responses`, turn, { "x-stainless-retry-count": "0", "thread-id": "thread-1" });
    const titled = events((await post(`${codex.url}/v1/responses`, title)).text);
    expect(JSON.parse(titled.filter((e) => e.event === "response.output_text.delta").map((e) => e.data.delta).join(""))).toEqual({ title: "stand-in" });
    expect(codex.requests().map((r) => [r.marker, r.request])).toEqual([
      ["DLV-T1", { thread: "thread-1", tools: 1, structuredOutput: false }],
      ["DLV-T1", { thread: null, tools: 0, structuredOutput: true }],
    ]);
    expect(codex.requests()[0].headers).toMatchObject({ "x-stainless-retry-count": "0", "thread-id": "thread-1" });

    const claude = await start("messages", { script: { rules: [] } });
    await post(`${claude.url}/v1/messages`, { ...userTurn("DLV-T2"), tools: [{ name: "Bash" }],
      metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: "sess-1" }) } }, { "x-stainless-retry-count": "1" });
    expect(claude.requests()[0]).toMatchObject({ request: { thread: "sess-1", tools: 1, structuredOutput: false }, headers: { "x-stainless-retry-count": "1" } });
  });

  it("refuses a script whose rules aren't a list, or whose patterns don't compile, at load", () => {
    expect(() => loadScript({ rules: { say: "a" } })).toThrow(/rules must be a list/);
    expect(() => loadScript({ rules: "say a" })).toThrow(/rules must be a list/);
    expect(() => loadScript({ rules: [null] })).toThrow(/must be an object/);
    expect(() => loadScript({ rules: [{ say: "a", when: "DLV-(" }] })).toThrow(/rule 0: when isn't a valid pattern/);
    expect(() => loadScript({ marker: "[", rules: [] })).toThrow(/marker isn't a valid pattern/);
    // No rules at all is the fallback script, not a mistake.
    expect(loadScript({}).rules).toEqual([]);
  });

  it.each(["messages", "responses"] as const)("answers a request body that isn't JSON with an error, not a scripted reply (%s)", async (kind) => {
    const standIn = await start(kind, { script: { rules: [{ say: "never {{marker}}" }] } });
    const path = kind === "messages" ? "/v1/messages" : "/v1/responses";
    for (const raw of ['{"model": "x", "stream": tru', ""]) {
      const res = await fetch(`${standIn.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("never");
    }
    expect(standIn.requests().map((r) => [r.served, r.rule])).toEqual([["malformed", undefined], ["malformed", undefined]]);
    expect(standIn.requests()[0]).toMatchObject({ body: '{"model": "x", "stream": tru', rawBytes: 28 });
  });

  it("answers 500 and records the failure when it can't write its log, rather than serving a turn it didn't keep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stand-in-logfail-"));
    try {
      // A directory where the log file should be: every append fails.
      const standIn = await start("responses", { script: { rules: [] }, logPath: dir });
      const res = await post(`${standIn.url}/v1/responses`, codexTurn("DLV-logfail"));
      expect(res.status).toBe(500);
      expect(JSON.parse(res.text)).toMatchObject({ error: { type: "stand_in_error" } });
      expect(standIn.errors()).toEqual([expect.objectContaining({ method: "POST", path: "/v1/responses", message: expect.stringMatching(/EISDIR/) })]);
      // A credential in the failing request's query stays out of the error record too.
      const sentinel = "sk-SENTINEL-error-path-0123456789";
      await post(`${standIn.url}/v1/responses?api-key=${sentinel}`, codexTurn("DLV-logfail-2"));
      expect(JSON.stringify(standIn.errors())).not.toContain(sentinel);
      expect(standIn.errors()[1]).toMatchObject({ path: "/v1/responses", query: { "api-key": "(present)" } });
      const served = await (await fetch(`${standIn.url}/_stand-in/errors`)).json();
      expect(served).toHaveLength(2);
      expect(JSON.stringify(served)).not.toContain(sentinel);
      // The server is still up for the next request.
      expect((await fetch(`${standIn.url}/_stand-in/requests`)).status).toBe(200);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
