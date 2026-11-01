"use strict";

// Session-only Claude PreToolUse helper. The launcher supplies the kernel or team
// lists; this file never reads or writes a person's permission settings.
// This is command convenience, not containment (test runners can execute code).
const { basename, isAbsolute } = require("node:path");

function scanQuotes(text, keepDouble = false, initial = "", arithmetic = 0) {
  let out = "", state = initial, start = 0, arithmeticStart = 0, wordStarted = Boolean(initial);
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === "'") { if (c === "'") { state = ""; spans.push([start, i]); out += "'"; } continue; }
    if (state === '"') {
      if (c === "\\") { if (keepDouble) out += c + (text[i + 1] || ""); i++; continue; }
      if (c === '"') { state = ""; spans.push([start, i]); out += '"'; continue; }
      if (keepDouble) out += c;
      continue;
    }
    if (c === "\\") { out += c + (text[i + 1] || ""); i++; wordStarted = true; continue; }
    if (c === "'" || c === '"') { state = c; start = i; out += c; wordStarted = true; continue; }
    if (arithmetic) {
      if (c === "(") arithmetic++;
      if (c === ")" && --arithmetic === 0) spans.push([arithmeticStart, i]);
      out += c;
      continue;
    }
    if (c === "#" && !wordStarted) {
      const end = text.indexOf("\n", i);
      spans.push([i, end === -1 ? text.length : end]);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (c === "(" && text[i + 1] === "(") {
      arithmetic = 2; arithmeticStart = i; out += "(("; i++; continue;
    }
    wordStarted = !/[\s;&|()<>]/.test(c);
    out += c;
  }
  if (state) spans.push([start, text.length]);
  if (arithmetic) spans.push([arithmeticStart, text.length]);
  return { text: out, spans, state, arithmetic };
}

// Split heredoc bodies off the command text. Quoted delimiters ('EOF', "EOF") make a literal body that never runs;
// an unquoted delimiter's body still expands substitutions, so it is returned for substitution checks only.
// Only operators outside quotes, comments and arithmetic can start a heredoc.
// A missing closing delimiter leaves the remaining text in place for conservative ask detection.
function splitHeredocs(cmd) {
  const lines = cmd.split("\n");
  const main = [];
  const expanding = [];
  // Quote state carries across lines: a double-quoted commit message can span several lines, and a `<<` after its
  // closing quote is still an operator. Heredoc bodies are skipped, so they never change the state.
  let carry = "", arithmetic = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    main.push(line);
    const scanned = scanQuotes(line, false, carry, arithmetic);
    const { spans } = scanned;
    carry = scanned.state;
    arithmetic = scanned.arithmetic;
    const found = [...line.matchAll(/(?<!<)<<(-?)(?!<)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g)]
      .filter(m => !spans.some(([a, b]) => m.index >= a && m.index <= b));
    let j = i;
    for (const m of found) {
      const delim = m[2] || m[3] || m[4];
      const quoted = Boolean(m[2] || m[3] || m[0].includes("\\"));
      const end = lines.findIndex((l, k) => k > j && (m[1] ? l.replace(/^\t+/, "") : l) === delim);
      if (end === -1) continue;
      const body = lines.slice(j + 1, end).join("\n");
      if (!quoted) expanding.push(body);
      j = end;
    }
    i = j;
  }
  return { main: main.join("\n"), expanding };
}

// Bodies of $( ... ) (balanced) and `...`; the text must already have single-quoted strings removed.
function substitutions(text) {
  const out = [];
  const t = text.replace(/\\[`$]/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "$" && t[i + 1] === "(") {
      let depth = 1, k = i + 2;
      for (; k < t.length && depth; k++) { if (t[k] === "(") depth++; else if (t[k] === ")") depth--; }
      out.push(t.slice(i + 2, depth ? k : k - 1));
      i = k - 1;
    } else if (t[i] === "`") {
      const k = t.indexOf("`", i + 1);
      if (k === -1) { out.push(t.slice(i + 1)); break; }
      out.push(t.slice(i + 1, k));
      i = k;
    }
  }
  return out;
}

// Decode literal shell words without executing anything. Keep command boundaries
// for lifecycle asks, but never allow an entire compound/expanding command.
function words(command, comments = true) {
  const commands = [];
  let tokens = [], word = "", started = false, literal = true, quote = "", simple = true, rawWord = "";
  const flush = () => {
    if (started) tokens.push({ value: word, literal, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(rawWord) });
    word = ""; rawWord = ""; started = false; literal = true;
  };
  const boundary = () => { flush(); if (tokens.length) commands.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote || !/\s/.test(c)) rawWord += c;
    if (quote === "'") {
      if (c === "'") quote = ""; else word += c;
    } else if (c === "\\" && quote !== "'") {
      const next = command[++i];
      if (next === undefined) { simple = false; literal = false; break; }
      if (next !== "\n") word += quote === '"' && !'$`"\\'.includes(next) ? "\\" + next : next;
      started = true;
    } else if (quote === '"') {
      if (c === '"') quote = "";
      else { word += c; if (c === "$" || c === "`") { literal = false; simple = false; } }
    } else if (c === "'" || c === '"') {
      quote = c; started = true;
    } else if (comments && c === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (";&|\n()<>".includes(c)) {
      boundary(); simple = false;
    } else if (/\s/.test(c)) flush();
    else {
      started = true; word += c;
      if ("$`*?[]{}~".includes(c)) { literal = false; simple = false; }
    }
  }
  if (quote) { literal = false; simple = false; }
  boundary();
  return { commands, simple: simple && commands.length === 1 };
}

