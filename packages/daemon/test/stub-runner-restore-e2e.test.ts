import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 items 6-8 — restore real-spawn observable: the WIRED runner TRIGGERS the
// real restore reader (compaction-restore-bridge.cjs) — arch R3: TRIGGER, never fabricate.
// A script that compacts THEN restores writes the seat-keyed restore-pending marker (via
// the real precompact seam) and then delivers it: the bridge injects ONE additionalContext
// restore directive (mirrored to the pane) and stamps deliveredAt/deliveryCount=1 on the
// marker (one-shot, deterministic under the injected clock). This closes the
// in-memory-hides-real-spawn gap for the final behavior + lights #2's seat-relaunch.

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@restore-e2e";
const CLOCK = "2026-08-06T12:00:00.000Z";
const sanitize = (v: string) => v.replace(/[^a-zA-Z0-9_.@-]/g, "_");

async function waitFor(pred: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner restore (real-spawn observable)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("compaction THEN restore: delivers the real additionalContext directive to the pane + stamps the marker deliveredAt (one-shot)", async () => {
    dir = mkdtempSync(join(tmpdir(), "restore-e2e-"));
    const home = join(dir, ".openrig");
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    // The final behavior needs a pending marker: compaction (the real precompact seam)
    // writes it, restore (the real bridge) delivers it — in one scripted turn.
    const script: StubScript = { steps: [{ kind: "emit", behavior: "compaction" }, { kind: "emit", behavior: "restore" }] };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    let pane = "";
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "restore-1", "--posture", "floor"],
      { env: { ...process.env, OPENRIG_HOME: home, OPENRIG_TEST_CLOCK_NOW: CLOCK } as NodeJS.ProcessEnv });
    child.stdout?.on("data", (d) => { pane += String(d); });

    // Wait until the injected restore directive has rendered to the pane (proves the real
    // bridge delivered the additionalContext, not a fabricated stub string).
    await waitFor(() => pane.includes("OpenRig compaction restore packet is available for this Claude session"));

    // The marker the precompact seam wrote (seat-keyed) was stamped by the bridge:
    // deliveredAt under the injected clock, deliveryCount exactly 1 (one-shot).
    const markerPath = join(home, "compaction", "restore-pending", `${sanitize(SEAT)}.json`);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.deliveredAt).toBe(CLOCK);
    expect(marker.deliveryCount).toBe(1);
  }, 30_000);
});
