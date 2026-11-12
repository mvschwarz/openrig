// The Claude Code stand-in: Anthropic's Messages API, as Claude Code reaches it through ANTHROPIC_BASE_URL with
// ANTHROPIC_AUTH_TOKEN (https://code.claude.com/docs/en/llm-gateway-protocol, checked 2026-11-12). It serves streamed
// POST /v1/messages through message_delta and message_stop, which Claude Code needs to treat a turn as complete, and a
// non-streamed answer when a request doesn't ask to stream. count_tokens is answered with a rough estimate. Anything
// else, including the best-effort HEAD /api/hello probe, is refused and logged.

import { pathToFileURL } from "node:url";
import { fillMarker, runCli, splitChunks, sse, startStandIn } from "./core.mjs";

/** The request's last turn: what the person (or OpenRig, typing for them) sent, or a tool's result. */
export function messagesTurnOf(body) {
  const last = Array.isArray(body?.messages) ? body.messages.at(-1) : null;
  if (!last || last.role !== "user") return { kind: "other", text: "", parts: [] };
  if (typeof last.content === "string") return { kind: "user", text: last.content, parts: [last.content] };
  const blocks = Array.isArray(last.content) ? last.content : [];
  if (blocks.some((block) => block?.type === "tool_result")) {
    const parts = blocks.filter((b) => b?.type === "tool_result").map((b) => typeof b.content === "string" ? b.content
      : (Array.isArray(b.content) ? b.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : ""));
    return { kind: "tool_result", text: parts.join("\n"), parts };
  }
  const parts = blocks.filter((block) => block?.type === "text").map((block) => block.text);
  return { kind: "user", text: parts.join("\n"), parts };
}

const isToolResultOnly = (message) => Array.isArray(message.content) && message.content.length > 0
  && message.content.every((block) => block?.type === "tool_result");

/** How many user turns the request carries; a message made only of tool results isn't one. */
export function messagesUserTurns(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).filter((m) => m?.role === "user" && !isToolResultOnly(m)).length;
}

let ids = 0;
const nextId = (prefix) => `${prefix}_standin_${(++ids).toString().padStart(6, "0")}`;

async function answer({ res, body, rule, marker, stream, sleep }) {
  const model = typeof body?.model === "string" ? body.model : "stand-in";
  const usage = { input_tokens: 10, output_tokens: 1 };
  const text = rule.say !== undefined ? fillMarker(rule.say, marker) : null;
  const toolId = rule.tool ? nextId("toolu") : null;
  const messageId = nextId("msg");

  if (!stream) {
    const content = rule.tool ? [{ type: "tool_use", id: toolId, name: rule.tool.name, input: rule.tool.input ?? {} }] : [{ type: "text", text: text ?? "" }];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: messageId, type: "message", role: "assistant", model,
      content, stop_reason: rule.tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sse(res, "message_start", { type: "message_start", message: { id: messageId, type: "message", role: "assistant", model, content: [],
    stop_reason: null, stop_sequence: null, usage } });
  if (rule.tool) {
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: rule.tool.name, input: {} } });
    sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(rule.tool.input ?? {}) } });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  } else {
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse(res, "ping", { type: "ping" });
    const pieces = rule.failInStream ? [""] : splitChunks(text ?? "", rule.chunks ?? 1);
    for (const [i, piece] of pieces.entries()) {
      if (i > 0 && rule.chunkDelayMs) await sleep(rule.chunkDelayMs);
      if (piece) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
    }
    if (rule.failInStream) {
      // The streamed error Claude Code gets from the API mid-response (an overload, a rate limit).
      sse(res, "error", { type: "error", error: { type: rule.failInStream.type ?? "overloaded_error", message: rule.failInStream.message } });
      res.end();
      return;
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  }
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: rule.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function other(req, res, body, url) {
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    const chars = JSON.stringify(body ?? {}).length;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
    return true;
  }
  return false;
}

export const messagesProtocol = { path: "/v1/messages", turnOf: messagesTurnOf, userTurns: messagesUserTurns, answer, other };

/** Start the Claude Code stand-in; see core.mjs for the options and the script format. */
export function startMessagesStandIn(options) {
  return startStandIn(messagesProtocol, options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await runCli(startMessagesStandIn);
