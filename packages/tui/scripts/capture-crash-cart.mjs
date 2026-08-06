// Crash-cart LOOK-gate capture harness (PM placement-delta comparison, ruling 3c6c2be0). Renders the
// daemon-down screens IN-SHELL (content-pane inside the standard explorer│content shell) through the
// REAL renderScreen + stylize pipeline (the exact bytes the TUI writes) at a fixed viewport, and drops
// per-screen .ans (ANSI — `cat` it to see the true look) + .txt (plain) + SHA256SUMS. Deterministic
// (fixed fixtures + truecolor + fixed clock) → byte-identical on re-run.
//
//   node --import tsx scripts/capture-crash-cart.mjs <out-dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { renderScreen } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { demoCrashCartModel, buildCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

const OUT = process.argv[2] ?? "crash-cart-captures";
mkdirSync(OUT, { recursive: true });
const style = createStyle("truecolor");
const cols = 120, rows = 32, nowMs = 0;
const snap = emptySnapshot();
const view = createViewState({ instanceId: "crash-cart", getSnapshot: () => snap });
const draw = (opts, s = snap) => renderScreen(view.get(), s, { cols, rows, nowMs, ...opts });

const screens = {
  // Cockpit IN-SHELL — explorer (ledger-fed, honestly marked) + the approved content in the right pane,
  // incl. the honest-null header slots. The placement-delta vs the founder-approved content.
  "cockpit-in-shell": draw({ daemonState: "down", crashCart: demoCrashCartModel() }),
  // UNVERIFIED IN-SHELL — evidence + retry, no restore, explorer present.
  "unverified-in-shell": draw({
    daemonState: "unverified",
    daemonEvidence: { pidState: "alive (pid 4242)", probeResult: "timeout", failedSignal: "healthz timed out after 3 probes" },
  }),
  // FIRST-RUN IN-SHELL — DOWN + no DB → onboarding framing, explorer marked ledger even with no rigs.
  "first-run-in-shell": draw({
    daemonState: "down",
    crashCart: buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] }),
  }),
  // POST-RESTORE SWAP — after a successful restore the shell swaps ledger→live: the SAME shell, now
  // rendering the live fleet (no daemonState). Proves the data-source swap renders honestly, same shell.
  "post-restore-swap": draw({}, demoSnapshot()),
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
console.log(`captured ${Object.keys(screens).length} crash-cart in-shell screens → ${OUT}`);
console.log(manifest.join("\n"));