function normalize(tokens, forAllow = false) {
  const result = [...tokens];
  while (result.length) {
    const first = result[0];
    if (first.assignment) {
      // These can change the executable or inject startup code. Ask detection
      // still looks through them; an allowance leaves them to native checks.
      if (forAllow && /^(?:PATH|LD_[A-Za-z0-9_]*|DYLD_[A-Za-z0-9_]*|NODE_OPTIONS|BASH_ENV|ENV)=/.test(first.value)) return [];
      result.shift();
    }
    else if (first.literal && ["env", "command", "exec"].includes(basename(first.value))) {
      if (forAllow && first.value.includes("/") && !isAbsolute(first.value)) return [];
      // command -v/-V inspects an executable rather than wrapping its execution.
      if (basename(first.value) === "command" && ["-v", "-V"].includes(result[1]?.value)) break;
      result.shift();
      if (result[0]?.value === "--") result.shift();
      // Other wrapper options (including sudo) stay with native checks.
    } else break;
  }
  if (!result[0]?.literal) return [];
  const executable = result[0].value;
  if (forAllow && executable.includes("/") && !isAbsolute(executable)) return [];
  result[0] = { value: basename(executable), literal: true };
  if (/\/(?:node_modules\/\.bin)\/(vitest|jest)$/.test(executable)) {
    result.unshift({ value: "npx", literal: true });
  }
  if (result[0].value === "rig") {
    // Host selection does not change the lifecycle being requested.
    while (result[1]?.literal && /^--host(?:=|$)/.test(result[1].value)) {
      if (result[1].value === "--host") {
        if (!result[2] || (forAllow && !result[2].literal)) return [];
        result.splice(1, 2);
      } else result.splice(1, 1);
    }
  }
  return result;
}

function prefixEnd(tokens, prefix) {
  let i = 0;
  for (const part of prefix) {
    // Commander accepts separators before a subcommand, including at root.
    // A separator AFTER the lifecycle prefix still terminates help options.
    while (prefix[0] === "rig" && i > 0 && tokens[i]?.literal && tokens[i].value === "--") i++;
    if (!tokens[i]?.literal || tokens[i].value !== part) return undefined;
    i++;
  }
  return i;
}

function prefixes(rules) {
  return rules.flatMap(rule => {
    const match = /^Bash\((.+):\*\)$/.exec(rule);
    return match ? [match[1].split(" ")] : [];
  });
}

function helpOnly(tokens, prefixLength) {
  // A separator before a subcommand also makes its remaining words operands.
  // For example, the CLI dispatches `rig -- down --help` on a rig named --help.
  if (tokens.slice(1, prefixLength).some(t => t.value === "--")) return false;
  const args = tokens.slice(prefixLength);
  // A help-looking option value or text after -- is not a help invocation.
  // Commander also accepts help before positional arguments.
  const help = args.findIndex(t => ["--help", "-h"].includes(t.value));
  return help !== -1 && args.every(t => t.literal)
    && args.slice(0, help).every(t => !t.value.startsWith("-"));
}

function decide(command, policy, depth = 0) {
  if (depth > 4) return undefined;
  const { main, expanding } = splitHeredocs(command);
  // Substitutions in double quotes and unquoted heredocs still execute. Literal
  // multiline strings and quoted heredocs are data, not lifecycle invocations.
  for (const source of [scanQuotes(main, true).text, ...expanding]) {
    for (const inner of substitutions(source)) {
      if (decide(inner, policy, depth + 1) === "ask") return "ask";
    }
  }
  if (findAsk(main, policy)) return "ask";
  const parsed = words(main.trim());
  const tokens = normalize(parsed.commands[0] || [], true);
  if (!parsed.simple || tokens.some(t => !t.literal)) return undefined;
  return prefixes(policy.allow).some(prefix => prefixEnd(tokens, prefix) !== undefined) ? "allow" : undefined;
}

