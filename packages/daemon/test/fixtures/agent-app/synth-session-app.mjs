#!/usr/bin/env node
// A synthetic agent app for the agent-app session tests. It behaves like OpenCode 1.x and 2.0 where OpenRig depends on it:
//   synth-session-app [--session <id>]            interactive seat; a session is saved only after the first input line
//   synth-session-app session list --format json  JSON array of {id, created, updated, directory}, newest first
//   synth-session-app export <id>                 exit 0 when the session exists, 1 when it doesn't
// State lives in $SYNTH_APP_HOME, or $HOME/.synth-session-app when that isn't set: one JSON file per session.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

const home = process.env.SYNTH_APP_HOME || join(homedir(), ".synth-session-app");
const dir = join(home, "sessions");
mkdirSync(dir, { recursive: true });
const file = (id) => join(dir, `${id}.json`);
const args = process.argv.slice(2);

if (args[0] === "session" && args[1] === "list") {
  if (args[2] !== "--format" || args[3] !== "json") { console.error("usage: session list --format json"); process.exit(2); }
  const rows = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
  rows.sort((a, b) => b.updated - a.updated);
  process.stdout.write(JSON.stringify(rows.map(({ id, created, updated, directory }) => ({ id, created, updated, directory })), null, 2) + "\n");
  process.exit(0);
}
if (args[0] === "export") {
  const id = args[1] ?? "";
  if (!/^ses_[A-Za-z0-9]{8,40}$/.test(id) || !existsSync(file(id))) { console.log(`Session not found: ${id}`); process.exit(1); }
  process.stdout.write(readFileSync(file(id), "utf-8") + "\n");
  process.exit(0);
}

let id = null;
if (args[0] === "--session") {
  id = args[1] ?? "";
  if (!existsSync(file(id))) { console.log(`Error: Session not found: ${id}`); process.exit(1); }
} else if (args.length > 0) {
  console.error(`synth-session-app: unrecognized arguments: ${args.join(" ")}`); process.exit(2);
}
const save = (line) => {
  const now = Date.now();
  if (!id) id = `ses_${randomBytes(9).toString("hex")}`;
  const prev = existsSync(file(id)) ? JSON.parse(readFileSync(file(id), "utf-8")) : { id, created: now, directory: process.cwd(), lines: [] };
  prev.updated = now; prev.lines.push(line);
  writeFileSync(file(id), JSON.stringify(prev));
};
console.log(id ? `synth ready: resumed ${id}` : "synth ready: new session");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => { save(line); console.log(`synth heard (${id}): ${line}`); });
