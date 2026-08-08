#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function refuse(message) {
  throw new Error(`[gate-consume] REFUSED: ${message}`);
}

/** Honor one exact real-gate verdict, then remove it so it cannot be reused. */
export function consumeGateVerdict({ verdictPath, headSha, log = console.log }) {
  if (!existsSync(verdictPath)) refuse(`verdict is missing: ${verdictPath}`);
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  } catch (error) {
    refuse(`verdict is not valid JSON: ${error?.message ?? error}`);
  }
  if (typeof verdict?.candidateSha !== "string" || verdict.candidateSha.length === 0) {
    refuse("candidateSha is required");
  }
  if (verdict.candidateSha !== headSha) {
    refuse(`candidateSha does not match current HEAD (verdict=${verdict.candidateSha}, HEAD=${headSha})`);
  }
  if (verdict.gate !== "pass") refuse(`gate must be "pass" (received ${JSON.stringify(verdict.gate)})`);
  if (verdict.smoke !== false) refuse("smoke must be strictly false; only a real gate may be consumed");

  unlinkSync(verdictPath);
  if (existsSync(verdictPath)) refuse(`consumed verdict still exists after unlink: ${verdictPath}`);
  log(`[gate-consume] honored and consumed candidate ${headSha}; removed ${verdictPath}`);
  return verdict;
}

function readHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) refuse(`cannot derive current HEAD: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function main() {
  const root = process.cwd();
  const verdictPath = resolve(process.argv[2] ?? process.env.OPENRIG_GATE_VERDICT ?? join(root, "gate-lane-verdict.json"));
  consumeGateVerdict({ verdictPath, headSha: readHead(root) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
