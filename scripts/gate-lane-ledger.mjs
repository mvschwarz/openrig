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

// Rail 4 — the 0.5.2 cut ceiling: no exclusion may expire after this instant. DESK-PINNED at the real
// 0.5.2 cut date; this near-future placeholder is inert while the seed is empty, and the mechanism
// enforces `expiry <= ceiling` regardless of the exact value.
export const CUT_CEILING_ISO = "2026-09-30";

// Date-only lexicographic compare: for YYYY-MM-DD, string order IS chronological order.
const day = (d) => String(d).slice(0, 10);

/**
 * Rail 3 + Rail 4 static validation: every resident MUST carry the full schema, and its expiry MUST
 * NOT outlive the cut ceiling. Returns { valid, errors } — an invalid ledger is a loud gate failure,
 * never a silent pass.
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
    if (entry && entry.expiry && day(entry.expiry) > day(cutCeiling)) {
      errors.push(`${tag}: expiry ${day(entry.expiry)} exceeds the 0.5.2 cut ceiling ${day(cutCeiling)}`);
    }
  });
  return { valid: errors.length === 0, errors };
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
  return {
    gate,
    covered,
    uncovered,
    expired: expired.map((e) => e.suite),
    activeExclusions: active,
    validity,
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
  lines.push(`gate: ${result.gate.toUpperCase()}`);
  return lines.join("\n");
}
