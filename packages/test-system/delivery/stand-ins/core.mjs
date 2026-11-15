// The shared half of the delivery suite's stand-in model servers: the per-turn script, the request log and the HTTP
// scaffold. A stand-in answers a real Claude Code or Codex TUI the way a model service would, from a script, so a case
// can drive the real program with no account, no login and no spend. Only the wire format differs per program
// (messages.mjs, responses.mjs); everything a case decides lives in its script.
//
// What a stand-in proves is narrow: which requests the program sent, in what order, with what bytes. That request log is
// the receiver-side record a case joins to OpenRig's own delivery record. It never proves a model's behaviour.
//
// The log keeps each request's parsed body and the raw body's size and sha256, so it's knowingly sensitive: point a
// stand-in only at synthetic fixtures.
// It listens on loopback only, and keeps header and query values only from a short list of safe names.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

/** A correlation marker a case puts in the text it delivers, such as `DLV-D01-3f2a`. */
export const DEFAULT_MARKER = "DLV-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

/**
 * A script is the stand-in's whole behaviour:
 *
 *   { "marker"?: "<regex source>",            // what counts as a correlation marker; DEFAULT_MARKER otherwise
 *     "rules": [ {
 *       "on"?: "user" | "tool_result" | "any", // what the request's last turn must be (default "user")
 *       "when"?: "<regex source>",            // matched against that turn's text; absent matches any
 *       "times"?: <n>,                        // how many requests this rule answers; absent is unlimited
 *       "gate"?: "<name>",                    // hold the answer until the case releases this gate
 *       "delayMs"?: <n>,                      // wait before the first byte
 *       // then exactly one action:
 *       "say"?: "<text>",                     // a streamed text reply; {{marker}} is the turn's first marker
 *       "chunks"?: <n>, "chunkDelayMs"?: <n>, //   split into n deltas with a pause between them (a long turn)
 *       "tool"?: { "name": "<tool>", "input": { ... } },  // a tool call, in this program's own tool shape
 *       "error"?: { "status": <n>, "headers"?: { ... }, "body"?: <json> },  // an HTTP error answer
 *       "failInStream"?: { "type"?: "<type>", "code"?: "<code>", "message": "<text>" }  // fail after streaming starts
 *     } ] }
 *
 * The first rule that fits answers. With none, a user turn gets "ok {{marker}}" and a tool result gets "done".
 */
export function loadScript(source) {
  const script = typeof source === "string" ? JSON.parse(readFileSync(source, "utf8")) : (source ?? {});
  // A script with no rules answers everything with the fallback; one whose rules aren't a list is a mistake, not that.
  if (script.rules !== undefined && !Array.isArray(script.rules)) throw new Error("stand-in script: rules must be a list");
  const rules = script.rules ?? [];
  // Every pattern is compiled here, so a bad one fails the script at load rather than a request mid-case.
  const when = rules.map((rule, index) => {
    if (!rule || typeof rule !== "object") throw new Error(`stand-in script rule ${index}: must be an object`);
    const actions = ["say", "tool", "error", "failInStream"].filter((key) => rule[key] !== undefined);
    if (actions.length !== 1) throw new Error(`stand-in script rule ${index}: needs exactly one of say, tool, error, failInStream (has ${actions.join(", ") || "none"})`);
    if (rule.on !== undefined && !["user", "tool_result", "any"].includes(rule.on)) throw new Error(`stand-in script rule ${index}: on must be user, tool_result or any`);
    if (rule.when === undefined) return null;
    try { return new RegExp(rule.when); } catch (error) { throw new Error(`stand-in script rule ${index}: when isn't a valid pattern (${error.message})`); }
  });
  let marker;
  try { marker = new RegExp(script.marker ?? DEFAULT_MARKER); } catch (error) { throw new Error(`stand-in script: marker isn't a valid pattern (${error.message})`); }
  return { marker, rules, when };
}

/** The rule that answers a turn, consuming one of its `times`; null when none fits. */
export function selectRule(script, used, turn) {
  for (const [index, rule] of script.rules.entries()) {
    const on = rule.on ?? "user";
    if (on !== "any" && on !== turn.kind) continue;
    if (script.when[index] && !script.when[index].test(turn.text)) continue;
    if (rule.times !== undefined && (used.get(index) ?? 0) >= rule.times) continue;
    used.set(index, (used.get(index) ?? 0) + 1);
    return { index, rule };
  }
  return null;
}

