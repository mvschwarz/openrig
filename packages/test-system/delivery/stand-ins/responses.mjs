// The Codex stand-in: OpenAI's Responses API, as Codex reaches it through a custom provider
// (`[model_providers.<id>]` with `base_url`, `wire_api = "responses"` and `requires_openai_auth = false`, which also
// skips Codex's login screen). The stream contract is taken from Codex's own reader (openai/codex
// codex-rs/codex-api/src/sse/responses.rs, checked 2026-11-12; the docs are silent): a turn ends with
// response.completed, and a stream that closes before it is an error. Codex makes no models fetch for a plain custom
// provider, so only POST <base_url>/responses is served; anything else is refused and logged.
//
// Point Codex at it with, for example:
//   model_provider = "standin"
//   [model_providers.standin]
//   name = "stand-in"
//   base_url = "http://127.0.0.1:<port>/v1"
//   wire_api = "responses"
//   requires_openai_auth = false

import { pathToFileURL } from "node:url";
import { fillMarker, runCli, splitChunks, sse, startStandIn } from "./core.mjs";

function itemParts(item) {
  if (typeof item?.content === "string") return [item.content];
  return (Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === "input_text" || part?.type === "text" || part?.type === "output_text")
    .map((part) => part.text);
}

function inputItems(body) {
  return Array.isArray(body?.input) ? body.input : (typeof body?.input === "string" ? [{ type: "message", role: "user", content: body.input }] : []);
}

/** How many user messages the request's input carries. */
export function responsesUserTurns(body) {
  return inputItems(body).filter((item) => (item?.type === "message" || item?.type === undefined) && item?.role === "user").length;
}

/** The request's last input item: a user message (what OpenRig typed), or a tool call's output. */
/** A tool output is a string or, in current Codex, a list of input_text items; each item stays its own part. */
function toolOutputParts(output) {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.filter((part) => typeof part?.text === "string").map((part) => part.text);
  return [JSON.stringify(output ?? "")];
}

const TOOL_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);
const isUserMessage = (item) => (item?.type === "message" || item?.type === undefined) && item?.role === "user";

/** The request's last turn: the run of tool outputs and user messages after the model's last item. A message typed
 *  while a tool ran can follow the tool's output in that run, so both are kept, in order. */
export function responsesTurnOf(body) {
  const input = inputItems(body);
  let start = input.length;
  while (start > 0 && (TOOL_OUTPUTS.has(input[start - 1]?.type) || isUserMessage(input[start - 1]))) start -= 1;
  const run = input.slice(start);
  const parts = run.flatMap((item) => TOOL_OUTPUTS.has(item.type)
    ? toolOutputParts(item.output).map((text) => ({ text, source: "tool_result" }))
    : itemParts(item).map((text) => ({ text, source: "text" })));
  // The kind comes from the items themselves: a tool output with no text still makes a tool round.
  if (run.length === 0) return { kind: "other", text: "", parts: [] };
  const kind = run.some((item) => TOOL_OUTPUTS.has(item.type)) ? "tool_result" : "user";
  return { kind, text: parts.map((part) => part.text).join("\n"), parts };
}

let ids = 0;
const nextId = (prefix) => `${prefix}_standin_${(++ids).toString().padStart(6, "0")}`;
const USAGE = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };

async function answer({ res, body, rule, marker, stream, sleep }) {
  const responseId = nextId("resp");
  const model = typeof body?.model === "string" ? body.model : "stand-in";
  const text = rule.say !== undefined ? fillMarker(rule.say, marker) : null;
  const item = rule.tool
    ? { type: "function_call", id: nextId("fc"), call_id: nextId("call"), name: rule.tool.name, arguments: JSON.stringify(rule.tool.input ?? {}), status: "completed" }
    : { type: "message", id: nextId("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: text ?? "", annotations: [] }] };

  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: responseId, object: "response", status: "completed", model, output: [item], usage: USAGE }));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const response = { id: responseId, object: "response", status: "in_progress", model, output: [] };
  sse(res, "response.created", { type: "response.created", response });
  if (rule.tool) {
    sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
  } else {
    sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    const pieces = rule.failInStream ? [""] : splitChunks(text ?? "", rule.chunks ?? 1);
    for (const [i, piece] of pieces.entries()) {
      if (i > 0 && rule.chunkDelayMs) await sleep(rule.chunkDelayMs);
      if (piece) sse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: piece });
    }
    if (rule.failInStream) {
      // A failure after the stream started, e.g. code rate_limit_exceeded, which Codex retries with backoff.
      sse(res, "response.failed", { type: "response.failed", response: { ...response, status: "failed",
        error: { code: rule.failInStream.code ?? "server_error", message: rule.failInStream.message } } });
      res.end();
      return;
    }
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
  }
  sse(res, "response.completed", { type: "response.completed", response: { ...response, status: "completed", output: [item], usage: USAGE } });
  res.end();
}

/** Codex names the conversation in client_metadata.thread_id; its side requests (a task title) carry none. */
export function responsesDescribe(body) {
  const thread = body?.client_metadata?.thread_id;
  return { thread: typeof thread === "string" ? thread : null, tools: Array.isArray(body?.tools) ? body.tools.length : 0,
    structuredOutput: body?.text?.format?.type === "json_schema" };
}

/** A value of the schema's shape: strings "stand-in", numbers 0, booleans false, every required property present. */
export function sampleOf(schema) {
  if (schema?.type === "object") {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sampleOf(value)]));
  }
  if (schema?.type === "array") return [];
  if (schema?.type === "number" || schema?.type === "integer") return 0;
  if (schema?.type === "boolean") return false;
  return "stand-in";
}

/** With no rule for it, a request for a JSON-schema answer (Codex's task title) gets one of that shape, so the program
 *  isn't shown an answer it can't parse. */
function responsesFallback(_turn, body) {
  if (body?.text?.format?.type !== "json_schema") return null;
  return { index: null, rule: { say: JSON.stringify(sampleOf(body.text.format.schema)) } };
}

/** The main path is <base_url>/responses; a base_url ending in /v1 is the common form. */
export const responsesProtocol = { path: "/v1/responses", turnOf: responsesTurnOf, userTurns: responsesUserTurns, describe: responsesDescribe,
  fallback: responsesFallback, answer };

/** Start the Codex stand-in; see core.mjs for the options and the script format. */
export function startResponsesStandIn(options) {
  return startStandIn(responsesProtocol, options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await runCli(startResponsesStandIn);