// The ask scan decide() runs over a parsed command, factored out so the error
// fallback below can reuse the exact same tokenization, prefix and help
// logic instead of a second, cruder matcher.
function findAsk(text, policy) {
  const parsed = words(text.trim());
  const asks = prefixes(policy.ask);
  const askExecutables = new Set(asks.map(prefix => prefix[0]));
  // Retain comment text for asks too: a # inside backticks or ${...} must not
  // hide a later command. Keep the comment-aware scan as well, so quotes in a
  // real comment cannot swallow the following line. Allow parsing is unchanged.
  for (const command of [...parsed.commands, ...words(text.trim(), false).commands]) {
    // ponytail: ask conservatively at every word position rather than owning a
    // second shell grammar for wrappers/control flow. Unquoted prose may ask;
    // quoted messages remain single words, and literal heredoc bodies are gone.
    for (let i = 0; i < command.length; i++) {
      if (!command[i].literal || !askExecutables.has(basename(command[i].value))) continue;
      const tokens = normalize(command.slice(i));
      for (const prefix of asks) {
        const end = prefixEnd(tokens, prefix);
        if (end !== undefined && !helpOnly(tokens, end)) return true;
      }
    }
  }
  return false;
}

// Ask-only fallback for a command decide() could not judge: never emits
// "allow" — a repaired or unparseable parse is trusted only to ask. Total:
// any throw inside the scan degrades to no decision, never a crash.
function conservativeAsk(command, policy) {
  try {
    if (decide(command, policy) === "ask") return "ask";
  } catch { /* the words-level scan below reuses the same helpers */ }
  try {
    // Scan only the heredoc-stripped text, as decide() does: a quoted
    // heredoc body is data, never a command that can execute.
    return findAsk(splitHeredocs(command).main, policy) ? "ask" : undefined;
  } catch {
    return undefined;
  }
}

// Recover the command string from input that failed JSON.parse (a truncated
// stream still holds the complete command when its closing quote survived).
// Only the string is recovered here; whether it requests a lifecycle action
// is decided by decide()/findAsk as usual — never by this scan.
function extractCommandText(raw) {
  const match = /"command"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return undefined;
  }
}

// Index of the `"name"` key token in raw JSON-ish text, or -1. Only a
// string followed by `:` counts as a key, so the same text inside a field
// value — `"agent_type": "command"` — never matches. An unterminated
// string (a truncated payload) swallows the rest, so nothing inside it
// counts either. Key text is JSON-decoded, as the recovered values below.
function structuralKeyIndex(raw, name) {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '"') continue;
    let j = i + 1;
    while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
    if (j >= raw.length) return -1;
    let decoded;
    try { decoded = JSON.parse(raw.slice(i, j + 1)); } catch { decoded = undefined; }
    let k = j + 1;
    while (k < raw.length && /\s/.test(raw[k])) k++;
    if (raw[k] === ":" && decoded === name) return i;
    i = j;
  }
  return -1;
}

// Recover the tool name the same way, so the unparseable path applies the
// same Bash-only check as the parsed path below. A name that cannot be
// recovered is not Bash: the hook stays silent and Claude's own permission
// handling applies, as for any other non-Bash input. Only a name ahead of
// the tool_input region counts: a "tool_name":"Bash" fragment after the
// command — inside a later field, or a key ordered after tool_input — is
// data, not the payload's tool identity. tool_name precedes tool_input in
// hook payloads, so bounding the scan there loses no legitimate recovery;
// anchoring to the payload's first key instead would, since real payloads
// carry session_id/cwd/hook_event_name ahead of tool_name. The bounds are
// structural keys, so the same text inside a field value (e.g. an
// agent_type of "command") cannot cut the scan short of the real name.
function extractToolName(raw) {
  const inputAt = structuralKeyIndex(raw, "tool_input");
  const commandAt = structuralKeyIndex(raw, "command");
  const bounds = [inputAt, commandAt].filter((at) => at !== -1);
  const scope = bounds.length === 0 ? raw : raw.slice(0, Math.min(...bounds));
  const match = /"tool_name"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(scope);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return undefined;
  }
}

module.exports = { decide };
if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    const emit = (decision) => {
      try {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision: decision,
          permissionDecisionReason: decision === "ask"
            ? "This rig lifecycle command needs confirmation. Use --help or -h to read its help."
            : "This command matches the OpenRig session launch allowance.",
        } }));
      } catch { /* No decision: retain Claude's own permission handling. */ }
    };
    // No ask list, no identifiable lifecycle intent: retain Claude's handling.
    let policy;
    try {
      policy = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
    } catch { return; }
    let input = null;
    try { input = JSON.parse(raw); } catch { /* recovered below */ }
    if (input !== null && typeof input === "object") {
      if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return;
      let decision;
      try { decision = decide(input.tool_input.command, policy); }
      catch { decision = conservativeAsk(input.tool_input.command, policy); }
      if (decision) emit(decision);
      return;
    }
    // Unparseable input: ask only when the recovered command identifiably
    // requests a lifecycle action. Anything else keeps current behavior
    // (no output), including a hook that never starts or times out, which
    // no code inside this file can intercept. Only Bash input reaches the
    // fallback at all, as in the parsed path above: tool_name precedes
    // tool_input in hook payloads, so a truncation that leaves a complete
    // command also leaves the tool name intact.
    if (extractToolName(raw) !== "Bash") return;
    const recovered = extractCommandText(raw);
    if (recovered === undefined) return;
    if (conservativeAsk(recovered, policy) === "ask") emit("ask");
  });
}
