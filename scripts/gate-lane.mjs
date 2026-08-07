#!/usr/bin/env node
// F1 gate-lane runner ENTRYPOINT (arch d6a6c1db, mechanism (B) bound-port, 5 pins). Wires the machine-wide
// mutex (gate-lane-lock) + the honesty-gap legs + the C2 verdict (gate-lane-run) into one gate:
//   acquire lane (non-blocking) → refuse+teach+exit-nonzero on contention (P5) → observe foreign load
//   (advisory, recorded) → run BOTH legs (typecheck AND vitest AND vitest:ui — the two honesty gaps) →
//   write the C2 verdict (green carries the load it ran under) → release (kernel also frees on death).
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join, dirname } from "node:path";
import { acquireGateLane, GATE_LANE_PORT } from "./gate-lane-lock.mjs";
import { renderRefusal, runLegs, buildVerdict, observeForeignLoad } from "./gate-lane-run.mjs";

const RUNTIME_DIR = (() => { const d = join(tmpdir(), "openrig-gate"); mkdirSync(d, { recursive: true }); return d; })();
const HOLDER_INFO = join(RUNTIME_DIR, "gate-lane.holder.json");
const VERDICT_PATH = process.env.OPENRIG_GATE_VERDICT ?? join(process.cwd(), "gate-lane-verdict.json");
const SMOKE = process.env.OPENRIG_GATE_LANE_SMOKE === "1"; // skip the real legs (mutex/verdict wiring smoke)

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
    const exec = SMOKE
      ? async (cmd) => { console.log(`[smoke] skip: ${cmd}`); return { ok: true, code: 0 }; }
      : async (cmd) => { const r = spawnSync(cmd, { shell: true, stdio: "inherit" }); return { ok: r.status === 0, code: r.status }; };
    const legs = await runLegs(exec);
    const verdict = buildVerdict({ legs, foreignLoad, startedAt, endedAt: new Date().toISOString() });
    mkdirSync(dirname(VERDICT_PATH), { recursive: true }); // ensure the verdict's home exists
    writeFileSync(VERDICT_PATH, JSON.stringify(verdict, null, 2));
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
