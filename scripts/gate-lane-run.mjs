// F1 gate-lane runner LOGIC (arch d6a6c1db, mechanism (B), 5 pins). Pure/injected so the teaching text,
// the honesty-gap leg set, and the C2 verdict are unit-tested; the CLI entrypoint (gate-lane.mjs) wires
// the real mutex + subprocess exec + artifact write around these.

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
 * HONESTY gaps closed here: the gate runs ALL THREE legs — typecheck (lint) AND vitest (test, the
 * workspaces) AND vitest:ui (test:ui — which `npm test` EXCLUDES). All legs run (not fail-fast) so the
 * verdict records every result; green = every leg ok. `exec(cmd)` is injected → `{ok, code}`.
 */
export async function runLegs(exec) {
  const specs = [
    { name: "typecheck", cmd: "npm run lint" },      // gap-2 leg A: tsc ×4 (incl. P9 typecheck:prep)
    { name: "vitest", cmd: "npm run test" },          // gap-2 leg B: test:repo + workspaces
    { name: "vitest:ui", cmd: "npm run test:ui" },    // gap-1: the leg npm test omits
  ];
  const legs = [];
  for (const s of specs) {
    const r = await exec(s.cmd);
    legs.push({ name: s.name, cmd: s.cmd, ok: !!r.ok, code: r.code ?? null });
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
 * is only as good as what could have been red. gate = pass iff every leg ok.
 */
export function buildVerdict({ legs, foreignLoad, startedAt, endedAt }) {
  return {
    gate: legs.every((l) => l.ok) ? "pass" : "fail",
    legs,
    foreignLoad,
    startedAt,
    endedAt,
  };
}
