// Crash-cart LOOK-gate capture harness (PM Mock-2 comparison). Renders the THREE daemon-down screens
// through the REAL render + stylize pipeline (the exact bytes the TUI writes to the terminal) at a
// fixed viewport, and drops per-screen .ans (ANSI — `cat` it in a terminal to see the true look) + .txt
// (plain, stripAnsi) + a SHA256SUMS manifest. Deterministic (fixed fixtures + truecolor), so a re-run
// reproduces byte-identical captures.
//
//   node --import tsx scripts/capture-crash-cart.mjs <out-dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { renderCrashCartScreen, renderUnverifiedScreen } from "../src/crash-cart/render-crash-cart.js";
import { demoCrashCartModel, buildCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

const OUT = process.argv[2] ?? "crash-cart-captures";
mkdirSync(OUT, { recursive: true });
const style = createStyle("truecolor");
const viewport = { cols: 120, rows: 32 };

const screens = {
  // Cockpit POPULATED (openrig-pm/kernel/oversight) — incl. the honest-null header slots
  // ("uptime unavailable — no shutdown record" · "reason: unavailable — no shutdown record").
  "cockpit-populated": renderCrashCartScreen(demoCrashCartModel(), viewport),
  // UNVERIFIED — evidence verbatim + retry/quit, zero recovery actions.
  unverified: renderUnverifiedScreen(
    { pidState: "alive (pid 4242)", probeResult: "timeout", failedSignal: "healthz timed out after 3 probes" },
    viewport,
  ),
  // FIRST-RUN — DOWN + no DB (no rigs, no prior activity) → onboarding framing, never a crash story.
  "first-run": renderCrashCartScreen(
    buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] }),
    viewport,
  ),
};

const manifest = [];
for (const [name, screen] of Object.entries(screens)) {
  const ansi = stylizeLines(screen, style).join("\n") + "\n";
  const plain = screen.lines.map((l) => stripAnsi(l)).join("\n") + "\n";
  writeFileSync(join(OUT, `${name}.ans`), ansi);
  writeFileSync(join(OUT, `${name}.txt`), plain);
  manifest.push(`${createHash("sha256").update(ansi).digest("hex")}  ${name}.ans`);
  manifest.push(`${createHash("sha256").update(plain).digest("hex")}  ${name}.txt`);
}
writeFileSync(join(OUT, "SHA256SUMS"), manifest.join("\n") + "\n");
console.log(`captured ${Object.keys(screens).length} crash-cart screens → ${OUT}`);
console.log(manifest.join("\n"));
