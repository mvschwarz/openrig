import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SLOW_OUTPUT_CHUNKS } from "../src/adapters/stub-runner.js";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 items 6-8 — slow_output real-spawn observable: the WIRED runner renders
// the deterministic multi-part chunk sequence to a REAL pane (the production-identical
// "paced output" observable; orch ruling = deterministic chunking, no wall-clock). The
// hermetic executor test proves dispatch; this confirms the real process emits the
// chunks to stdout (closing the in-memory-hides-real-spawn gap for this path).

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@slow-output-e2e";

async function waitFor(pred: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner slow_output (real-spawn observable)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("renders the full deterministic chunk sequence to the pane, in order", async () => {
    dir = mkdtempSync(join(tmpdir(), "slow-output-e2e-"));
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    const script: StubScript = { steps: [{ kind: "emit", behavior: "slow_output" }] };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    let pane = "";
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "slow-1", "--posture", "floor"],
      { env: { ...process.env, OPENRIG_HOME: join(dir, ".openrig") } as NodeJS.ProcessEnv });
    child.stdout?.on("data", (d) => { pane += String(d); });

    // Wait until the last chunk has rendered (proves the whole sequence reached the pane).
    await waitFor(() => pane.includes(`slow_output chunk ${SLOW_OUTPUT_CHUNKS}/${SLOW_OUTPUT_CHUNKS}`));

    const indices = Array.from({ length: SLOW_OUTPUT_CHUNKS }, (_, i) =>
      pane.indexOf(`slow_output chunk ${i + 1}/${SLOW_OUTPUT_CHUNKS}`));
    for (const idx of indices) expect(idx).toBeGreaterThanOrEqual(0); // every chunk present
    // Ascending order in the real pane transcript.
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  }, 30_000);
});
