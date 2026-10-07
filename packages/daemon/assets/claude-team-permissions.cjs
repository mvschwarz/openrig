"use strict";

// Session-only Claude PreToolUse helper. The launcher supplies the existing team
// lists; this file never reads or writes a person's permission settings.
// This is command convenience, not containment (test runners can execute code).
const { basename } = require("node:path");

function scanQuotes(text, keepDouble = false, initial = "") {
  let out = "", state = initial, start = 0;
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
    if (c === "\\") { out += c + (text[i + 1] || ""); i++; continue; }
    if (c === "'" || c === '"') { state = c; start = i; out += c; continue; }
    out += c;
  }
  if (state) spans.push([start, text.length]);
  return { text: out, spans, state };
}

// Split heredoc bodies off the command text. Quoted delimiters ('EOF', "EOF") make a literal body that never runs;
// an unquoted delimiter's body still expands substitutions, so it is returned for substitution checks only.
// A heredoc whose closing line is missing is left in place, so a misread `<<` can't hide later commands.
function splitHeredocs(cmd) {
  const lines = cmd.split("\n");
  const main = [];
  const expanding = [];
  // Quote state carries across lines: a double-quoted commit message can span several lines, and a `<<` after its
  // closing quote is still an operator. Heredoc bodies are skipped, so they never change the state.
  let carry = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    main.push(line);
    // A `<<` inside a quoted string isn't an operator.
    const scanned = scanQuotes(line, false, carry);
    const { spans } = scanned;
    carry = scanned.state;
    const found = [...line.matchAll(/(?<!<)<<(-?)(?!<)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g)]
      .filter(m => !spans.some(([a, b]) => m.index > a && m.index < b));
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
function words(command) {
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
    } else if (c === "#" && !started) {
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

function normalize(tokens) {
  const result = [...tokens];
  while (result.length) {
    const first = result[0];
    if (first.assignment) result.shift();
    else if (first.literal && ["env", "command", "exec"].includes(basename(first.value))) {
      result.shift();
      if (result[0]?.value === "--") result.shift();
      // Other wrapper options (including sudo) stay with native checks.
    } else break;
  }
  if (!result[0]?.literal) return [];
  const executable = result[0].value;
  result[0] = { value: basename(executable), literal: true };
  if (/\/(?:node_modules\/\.bin)\/(vitest|jest)$/.test(executable)) {
    result.unshift({ value: "npx", literal: true });
  }
  if (result[0].value === "rig") {
    // Host selection does not change the lifecycle being requested.
    while (result[1]?.literal && /^--host(?:=|$)/.test(result[1].value)) {
      if (result[1].value === "--host") {
        if (!result[2]) return [];
        result.splice(1, 2);
      } else result.splice(1, 1);
    }
  }
  return result;
}

function matches(tokens, prefix) {
  return prefix.every((part, i) => tokens[i]?.literal && tokens[i].value === part);
}

function prefixes(rules) {
  return rules.flatMap(rule => {
    const match = /^Bash\((.+):\*\)$/.exec(rule);
    return match ? [match[1].split(" ")] : [];
  });
}

function helpOnly(tokens, prefix) {
  const args = tokens.slice(prefix.length);
  // A help-looking option value or text after -- is not a help invocation.
  // Recognize the common literal help form, optionally after positional args.
  return args.length > 0 && args.every(t => t.literal)
    && ["--help", "-h"].includes(args.at(-1).value)
    && args.slice(0, -1).every(t => !t.value.startsWith("-"));
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
  const parsed = words(main.trim());
  const commands = parsed.commands.map(normalize);
  const asks = prefixes(policy.ask);
  for (const tokens of commands) {
    const lifecycle = asks.find(prefix => matches(tokens, prefix));
    if (lifecycle && !helpOnly(tokens, lifecycle)) return "ask";
  }
  if (!parsed.simple || commands[0]?.some(t => !t.literal)) return undefined;
  return prefixes(policy.allow).some(prefix => matches(commands[0] || [], prefix)) ? "allow" : undefined;
}

module.exports = { decide };
if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw);
      if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return;
      const policy = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
      const decision = decide(input.tool_input.command, policy);
      if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: decision,
        permissionDecisionReason: decision === "ask"
          ? "This rig lifecycle command needs confirmation. Use --help or -h to read its help."
          : "This command matches the OpenRig team launch allowance.",
      } }));
    } catch { /* No decision: retain Claude's own permission handling. */ }
  });
}
