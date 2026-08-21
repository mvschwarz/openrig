// F1 gate-lane runner LOGIC (arch d6a6c1db, mechanism (B), 5 pins). Pure/injected so the teaching text,
// the honesty-gap leg set, and the C2 verdict are unit-tested; the CLI entrypoint (gate-lane.mjs) wires
// the real mutex + subprocess exec + artifact write around these.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveGateWithLedger, renderLedgerState } from "./gate-lane-ledger.mjs";

/**
 * SOURCE-TRUTH hygiene: remove the vendored daemon bundle at packages/cli/daemon before the legs run.
 * That path is a GITIGNORED build artifact assembled by `npm run build:package`; a stale desk leftover
 * there poisons test:repo's freshness guard (the guard correctly flags any assembled-but-stale bundle,
 * but the gate is not a package-time context — it tests SOURCE truth). Removing it at gate start means a
 * leftover can never poison a run; real package-time assembly is still guarded, and a fresh clone with no
 * bundle is a `force:true` no-op. `rm` is injected for testability. Returns the removed path.
 */
export function cleanStaleVendoredBundle(repoRoot, rm = rmSync) {
  const vendored = join(repoRoot, "packages", "cli", "daemon");
  rm(vendored, { recursive: true, force: true });
  return vendored;
}

/**
 * P5 — the refusal teaching text. ALWAYS hard-refuses; ALWAYS teaches the port constant. A gate holder is
 * NAMED (pid/started-at); a foreign squatter is HONEST-UNKNOWN (never a fabricated holder).
 */
export function renderRefusal(result, port) {
  const head = `⛔ gate lane BUSY — lock = localhost port ${port} (OPENRIG_GATE_LANE_PORT). REFUSING (non-blocking, exit nonzero).`;
  if (result.reason === "gate-holder" && result.holder) {
    return (
      `${head}\n` +
      `   held by another GATE: pid ${result.holder.pid}, started ${result.holder.startedAt}.\n` +
      `   Another full gate lane is running on this machine — wait for it or inspect that pid.`
    );
  }
  return (
    `${head}\n` +
    `   held by a FOREIGN process — holder UNKNOWN (no gate holder-info file).\n` +
    `   Fail-closed (load-115): a gate lane must not run beside unknown load. Free port ${port} or inspect what holds it.`
  );
}

/**
 * The gate runs BOTH legs — typecheck (lint) AND vitest (test: repo scripts + the supported
 * workspaces: daemon, cli, tui). All legs run (not fail-fast) so the verdict records every result;
 * green = every leg ok. `exec(cmd)` is injected → `{ok, code}`.
 *
 * The web UI (packages/ui) is deliberately NOT a gate leg. Founder ruling 2026-08-21: the web UI
 * went best-effort experimental at the 0.5.0 TUI pivot and releases must not spend gate time or
 * block on it. `npm run test:ui` still exists for manual runs; it gates nothing.
 */
export async function runLegs(exec) {
  const specs = [
    { name: "typecheck", cmd: "npm run lint" },      // tsc ×4 (incl. P9 typecheck:prep)
    { name: "vitest", cmd: "npm run test" },          // test:repo + supported workspaces (no packages/ui)
  ];
  const legs = [];
  for (const s of specs) {
    // Per-leg wall-clock (ms) — the discriminator a whole-run total hides: a MIXED-mode run (some legs
    // real, some smoked/skipped) still sums into a plausible band, but the skipped legs show ~0ms here.
    const t0 = Date.now();
    const r = await exec(s.cmd);
    const durationMs = Date.now() - t0;
    legs.push({ name: s.name, cmd: s.cmd, ok: !!r.ok, code: r.code ?? null, durationMs });
  }
  return legs;
}

/**
 * Advisory foreign-load context (arch: foreign NON-gate load cannot be locked, only OBSERVED → advisory
 * warn, exit code UNCHANGED, RECORDED in the verdict). Counts foreign toolchain processes (node/vitest/
 * tsc) — never the gate's own pid — plus loadavg. Injected reader (loadavg, processes) for testability.
 */
export function observeForeignLoad({ loadavg, processes }) {
  const foreign = processes.filter((p) => p.pid !== process.pid && /\b(node|vitest|tsc)\b/.test(p.command));
  const advisory = [];
  if (foreign.length > 0) advisory.push(`${foreign.length} foreign node/vitest/tsc process(es) running during the gate`);
  advisory.push(`loadavg ${loadavg.map((n) => n.toFixed(2)).join(" ")}`);
  return { advisory, foreignProcessCount: foreign.length, loadavg };
}

/**
 * C2-style verdict: a green carries the load context it ran under (RECORDED, not just printed) — a green
 * is only as good as what could have been red. The gate is resolved AGAINST THE EXCLUSION LEDGER (F1
 * 4 rails): pass iff every failed leg is COVERED by an active, valid, unexpired resident AND no resident
 * is expired/invalid. With the shipped EMPTY seed the ledger holds no one, so this collapses to strict
 * "pass iff every leg ok" — the ledger state (0 exclusions) is still recorded in-band, loud.
 */
export function buildVerdict({ legs, foreignLoad, startedAt, endedAt, ledger = [], now, cutCeiling, smoke = false }) {
  const failures = legs.filter((l) => !l.ok).map((l) => l.name);
  const ledgerResult = resolveGateWithLedger({
    failures,
    ledger,
    now: now ?? endedAt,
    ...(cutCeiling ? { cutCeiling } : {}),
  });
  return {
    gate: ledgerResult.gate,
    // SELF-DESCRIBING: the mode this verdict ran under, taken from the SINGLE choice point — the caller
    // (gate-lane.mjs) computes SMOKE ONCE to pick the executor (:56) and passes THAT same value here. It
    // is deliberately NOT a second, independent `process.env` read: buildVerdict never sees the injected
    // executor, so reading the env here would record INTENT that can disagree with what actually ran (a
    // smoking exec under an unset env → smoke:false over legs that never executed). Two reads of the same
    // flag can diverge; one cannot. The per-leg durationMs below is the INDEPENDENT observed cross-check:
    // declared mode vs observed effect — if they ever disagree, that disagreement is itself detectable.
    // Without this a smoke run seals a normal PASS indistinguishable from a real one; hash-verifying the
    // JSON proves the file authentic, never that the gate RAN.
    smoke: smoke === true,
    legs,
    foreignLoad,
    ledger: ledgerResult,
    ledgerState: renderLedgerState(ledgerResult),
    startedAt,
    endedAt,
  };
}

/**
 * The gate WIRING, extracted so production and its test call ONE origin — not a mirror. The SINGLE
 * `smoke` value BOTH picks the executor (the skip branch vs the injected real one) AND flows into the
 * verdict, so smoke can never be set at one site and forgotten at the other (the two-origins failure).
 * The real executor is INJECTED — a unit test can't spawn real npm, and this is the same exec-injection
 * runLegs already uses — but the smoke→executor→verdict wiring lives HERE, once. gate-lane.mjs calls
 * this to produce the sealed verdict; the test calls the SAME function, so its negative control guards
 * the shipped path rather than a lookalike.
 */
export async function runGate({ smoke, realExec, foreignLoad, startedAt, ledger = [], cutCeiling }) {
  const exec = smoke
    ? async (cmd) => { console.log(`[smoke] skip: ${cmd}`); return { ok: true, code: 0 }; }
    : realExec;
  const legs = await runLegs(exec);
  const endedAt = new Date().toISOString();
  return buildVerdict({ legs, foreignLoad, startedAt, endedAt, ledger, now: endedAt, cutCeiling, smoke });
}
