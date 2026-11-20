import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateLedger,
  ceilingWarning,
  resolveGateWithLedger,
  renderLedgerState,
  CUT_CEILING_ISO,
  LEDGER_ENTRY_FIELDS,
} from "./gate-lane-ledger.mjs";

// F1 exclusion-ledger — the 4-rail MECHANISM (PM ruling, "with teeth"). Empty seed: the named-6 were
// KILLED, not excluded, so main is truly green and the ledger holds zero residents. These tests prove
// the rails on FIXTURE ledgers (deterministic injected `now` + `cutCeiling`), so the mechanism is the
// durable belt for a FUTURE cut's un-fixable base-health suites.
//
//   Rail 1  green-with-exclusions — a failure COVERED by an active resident → gate PASS, named in-band
//   Rail 2  mechanical expiry     — a resident past its expiry → gate FAIL (forces removal; self-dying)
//   Rail 3  receipt+owner+expiry  — every resident carries an A/B receipt, an owner, and an expiry
//   Rail 4  cut ceiling           — no resident's expiry may outlive the 0.5.2 cut

const CEIL = "2025-09-01"; // an explicit test ceiling (the real one is CUT_CEILING_ISO)
// An explicit clock as well as an explicit ceiling: the ceiling's staleness and a resident's expiry
// are both read against this date, so these cases keep their meaning at any real date.
const TODAY = "2025-08-10";
const ok = (over = {}) => ({ suite: "flaky-suite", reason: "contention flake", receipt: "A/B sha abc", owner: "dev-driver", expiry: "2025-08-20", ...over });

// ---- Rail 3: schema ----------------------------------------------------------------------------
test("rail 3 — a resident missing receipt/owner/expiry is REJECTED (each named)", () => {
  const r = validateLedger([{ suite: "x", reason: "r" }], { cutCeiling: CEIL, today: TODAY });
  assert.equal(r.valid, false);
  for (const field of ["receipt", "owner", "expiry"]) {
    assert.ok(r.errors.some((e) => e.includes(field)), `missing ${field} must be reported`);
  }
});

test("rail 3 — LEDGER_ENTRY_FIELDS names the required schema (receipt+owner+expiry+suite+reason)", () => {
  for (const f of ["suite", "reason", "receipt", "owner", "expiry"]) {
    assert.ok(LEDGER_ENTRY_FIELDS.includes(f), `${f} is a required ledger field`);
  }
});

// ---- Rail 4: cut ceiling -----------------------------------------------------------------------
test("rail 4 — a resident whose expiry EXCEEDS the cut ceiling is REJECTED", () => {
  const r = validateLedger([ok({ expiry: "2099-12-31" })], { cutCeiling: CEIL, today: TODAY });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /ceiling|cut/i.test(e)), "ceiling violation must be reported");
});

