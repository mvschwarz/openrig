// Send/broadcast header capture harness (ruling 03c35295, pin 6 proof). Renders the FOUR envelope
// types through the REAL wrapPaneEnvelope (the exact bytes a recipient pane shows), with a fixed stamp,
// and drops per-type .txt + SHA256SUMS. The STORM TEST: a recipient tells DM vs multi vs rig-broadcast
// vs topology from the header alone (the To line + scale) — proven by the four distinct To lines.
// Deterministic (fixed inputs) → byte-identical on re-run.
//
//   node --import tsx scripts/capture-send-header.mjs <out-dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

const OUT = process.argv[2] ?? "send-header-captures";
mkdirSync(OUT, { recursive: true });
const SENDER = "orch-advisor@v-openrig-build";
const HOST = "v-openrig-build";
const STAMP = "2026-08-07T00:42:00Z"; // fixed → deterministic captures

const captures = {
  // A DM — To: the single recipient.
  dm: wrapPaneEnvelope(SENDER, "dev-driver@v-openrig-build", "one-to-one status.", HOST, { stampISO: STAMP }),
  // A multi-send — To: the FULL recipient list (WHO got it).
  multi: wrapPaneEnvelope(SENDER, "dev-driver@v-openrig-build", "coordinate the three of you.", HOST, {
    stampISO: STAMP,
    scope: { kind: "multi", recipients: ["dev-driver@v-openrig-build", "dev-guard@v-openrig-build", "dev-qa@v-openrig-build"] },
  }),
  // A rig-broadcast — "broadcast to <rig> (N seats)" scale line (a recipient knows peers have it).
  "rig-broadcast": wrapPaneEnvelope(SENDER, "openrig-pm", "checkpoint review complete.", HOST, {
    stampISO: STAMP,
    scope: { kind: "rig-broadcast", rig: "openrig-pm", seats: 11 },
  }),
  // A topology-broadcast — "broadcast to topology".
  topology: wrapPaneEnvelope(SENDER, "*", "system maintenance in 5 minutes.", HOST, {
    stampISO: STAMP,
    scope: { kind: "topology" },
  }),
};

const manifest = [];
const toLines = [];
for (const [name, text] of Object.entries(captures)) {
  writeFileSync(join(OUT, `${name}.txt`), text + "\n");
  manifest.push(`${createHash("sha256").update(text + "\n").digest("hex")}  ${name}.txt`);
  toLines.push(text.split("\n").find((l) => l.startsWith("To:")));
}
// Storm test: the four To lines must be mutually distinct (header-alone distinguishability).
const distinct = new Set(toLines).size === 4;
writeFileSync(join(OUT, "SHA256SUMS"), manifest.join("\n") + "\n");
writeFileSync(join(OUT, "STORM-TEST.txt"), `STORM TEST: ${distinct ? "PASS" : "FAIL"} — 4 distinct To lines (header-alone distinguishable)\n` + toLines.join("\n") + "\n");
console.log(`captured 4 send-header envelopes → ${OUT}`);
console.log(`STORM TEST: ${distinct ? "PASS" : "FAIL"}`);
console.log(toLines.join("\n"));
console.log("\n" + captures["rig-broadcast"]);
