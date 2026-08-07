import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRefusal, runLegs, buildVerdict, observeForeignLoad, cleanStaleVendoredBundle } from "./gate-lane-run.mjs";

// F1 gate-lane runner logic (arch d6a6c1db, 5 pins). HONESTY (gap 1): the gate runs test:ui (npm test
// excludes it); (gap 2) green = typecheck AND vitest BOTH legs. P5: refusal teaches the port constant,
// names the gate holder (pid/started-at) or honest-unknown for a foreign squatter, always hard-refuse.

test("P5 refusal — gate holder is NAMED (pid/started-at) + teaches the port constant, always refuses", () => {
  const t = renderRefusal({ reason: "gate-holder", holder: { pid: 4242, startedAt: "2026-08-07T09:00:00Z" } }, 40404);
  assert.match(t, /40404/);            // teaches the port constant
  assert.match(t, /4242/);             // names the holder pid
  assert.match(t, /2026-08-07T09:00:00Z/); // + started-at
  assert.match(t, /refus/i);           // hard-refuse
});

test("P5 refusal — foreign squatter is HONEST-UNKNOWN + still teaches the port constant + refuses", () => {
  const t = renderRefusal({ reason: "foreign-holder" }, 40404);
  assert.match(t, /40404/);
  assert.match(t, /unknown|foreign/i); // honest-unknown, not a fabricated holder
  assert.doesNotMatch(t, /pid \d/i);   // no fabricated pid
  assert.match(t, /refus/i);
});

test("HONESTY gap-1: runLegs runs ALL THREE legs incl. test:ui (npm test excludes ui)", async () => {
  const ran = [];
  const exec = async (cmd) => { ran.push(cmd); return { ok: true, code: 0 }; };
  const legs = await runLegs(exec);
  const names = legs.map((l) => l.name);
  assert.ok(names.includes("typecheck"), "typecheck leg");
  assert.ok(names.includes("vitest"), "vitest leg (workspaces)");
  assert.ok(names.includes("vitest:ui"), "vitest:ui leg — the excluded-from-npm-test honesty gap");
  assert.ok(legs.every((l) => l.ok));
});

test("HONESTY gap-2: green = typecheck AND vitest BOTH — one failed leg fails the gate", async () => {
  const exec = async (cmd) => ({ ok: !/ui/.test(cmd), code: /ui/.test(cmd) ? 1 : 0 }); // ui fails
  const legs = await runLegs(exec);
  const v = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "t1" });
  assert.equal(v.gate, "fail");
  assert.equal(v.legs.find((l) => l.name === "vitest:ui").ok, false);
});

test("advisory foreign-load — counts foreign node/vitest/tsc processes + loadavg (never the gate's own pid)", () => {
  const fl = observeForeignLoad({
    loadavg: [4.1, 3.2, 2.0],
    processes: [
      { pid: process.pid, command: "node scripts/gate-lane.mjs" }, // self — excluded
      { pid: 111, command: "node …/vitest" },
      { pid: 222, command: "tsc --noEmit" },
      { pid: 333, command: "Finder" }, // non-toolchain — not counted
    ],
  });
  assert.equal(fl.foreignProcessCount, 2);
  assert.deepEqual(fl.loadavg, [4.1, 3.2, 2.0]);
  assert.ok(fl.advisory.some((a) => /2 foreign/.test(a)));
  assert.ok(fl.advisory.some((a) => /loadavg/.test(a)));
});

test("C2 verdict — a GREEN carries the foreign-load context it ran under (recorded, not just printed)", () => {
  const v = buildVerdict({
    legs: [{ name: "typecheck", ok: true }, { name: "vitest", ok: true }, { name: "vitest:ui", ok: true }],
    foreignLoad: { advisory: ["3 foreign node processes, loadavg 4.10"] },
    startedAt: "t0", endedAt: "t1",
  });
  assert.equal(v.gate, "pass");
  assert.deepEqual(v.foreignLoad.advisory, ["3 foreign node processes, loadavg 4.10"]);
  assert.equal(v.startedAt, "t0");
});

test("exclusion-ledger — empty seed stays STRICT; an active resident covering a failed leg → PASS + named", () => {
  const legs = [{ name: "typecheck", ok: true }, { name: "vitest", ok: false }, { name: "vitest:ui", ok: true }];
  // EMPTY seed (the shipped reality): the failed vitest leg is uncovered → gate FAIL (strict).
  const strict = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "2025-08-10", ledger: [] });
  assert.equal(strict.gate, "fail");
  assert.equal(strict.ledger.activeExclusions.length, 0);
  assert.match(strict.ledgerState, /0 exclusion|no exclusion/i);
  // With an ACTIVE resident excluding the failed leg → gate PASS, exclusion NAMED in the verdict.
  const excl = [{ suite: "vitest", reason: "known-flaky", receipt: "A/B abc", owner: "dev-driver", expiry: "2025-08-20" }];
  const covered = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "2025-08-10", ledger: excl, cutCeiling: "2025-09-01" });
  assert.equal(covered.gate, "pass");
  assert.equal(covered.ledger.activeExclusions.length, 1);
  assert.match(covered.ledgerState, /vitest/);
});

// The gate tests SOURCE truth. A stale desk leftover at packages/cli/daemon (a gitignored build
// artifact from a prior `npm run build:package`) would poison test:repo's freshness guard — the guard
// correctly flags an assembled-but-stale bundle, but the gate is not a package-time context. The runner
// removes it at gate start so a leftover can never poison a run; real package-time assembly is still
// guarded, and a fresh clone (no bundle) is a no-op.
test("gate cleans a stale vendored daemon bundle at start so a desk leftover can't poison test:repo", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-vendored-"));
  const bundleDist = join(root, "packages", "cli", "daemon", "dist");
  mkdirSync(bundleDist, { recursive: true });
  writeFileSync(join(bundleDist, "index.js"), "// stale leftover from an old build:package assembly");
  assert.ok(existsSync(bundleDist), "planted stale bundle exists");

  const removed = cleanStaleVendoredBundle(root);
  assert.equal(existsSync(join(root, "packages", "cli", "daemon")), false, "the whole vendored daemon tree is removed");
  assert.match(removed, /packages[\\/]cli[\\/]daemon$/);

  // idempotent: a fresh clone with no bundle is a clean no-op (force:true), never a throw.
  assert.doesNotThrow(() => cleanStaleVendoredBundle(root));
});