export function fallbackRule(turn) {
  return { index: null, rule: turn.kind === "tool_result" ? { say: "done" } : { say: "ok {{marker}}" } };
}

export function fillMarker(text, marker) {
  return text.replaceAll("{{marker}}", marker ?? "(no marker)");
}

/** Text split into `n` near-equal pieces, never empty ones. */
export function splitChunks(text, n = 1) {
  const count = Math.max(1, Math.min(n, text.length || 1));
  const size = Math.ceil(text.length / count);
  const pieces = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces.length > 0 ? pieces : [""];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Header and query values the log may keep. Every other value, which may be a credential a provider is configured to
// send under any name (Codex's http_headers, env_http_headers, query_params), is logged as "(present)".
// Ids and a retry count are kept too: they tell a case which conversation a request belongs to and whether it's a retry,
// and none of them is a credential.
const SAFE_HEADER_VALUES = new Set(["content-type", "accept", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta",
  "x-stainless-retry-count", "x-claude-code-session-id", "session-id", "thread-id"]);
const SAFE_QUERY_VALUES = new Set(["beta"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function loggedHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SAFE_HEADER_VALUES.has(name) ? value : "(present)"]));
}

function loggedQuery(params) {
  return Object.fromEntries([...params.keys()].map((name) => [name, SAFE_QUERY_VALUES.has(name) ? params.getAll(name).join(",") : "(present)"]));
}

/**
 * Start a stand-in. `protocol` supplies the program's wire format:
 *   turnOf(body) -> { kind: "user" | "tool_result" | "other", text, parts: { text, source: "text" | "tool_result" }[] }
 *     parts are the last turn's separate pieces as the program sent them: each text block (typed text, context the
 *     program adds, or a second message merged into the turn) and each tool result. A turn holding any tool result is
 *     kind "tool_result", and its text parts are kept beside it: a message typed during a tool run can arrive there.
 *   userTurns(body) -> number   how many user turns the request's history holds, tool results aside
 *   answer(ctx) -> Promise<void>   writes the response for the chosen rule
 *   other(req, res, body) -> boolean   serves a path the protocol knows besides its main one (count_tokens, a probe)
 *   describe(body) -> { thread, tools, structuredOutput }   which conversation the request belongs to (null when it
 *     names none), how many tools it offers, and whether it asks for a JSON-schema answer. A program's side requests
 *     (Codex's task title, for one) quote the delivered text too, so a case counts a delivery only in the seat's thread.
 *   fallback(turn, body) -> rule | null   the protocol's own answer when no rule fits, before the generic one
 *   path: the main POST path, e.g. "/v1/messages"
 * Control routes for the harness, under /_stand-in/: GET requests (the log so far), GET errors (what failed inside the
 * stand-in, such as a log write), POST release/<gate>.
 */
