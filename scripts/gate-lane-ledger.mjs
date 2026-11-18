// F1 exclusion-ledger — the 4-rail MECHANISM (PM ruling: the exclusion ledger "with teeth").
//
// A base-health suite that genuinely cannot be fixed before a cut may be EXCLUDED from the gate —
// but only VISIBLY, OWNED, RECEIPTED, and MECHANICALLY EXPIRING. This module is pure logic (inject
// `now`/`cutCeiling`) so the rails are unit-tested; the gate entrypoint wires the real ledger file +
// clock around it. It ships with an EMPTY seed: the named-6 were KILLED, not excluded, so main is
// truly green and no suite is a resident. The mechanism is the durable belt for a future cut.
//
//   Rail 1  green-with-exclusions — a failure COVERED by an active resident → gate PASS, named in-band
//   Rail 2  mechanical expiry     — a resident past its expiry → gate FAIL (forces removal; self-dying)
//   Rail 3  receipt+owner+expiry  — every resident carries an A/B receipt, an owner, and an expiry
//   Rail 4  cut ceiling           — no resident's expiry may outlive the 0.5.2 cut

export const LEDGER_ENTRY_FIELDS = ["suite", "reason", "receipt", "owner", "expiry"];

// Rail 4 — the cut ceiling: no exclusion may expire after this instant. It is a date a person sets at a
// cut, so it is not moved by this module on its own. A ceiling that has gone by is reported as a
// warning (see ceilingWarning) rather than failing the gate: an elapsed date is not a verdict, and an
// empty ledger says nothing about the suites it covers.
export const CUT_CEILING_ISO = "2026-09-30";

// Date-only lexicographic compare: for YYYY-MM-DD, string order IS chronological order.
const day = (d) => String(d).slice(0, 10);

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Rail 3 + Rail 4 static validation: every resident MUST carry the full schema, and its expiry MUST
 * NOT outlive the cut ceiling. Returns { valid, errors }, and an invalid ledger is a loud gate failure,
 * never a silent pass.
 *
 * A ceiling that has gone by is deliberately not an error here. It is a date a person sets at a cut,
 * so an elapsed one is a warning (ceilingWarning), not a verdict about a suite: a stale ceiling makes
 * the ledger unable to admit a resident, and saying so is useful, while failing an otherwise healthy
 * gate on the calendar alone is not.
 */
export function validateLedger(ledger = [], { cutCeiling = CUT_CEILING_ISO } = {}) {
  const errors = [];
  ledger.forEach((entry, i) => {
    const tag = entry && entry.suite ? `"${entry.suite}"` : `entry[${i}]`;
    for (const field of LEDGER_ENTRY_FIELDS) {
      const v = entry ? entry[field] : undefined;
      if (v === undefined || v === null || String(v).trim() === "") {
        errors.push(`${tag}: missing required field "${field}"`);
      }
    }
    if (!isCalendarDate(entry?.expiry)) {
      errors.push(`${tag}: expiry must be a valid YYYY-MM-DD calendar date`);
    } else if (isCalendarDate(cutCeiling) && day(entry.expiry) > day(cutCeiling)) {
      errors.push(`${tag}: expiry ${day(entry.expiry)} exceeds the cut ceiling ${day(cutCeiling)}`);
    }
  });
  return { valid: errors.length === 0, errors };
}

/**
 * The ceiling's own state, as a warning rather than a verdict. A ceiling that has gone by means no
 * resident can satisfy both `expiry <= ceiling` and "expiry has not passed", so the ledger cannot
 * excuse anything until a cut moves it. That is worth saying out loud, and it is not worth turning an
 * otherwise healthy gate red: the date is a person's decision, not a property of the suite.
 */
export function ceilingWarning(cutCeiling = CUT_CEILING_ISO, today = new Date().toISOString()) {
  if (!isCalendarDate(cutCeiling)) return `cut ceiling ${JSON.stringify(cutCeiling)} is not a YYYY-MM-DD date`;
  if (day(cutCeiling) >= day(today)) return null;
  return `cut ceiling ${day(cutCeiling)} has passed (today is ${day(today)}), so no exclusion can be admitted until a cut moves it`;
}

/**
 * Rail 1 + Rail 2 — resolve the gate verdict against the ledger. PASS iff: the ledger is schema/ceiling
 * VALID, every failure is COVERED by an ACTIVE (non-expired) resident, and NO resident is expired
 * (a resident past its expiry forces RED regardless of its suite's current state — it must be removed
 * or re-justified). Otherwise FAIL. Injected `now`/`cutCeiling` keep it deterministic.
 */
export function resolveGateWithLedger({ failures = [], ledger = [], now, cutCeiling = CUT_CEILING_ISO }) {
  const today = day(now);
  const validity = validateLedger(ledger, { cutCeiling });

  const active = [];
  const expired = [];
  for (const entry of ledger) {
    if (entry && entry.expiry && day(entry.expiry) < today) expired.push(entry);
    else active.push(entry);
  }

  const activeSuites = new Set(active.map((e) => e.suite));
  const covered = failures.filter((f) => activeSuites.has(f));
  const uncovered = failures.filter((f) => !activeSuites.has(f));

  const gate = validity.valid && uncovered.length === 0 && expired.length === 0 ? "pass" : "fail";
  const warning = ceilingWarning(cutCeiling, today);
  return {
    gate,
    covered,
    uncovered,
    expired: expired.map((e) => e.suite),
    activeExclusions: active,
    validity,
    warnings: warning === null ? [] : [warning],
  };
}

/**
 * The in-band LOUD render (Rail 1): a green that carries exclusions must NAME every one of them, and a
 * failure must name what's uncovered or expired. An empty ledger says so plainly.
 */
export function renderLedgerState(result) {
  const n = result.activeExclusions.length;
  const lines = [];
  if (n === 0) {
    lines.push("gate ledger: 0 exclusions (clean — no residents).");
  } else {
    lines.push(`gate ledger: ${n} active exclusion(s) — GREEN WITH EXCLUSIONS (each named):`);
    for (const e of result.activeExclusions) {
      lines.push(`  • ${e.suite} — owner ${e.owner}, expires ${day(e.expiry)}, receipt ${e.receipt} (${e.reason})`);
    }
  }
  if (result.uncovered.length) {
    lines.push(`  ✗ UNCOVERED failures (no exclusion covers them): ${result.uncovered.join(", ")}`);
  }
  if (result.expired.length) {
    lines.push(`  ✗ EXPIRED residents (mechanical expiry — REMOVE or re-justify): ${result.expired.join(", ")}`);
  }
  if (!result.validity.valid) {
    lines.push(`  ✗ INVALID ledger entries: ${result.validity.errors.join("; ")}`);
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`  ! ${warning}`);
  }
  lines.push(`gate: ${result.gate.toUpperCase()}`);
  return lines.join("\n");
}
