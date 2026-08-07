#!/usr/bin/env node
// F1 gate-lane runner ENTRYPOINT (arch d6a6c1db, mechanism (B) bound-port, 5 pins). Wires the machine-wide
// mutex (gate-lane-lock) + the honesty-gap legs + the C2 verdict (gate-lane-run) into one gate:
//   acquire lane (non-blocking) → refuse+teach+exit-nonzero on contention (P5) → observe foreign load
//   (advisory, recorded) → run BOTH legs (typecheck AND vitest AND vitest:ui — the two honesty gaps) →
//   write the C2 verdict (green carries the load it ran under) → release (kernel also frees on death).
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";
import { renderRefusal, runLegs, buildVerdict, observeForeignLoad, cleanStaleVendoredBundle } from "./gate-lane-run.mjs";

const RUNTIME_DIR = (() => { const d = join(tmpdir(), "openrig-gate"); mkdirSync(d, { recursive: true }); return d; })();
const HOLDER_INFO = join(RUNTIME_DIR, "gate-lane.holder.json");
const VERDICT_PATH = process.env.OPENRIG_GATE_VERDICT ?? join(process.cwd(), "gate-lane-verdict.json");
const SMOKE = process.env.OPENRIG_GATE_LANE_SMOKE === "1"; // skip the real legs (mutex/verdict wiring smoke)

// F1 exclusion-ledger seed (empty by design). Absent/corrupt → treat as EMPTY (strict gate), never a
// silent skip. cutCeiling comes from the seed so the desk owns it in one place.
const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), "gate-lane-exclusions.json");
function loadLedger() {
  try {
    const doc = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return { entries: Array.isArray(doc.entries) ? doc.entries : [], cutCeiling: doc.cutCeiling };
  } catch {
    return { entries: [], cutCeiling: undefined };
  }
}

function snapshotProcesses() {
  try {
    return execSync("ps -eo pid,comm", { encoding: "utf8" }).trim().split("\n").slice(1)
      .map((l) => { const m = l.trim().match(/^(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), command: m[2] } : null; })
      .filter(Boolean);
  } catch { return []; }
}

async function main() {
  const startedAt = new Date().toISOString();
  const lane = await acquireGateLane({ port: GATE_LANE_PORT, holderInfoPath: HOLDER_INFO });
  if (!lane.ok) {
    console.error(renderRefusal(lane, GATE_LANE_PORT));
    process.exit(2); // hard-refuse, non-blocking (never block-wait)
  }
  let exitCode = 3;
  try {
    const foreignLoad = observeForeignLoad({ loadavg: loadavg(), processes: snapshotProcesses() });
    if (foreignLoad.advisory.length) console.warn(`⚠ advisory (exit UNCHANGED, recorded in verdict): ${foreignLoad.advisory.join("; ")}`);
    // SOURCE-TRUTH: drop any stale vendored daemon bundle (a gitignored build:package leftover) before
    // the legs run, so test:repo's freshness guard is never poisoned by a desk leftover. Real package-time
    // assembly is still guarded; a fresh checkout is a no-op.
    const removedBundle = cleanStaleVendoredBundle(process.cwd());
    console.log(`[gate] source-truth: cleaned any stale vendored bundle at ${removedBundle}`);
    const exec = SMOKE
      ? async (cmd) => { console.log(`[smoke] skip: ${cmd}`); return { ok: true, code: 0 }; }
      : async (cmd) => { const r = spawnSync(cmd, { shell: true, stdio: "inherit" }); return { ok: r.status === 0, code: r.status }; };
    const legs = await runLegs(exec);
    const endedAt = new Date().toISOString();
    const { entries: ledger, cutCeiling } = loadLedger();
    const verdict = buildVerdict({ legs, foreignLoad, startedAt, endedAt, ledger, now: endedAt, cutCeiling });
    mkdirSync(dirname(VERDICT_PATH), { recursive: true }); // ensure the verdict's home exists
    writeFileSync(VERDICT_PATH, JSON.stringify(verdict, null, 2));
    console.log(verdict.ledgerState); // in-band LOUD: name every exclusion (or "0 exclusions")
    console.log(`gate: ${verdict.gate.toUpperCase()} — verdict → ${VERDICT_PATH} (legs: ${legs.map((l) => `${l.name}=${l.ok ? "ok" : "FAIL"}`).join(", ")})`);
    exitCode = verdict.gate === "pass" ? 0 : 1;
  } catch (e) {
    console.error("gate-lane legs threw:", e?.stack ?? e);
    exitCode = 3;
  } finally {
    await lane.release(); // release BEFORE exit (kernel also frees the port on death)
  }
  process.exit(exitCode);
}
main().catch((e) => { console.error("gate-lane runner threw:", e?.stack ?? e); process.exit(3); });
