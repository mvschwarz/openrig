// `rig config` and the daemon's settings store are one contract in two files: the CLI
// writes ~/.openrig/config.json, the daemon reads it, and the daemon store's own header
// says the two key lists are "kept in lockstep". Each list is pinned by its own package
// test, so nothing ever compared them — and two keys had already drifted:
// ui.terminal.max_live_terminals and retention.usage_samples_days were resolved by the
// daemon store and served by `GET /api/config`, while `rig config get|set` rejected both
// as "Unknown config key".
//
// This guard reads both lists as text, because packages/cli cannot import packages/daemon
// (neither package depends on the other — stated in source in three places). A future
// difference that is genuinely intended for one side only goes in
// INTENTIONAL_DIFFERENCES with the reason beside it; an empty list means the twins agree
// exactly.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI_STORE = "packages/cli/src/config-store.ts";
const DAEMON_STORE = "packages/daemon/src/domain/user-settings/settings-store.ts";

/** Keys a side may hold alone. Empty: the settable surfaces agree exactly. */
const INTENTIONAL_DIFFERENCES = [];

function listOf(file, name) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`export const ${name} = [`));
  assert.notEqual(start, -1, `${file}: could not find "export const ${name} = ["`);
  const keys = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\] as const;/.test(line.trim())) return keys;
    const entry = line.match(/^\s*"([^"]+)",?\s*(?:\/\/.*)?$/);
    if (entry) keys.push(entry[1]);
  }
  throw new Error(`${file}: "${name}" was never closed with "] as const;"`);
}

test("every key the daemon accepts is settable through rig config", () => {
  const cli = listOf(CLI_STORE, "VALID_KEYS");
  const daemon = listOf(DAEMON_STORE, "SETTINGS_VALID_KEYS");
  const rejectedByCli = daemon.filter((key) => !cli.includes(key) && !INTENTIONAL_DIFFERENCES.includes(key));
  assert.deepEqual(
    rejectedByCli,
    [],
    `the daemon resolves these keys and rig config rejects them: ${rejectedByCli.join(", ")}`,
  );
});

test("every key rig config accepts is one the daemon resolves", () => {
  const cli = listOf(CLI_STORE, "VALID_KEYS");
  const daemon = listOf(DAEMON_STORE, "SETTINGS_VALID_KEYS");
  const unknownToDaemon = cli.filter((key) => !daemon.includes(key) && !INTENTIONAL_DIFFERENCES.includes(key));
  assert.deepEqual(
    unknownToDaemon,
    [],
    `rig config accepts these keys and the daemon does not resolve them: ${unknownToDaemon.join(", ")}`,
  );
});
