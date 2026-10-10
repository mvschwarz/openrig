// A deterministic editable terminal, not a provider emulator. It consumes real
// bracketed paste/Enter bytes so the native test can count actual submissions.
import { writeFileSync, renameSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import stringWidth from "string-width";

const [runtime, stateFile] = process.argv.slice(2);
let input = "", pending = "", pasting = false, cursor = 0, ghost = false;
const submissions = [];
const decoder = new StringDecoder("utf8");

function render() {
  const rows = ["Editable delivery fixture", ...submissions.slice(-3).flatMap(text => text.split("\n"))];
  if (runtime === "claude") rows.push("────────────────────────────────────────");
  const start = rows.length;
  const displayed = ghost && cursor === input.length ? `${input}\x1b[2m suggested follow-up\x1b[22m`
    : input || (runtime === "codex" ? "\x1b[2mAsk Codex to do anything\x1b[22m" : "");
  const body = displayed.split("\n");
  rows.push(`${runtime === "claude" ? "❯\u00a0" : "› "}${body[0]}`, ...body.slice(1).map(line => `  ${line}`));
  rows.push(...(runtime === "claude" ? ["────────────────────────────────────────", "? for shortcuts"] : ["", "fixture · 90% context left"]));
  if (runtime === "claude" && ghost) {
    rows[rows.length - 1] = "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
    rows.push("✘ Auto-update failed: no write permission to npm prefix · Run claude doctor");
  }
  const beforeCursor = input.slice(0, cursor).split("\n");
  process.stdout.write(`\x1b[2J\x1b[H${rows.join("\r\n")}\x1b[${start + beforeCursor.length};${3 + stringWidth(beforeCursor.at(-1))}H`);
  writeFileSync(`${stateFile}.tmp`, JSON.stringify({ input, submissions }));
  renameSync(`${stateFile}.tmp`, stateFile);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", data => {
  pending += decoder.write(data);
  while (pending.length) {
    if (pending.startsWith("\x1b[200~")) { pasting = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { pasting = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\x1b" && pending.length < 6) break;
    const char = pending[0]; pending = pending.slice(1);
    if (pasting || char >= " ") {
      if (!pasting && char === "\x7f") {
        if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor--; }
      } else { input = input.slice(0, cursor) + (char === "\r" ? "\n" : char) + input.slice(cursor); cursor++; }
    } else if (char === "\r" || char === "\n") { submissions.push(input); input = ""; cursor = 0; }
    else if (char === "\x15") { input = ""; cursor = 0; }
    else if (char === "\x01") cursor = 0;
    else if (char === "\x05") cursor = input.length;
    else if (char === "\x14") ghost = !ghost;
  }
  render();
});
render();
