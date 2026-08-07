import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLedger,
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
const ok = (over = {}) => ({ suite: "flaky-suite", reason: "contention flake", receipt: "A/B sha abc", owner: "dev-driver", expiry: "2025-08-20", ...over });

// ---- Rail 3: schema ----------------------------------------------------------------------------
test("rail 3 — a resident missing receipt/owner/expiry is REJECTED (each named)", () => {
  const r = validateLedger([{ suite: "x", reason: "r" }], { cutCeiling: CEIL });
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
  const r = validateLedger([ok({ expiry: "2099-12-31" })], { cutCeiling: CEIL });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /ceiling|cut/i.test(e)), "ceiling violation must be reported");
});

test("rail 4 — a well-formed resident within the ceiling VALIDATES clean", () => {
  const r = validateLedger([ok()], { cutCeiling: CEIL });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("rail 4 — CUT_CEILING_ISO is a real ISO date (the mechanism has a concrete ceiling)", () => {
  assert.match(CUT_CEILING_ISO, /^\d{4}-\d\d-\d\d/);
  assert.equal(Number.isNaN(Date.parse(CUT_CEILING_ISO)), false);
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