test("rail 4 — a well-formed resident within the ceiling VALIDATES clean", () => {
  const r = validateLedger([ok()], { cutCeiling: CEIL, today: TODAY });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("rail 4 — CUT_CEILING_ISO is a real ISO date (the mechanism has a concrete ceiling)", () => {
  assert.match(CUT_CEILING_ISO, /^\d{4}-\d\d-\d\d/);
  assert.equal(Number.isNaN(Date.parse(CUT_CEILING_ISO)), false);
});

// A ceiling is a date a person sets at a cut. Once it has gone by, no resident can satisfy both
// "expiry <= ceiling" and "expiry has not passed", so the ledger cannot excuse anything until a cut
// moves it. That is worth saying out loud and not worth failing an otherwise healthy gate on.
test("rail 4 — a ceiling in the past is a WARNING, and an empty ledger still passes", () => {
  const r = resolveGateWithLedger({ failures: [], ledger: [], now: "2025-12-01", cutCeiling: "2025-09-01" });
  assert.equal(r.gate, "pass");
  assert.equal(r.validity.valid, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /cut ceiling 2025-09-01 has passed/);
  assert.match(renderLedgerState(r), /cut ceiling 2025-09-01 has passed/);
});

test("rail 4 — a ceiling that is still ahead says nothing", () => {
  const r = resolveGateWithLedger({ failures: [], ledger: [], now: "2025-08-10", cutCeiling: "2025-09-01" });
  assert.deepEqual(r.warnings, []);
});

test("rail 4 — the shipped ceiling's own state is reported, and the date is not moved here", () => {
  // 2026-09-30 is behind today, so the ledger cannot admit a resident until a cut moves it; the gate
  // reports that and does not decide the cut date on its own.
  const warning = ceilingWarning(CUT_CEILING_ISO);
  if (Date.parse(CUT_CEILING_ISO) < Date.now()) {
    assert.match(warning, /has passed/);
  } else {
    assert.equal(warning, null);
  }
});

test("rail 4 — the ledger file and the module name the same ceiling", () => {
  // Two declarations of one cut date: the module's constant is the default the resolver uses, and the
  // ledger file's is what the gate loads. They have to agree, or moving one leaves the other stale.
  const ledger = JSON.parse(readFileSync(new URL("./gate-lane-exclusions.json", import.meta.url), "utf8"));
  assert.equal(ledger.cutCeiling, CUT_CEILING_ISO);
});

// ---- Rail 1: green-with-exclusions -------------------------------------------------------------
test("rail 1 — a failure COVERED by an active resident → gate PASS, the exclusion is NAMED", () => {
  const r = resolveGateWithLedger({ failures: ["flaky-suite"], ledger: [ok()], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "pass");
  assert.deepEqual(r.covered, ["flaky-suite"]);
  assert.deepEqual(r.uncovered, []);
  assert.equal(r.activeExclusions.length, 1);
  assert.match(renderLedgerState(r), /flaky-suite/); // loud, in-band
});

test("rail 1 — an UNCOVERED failure → gate FAIL (no resident to hide behind)", () => {
  const r = resolveGateWithLedger({ failures: ["surprise-suite"], ledger: [ok()], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
  assert.deepEqual(r.uncovered, ["surprise-suite"]);
});

// ---- Rail 2: mechanical expiry -----------------------------------------------------------------
test("rail 2 — an EXPIRED resident no longer covers its failure → gate FAIL", () => {
  const r = resolveGateWithLedger({ failures: ["flaky-suite"], ledger: [ok({ expiry: "2025-08-01" })], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
  assert.ok(r.expired.includes("flaky-suite"));
  assert.deepEqual(r.covered, []);
});

test("rail 2 — an expired resident forces RED even when its suite PASSES now (stale exclusion must be removed)", () => {
  const r = resolveGateWithLedger({ failures: [], ledger: [ok({ suite: "old-suite", expiry: "2025-08-01" })], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
  assert.ok(r.expired.includes("old-suite"));
});

// ---- Empty seed (the shipped reality) ----------------------------------------------------------
test("EMPTY SEED — zero residents + zero failures → clean PASS, no exclusions named", () => {
  const r = resolveGateWithLedger({ failures: [], ledger: [], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "pass");
  assert.deepEqual(r.activeExclusions, []);
  assert.match(renderLedgerState(r), /0 exclusion|no exclusion/i);
});

test("EMPTY SEED — zero residents + any failure → FAIL (the gate is strict by default)", () => {
  const r = resolveGateWithLedger({ failures: ["anything"], ledger: [], now: "2025-08-10", cutCeiling: CEIL });
  assert.equal(r.gate, "fail");
});

// Invalid exclusion data must never turn a failing suite into a passing gate.
test("rail 3 — expiry must be a calendar date, not a coerced or truncated value", () => {
  for (const expiry of [false, 0, true, 123, {}, [], "invalid", "2025-00-10", "2025-02-29", "2025-04-31", "2025-08-20junk", "2025-08-20T00:00:00Z"]) {
    const r = resolveGateWithLedger({ failures: ["flaky-suite"], ledger: [ok({ expiry })], now: "2025-08-10", cutCeiling: CEIL });
    assert.equal(r.gate, "fail", `invalid expiry ${JSON.stringify(expiry)} must refuse`);
    assert.equal(r.validity.valid, false);
    assert.ok(r.validity.errors.some((e) => e.includes("expiry")));
  }
});

test("rail 3 — leap days validate only in leap years", () => {
  assert.equal(validateLedger([ok({ expiry: "2024-02-29" })], { cutCeiling: CEIL, today: TODAY }).valid, true);
  assert.equal(validateLedger([ok({ expiry: "2025-02-29" })], { cutCeiling: CEIL, today: TODAY }).valid, false);
});
