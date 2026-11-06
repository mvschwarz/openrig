// A connector whose turn ends before the CLI that started it first looks: it records a completed outcome in one write.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runId = process.argv[2]!;
const file = join(process.env.OPENRIG_HOME!, "acp", "runs", `${runId}.json`);
const run = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const at = new Date().toISOString();
writeFileSync(`${file}.instant`, JSON.stringify({ ...run, state: "finished", pid: process.pid, startedAt: at, endedAt: at, outcome: "completed", summary: "the agent ended its turn (end_turn)" }));
renameSync(`${file}.instant`, file);
