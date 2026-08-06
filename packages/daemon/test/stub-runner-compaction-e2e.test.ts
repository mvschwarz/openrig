import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStubTranscript } from "../src/adapters/stub-runner.js";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 items 6-8 — R1 real-spawn proof: the WIRED runner executes a scenario
// script and its `emit compaction` step FIRES the exact shipped precompact seam,
// producing a REAL seat-keyed restore-pending marker + packet (arch R3: TRIGGER,
// never fabricate). The hermetic executor test proves dispatch; this proves the wired
// process really authors its own transcript, fires the real seam, and idles — closing
// the in-memory-hides-real-spawn gap (a mocked loop can't prove a real subprocess fires).

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";
const SEAT = "dev-worker@compaction-e2e";
// sanitizeKey mirror (precompact-hook.mjs / stub-compaction.ts): the marker key.
const SANITIZED = SEAT.replace(/[^a-zA-Z0-9_.@-]/g, "_");

async function waitForFile(p: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(p)) return;
    if (Date.now() > deadline) throw new Error(`file not produced within ${timeoutMs}ms: ${p}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("buildStubTranscript (the stub authors its OWN session transcript)", () => {
  it("emits valid JSONL — one parseable record per say step, keyed to the seat + cwd", () => {
    const script: StubScript = {
      steps: [
        { kind: "say", text: "first line" },
        { kind: "emit", behavior: "compaction" },
        { kind: "say", text: "second line" },
      ],
    };
    const jsonl = buildStubTranscript(script, { sessionName: SEAT, cwd: "/managed/cwd", sessionId: "stub-e2e" });
    const records = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    // At least one record per say step, each a real transcript-shaped line.
    const texts = records.map((r) => String(r.message?.content ?? ""));
    expect(texts.some((t) => t.includes("first line"))).toBe(true);
    expect(texts.some((t) => t.includes("second line"))).toBe(true);
    for (const r of records) expect(r.cwd).toBe("/managed/cwd");
  });

  it("never emits an empty transcript (analyze needs ≥1 record) even for an emit-only script", () => {
    const jsonl = buildStubTranscript({ steps: [{ kind: "emit", behavior: "compaction" }] },
      { sessionName: SEAT, cwd: "/c", sessionId: "s" });
    const lines = jsonl.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});

describe("stub-runner compaction behavior (real-spawn wiring, R1)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("fires the REAL precompact seam on `emit compaction`, writing a seat-keyed marker + packet", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-compaction-e2e-"));
    const home = join(dir, ".openrig");
    // Drop the scenario-resolved script the runner will load from cwd.
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    const script: StubScript = {
      steps: [
        { kind: "say", text: "[stub] scripted turn before compaction" },
        { kind: "emit", behavior: "compaction" },
      ],
    };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "cmp-1", "--posture", "floor"],
      { env: { ...process.env, OPENRIG_HOME: home, OPENRIG_TEST_CLOCK_NOW: INJECTED_ISO } as NodeJS.ProcessEnv });

    const markerPath = join(home, "compaction", "restore-pending", `${SANITIZED}.json`);
    await waitForFile(markerPath);

    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    // A REAL seam wrote it: keyed to the seat, clock honored, packet generated.
    expect(marker.sessionName).toBe(SEAT);
    expect(marker.createdAt).toBe(INJECTED_ISO);
    expect(existsSync(marker.outputDir)).toBe(true);
    // The seam compacted the stub's OWN authored transcript — NOT a foreign one
    // discovered under ~/.claude/projects (findLatestJsonl's real-HOME fallback).
    // On the discovery path input.transcript_path is unset and the marker records
    // transcriptPath:null; asserting the explicit own path kills that false green.
    expect(marker.transcriptPath).toBe(join(dir!, ".openrig", "stub", "transcript.jsonl"));
  }, 30_000);
});
