#!/usr/bin/env node
/*
 * slice-07 R6 — seed fixture context-library generator.
 *
 * Writes minimal context packs at the canonical refs the eval cases select among, so a LIVE eval
 * run has a real library to pull from. Derived output (regenerate; never hand-edit under fixtures/).
 * Real production content ships via R2 packaging; this is the dev/eval mirror. The live provider
 * points a spawned seat's config-resolved packs root (OPENRIG_CONTEXT_PACKS_ROOT) at fixtures/.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures");

// ref = library path (ns/name); the pack dir sits at fixtures/<ref>/, served at that ref.
const ENTRIES = [
  { ref: "core/rig-lifecycle", purpose: "bring rigs and the whole fleet up/down/back", teaches: "For a whole-box bring-back after a reboot, use `rig start` (not per-rig `rig up`)." },
  { ref: "core/topology-mutation-and-seat-management", purpose: "replace a seat's occupant without losing the address", teaches: "Swap an occupant with `rig handover <seat>` — the seat, name, edges and queue stay put." },
  { ref: "core/agent-startup-and-context-ingestion", purpose: "orient a freshly-woken seat", teaches: "Run `rig whoami --json` first; it is ground truth for who and where you are." },
  { ref: "core/watchdog", purpose: "arm a wake you cannot perform yourself", teaches: "You cannot wake yourself; arm `rig watchdog register --spec <yaml>` before you stop." },
  { ref: "core/cross-host-rig-commands", purpose: "reach agents on other machines", teaches: "Address a remote seat bare plus `--host <id>` (see `rig host ls`)." },
  { ref: "core/rig-bundles-and-shareable-artifacts", purpose: "package a rig for a machine that never had the source", teaches: "Build a portable rig with `rig bundle create`; install with `rig bundle install`." },
  { ref: "core/openrig-upgrade", purpose: "upgrade a running daemon without downtime", teaches: "Use the sidecar-operator upgrade path so the rig stays up while the daemon upgrades." },
  { ref: "process/systematic-debugging", purpose: "chase a failure methodically", teaches: "Instrument every boundary once and read where it actually breaks — one run beats five hypotheses." },
  { ref: "core/attention-queue", purpose: "see who actually holds the baton", teaches: "Triage by baton, not by count; `rig queue transitions <id>` shows a park vs a strand." },
  { ref: "process/writing-plans", purpose: "write a plan before building", teaches: "State the problem and intent, not the steps; separate DECIDED from OPEN." },
  // distractors — present so selection is a real choice, not a singleton
  { ref: "core/human-in-the-loop", purpose: "when and how to reach the human", teaches: "Reach the human by exception; orchestrators use discretion, others route through them." },
  { ref: "pm/requirements-writer", purpose: "turn intent into requirements", teaches: "Proportional structured requirements — three capture points, elastic middle." },
  { ref: "process/test-driven-development", purpose: "red-first discipline", teaches: "A failing test per chunk; if you cannot show it red, it is not a check." },
];

rmSync(ROOT, { recursive: true, force: true });
for (const e of ENTRIES) {
  const dir = join(ROOT, e.ref);
  mkdirSync(dir, { recursive: true });
  const name = e.ref.split("/").pop();
  const manifest = `name: ${name}\nversion: "1"\npurpose: "(eval fixture) ${e.purpose}"\nfiles:\n  - path: content.md\n    role: source\n`;
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  writeFileSync(join(dir, "content.md"), `# ${e.ref}\n\n${e.purpose}\n\n${e.teaches}\n`);
}
console.log(`wrote ${ENTRIES.length} fixture packs under ${ROOT}`);