export async function startStandIn(protocol, { script, logPath, port = 0, host = "127.0.0.1" } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`stand-in listens on loopback only (127.0.0.1, ::1 or localhost), not ${host}`);
  const loaded = loadScript(script);
  const used = new Map();
  const requests = [];
  // What went wrong inside the stand-in itself, such as a log it couldn't write. A case reads these: a request missing
  // from the log is then the stand-in's failure, not the program's.
  const errors = [];
  const gates = new Map();
  let seq = 0;

  const log = (entry) => {
    requests.push(entry);
    if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
  const waitGate = (name) => {
    const gate = gates.get(name) ?? { released: false, waiters: [] };
    gates.set(name, gate);
    return gate.released ? Promise.resolve() : new Promise((resolve) => gate.waiters.push(resolve));
  };
  const release = (name) => {
    const gate = gates.get(name) ?? { released: false, waiters: [] };
    gate.released = true;
    gate.waiters.splice(0).forEach((resolve) => resolve());
    gates.set(name, gate);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      // The path and the query's names only, as the request log keeps them: a query value can be a credential.
      const url = new URL(req.url ?? "/", "http://stand-in");
      const where = { path: url.pathname, query: loggedQuery(url.searchParams) };
      errors.push({ at: new Date().toISOString(), method: req.method, ...where, message: String(error?.message ?? error) });
      process.stderr.write(`stand-in: ${req.method} ${where.path}: ${error?.message ?? error}\n`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "stand_in_error", message: String(error?.message ?? error) } }));
      else res.end();
    });
  });

  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://stand-in");
    const rawBody = Buffer.concat(chunks);
    // The request body's bytes as received, so a case can tie the parsed body below to the wire.
    const entry = { seq: ++seq, at: new Date().toISOString(), method: req.method, path: url.pathname, query: loggedQuery(url.searchParams),
      headers: loggedHeaders(req.headers), rawBytes: rawBody.length, rawSha256: createHash("sha256").update(rawBody).digest("hex") };

    if (url.pathname === "/_stand-in/requests" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests));
      return;
    }
    if (url.pathname === "/_stand-in/errors" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(errors));
      return;
    }
    if (url.pathname.startsWith("/_stand-in/release/") && req.method === "POST") {
      release(decodeURIComponent(url.pathname.slice("/_stand-in/release/".length)));
      res.writeHead(204).end();
      return;
    }

    let body = null;
    let malformed = false;
    try { body = raw ? JSON.parse(raw) : null; } catch { malformed = true; }
    if (req.method !== "POST" || url.pathname !== protocol.path) {
      const served = protocol.other?.(req, res, body, url) ?? false;
      log({ ...entry, body: body ?? (raw || null), served: served ? "other" : "not-found" });
      if (!served) res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "not_found", message: `stand-in serves ${protocol.path}` } }));
      return;
    }

    // A request the program sent that isn't JSON gets an error, never a scripted reply a case could mistake for a turn.
    if (malformed || body === null) {
      log({ ...entry, body: raw || null, served: "malformed" });
      res.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { type: "invalid_request_error", message: "stand-in: the request body isn't JSON" } }));
      return;
    }

    const turn = protocol.turnOf(body);
    const picked = selectRule(loaded, used, turn) ?? protocol.fallback?.(turn, body) ?? fallbackRule(turn);
    const marker = turn.text.match(loaded.marker)?.[0] ?? null;
    log({ ...entry, body, request: protocol.describe?.(body) ?? null, turn: describeTurn(turn, loaded.marker), userTurns: protocol.userTurns(body), marker, rule: picked.index,
      action: Object.keys(picked.rule).find((k) => ["say", "tool", "error", "failInStream"].includes(k)) });
    if (picked.rule.gate) await waitGate(picked.rule.gate);
    if (picked.rule.delayMs) await sleep(picked.rule.delayMs);
    if (picked.rule.error) {
      res.writeHead(picked.rule.error.status, { "content-type": "application/json", ...(picked.rule.error.headers ?? {}) })
        .end(JSON.stringify(picked.rule.error.body ?? {}));
      return;
    }
    try {
      await protocol.answer({ req, res, body, rule: picked.rule, marker, stream: body?.stream === true, sleep });
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
      else res.end();
    }
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  // An IPv6 host is bracketed in a URL.
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url,
    port: address.port,
    requests: () => [...requests],
    errors: () => [...errors],
    release,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** A turn as the log keeps it: each part's decoded text exactly, with its source, UTF-8 byte length, sha256 and the
 *  markers it holds, so a case can tell one intact message from a merge of two or a message split across turns. */
export function describeTurn(turn, marker) {
  const global = new RegExp(marker.source, "g");
  return { kind: turn.kind, text: turn.text, parts: (turn.parts ?? []).map(({ text, source }) => ({ text, source,
    bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex"), markers: text.match(global) ?? [] })) };
}

/** Write one server-sent event. */
export function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The command-line form both stand-ins share: `--script <file> [--log <file>] [--port <n>] [--host <addr>]`. Prints
 *  `READY <url>` once listening, so a harness can wait for that line. */
export async function runCli(start, argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!["script", "log", "port", "host"].includes(key ?? "")) throw new Error(`unknown option ${argv[i]}`);
    opts[key] = argv[i + 1];
  }
  const standIn = await start({ script: opts.script, logPath: opts.log, port: opts.port ? Number(opts.port) : 0, host: opts.host ?? "127.0.0.1" });
  process.stdout.write(`READY ${standIn.url}\n`);
  const stop = () => standIn.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
