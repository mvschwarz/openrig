"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// One issue per failure episode, after three unsuccessful attempts. Retrying an
// uncertain stream write uses the same id; a successful delivery starts afresh.
function recordRefocusResult({ home, seat, identity, failed }) {
  if (!seat || !identity) return;
  const key = crypto.createHash("sha256").update(JSON.stringify([seat, identity])).digest("hex");
  const file = path.join(home, "refocus", `${key}.health.json`);
  try {
    let state;
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { state = {}; }
    if (!failed && !state.failures) return;
    state = failed
      ? { ...state, failures: Number(state.failures || 0) + 1, issueId: state.issueId || `refocus-${crypto.randomUUID()}` }
      : { failures: 0 };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Persist the id before contacting the daemon, including timeout/unknown outcomes.
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    if (state.failures < 3 || state.reportedAt) return;
    const result = spawnSync("rig", [
      "stream", "emit", "--source", seat, "--id", state.issueId,
      "--hint-type", "issue", "--hint-tags", "issue,refocus",
      "--body", `Refocus failed on ${state.failures} consecutive attempts for ${seat}. Orientation remains unverified; inspect this seat's refocus hook diagnostics.`,
      "--json",
    ], { encoding: "utf8", timeout: Math.max(1, Math.min(1_500, 4_500 - Math.floor(process.uptime() * 1_000))), maxBuffer: 64 * 1024, env: process.env });
    if (!result.error && result.status === 0) {
      state.reportedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    } else {
      process.stderr.write("refocus: issue-stream report unconfirmed; retained for the next failed attempt\n");
    }
  } catch (error) {
    process.stderr.write(`refocus: failure accounting unavailable: ${error.message}\n`);
  }
}

module.exports = { recordRefocusResult };
