import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fireCompaction, StubCompactionError } from "../src/adapters/stub-compaction.js";

// Slice 51-01 items 6-8 — the stub COMPACTION behavior TRIGGERS the exact shipped seam.
//
// PRD §4.3/§4.4 (arch R3): the stub does NOT fabricate compaction outputs — it FIRES the
// real precompact-hook.mjs, which writes the seat-keyed restore-pending marker the real
// compaction-restore-bridge later delivers. This is the production-identical observable:
// a real marker on disk keyed to the seat, deterministic under the injected clock. The
// runner (a real-spawn caller) invokes fireCompaction on an `emit compaction` step.
//
// These tests spawn the REAL shipped hook (the class-fix floor) with an isolated
// OPENRIG_HOME + a controlled transcript so the packet + stamps are deterministic.

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE, "..", "assets", "plugins", "openrig-core",
  "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs",
);
const SEAT = "dev-worker@compaction-scn";
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

function writeFixtureJsonl(dir: string): string {
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, `${JSON.stringify({
    sessionId: "fixture-sess",
    cwd: dir,
    message: { role: "user", content: "hello from the compaction fixture" },
  })}\n`, "utf8");
  return p;
}

describe("stub compaction behavior fires the real precompact seam", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stub-compaction-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a REAL seat-keyed restore-pending marker (never a fabricated output)", () => {
    const jsonl = writeFixtureJsonl(tmpDir);
    const result = fireCompaction({
      hookScriptPath: HOOK_SCRIPT,
      sessionName: SEAT,
      openrigHome,
      cwd: tmpDir,
      transcriptPath: jsonl,
    });
    expect(existsSync(result.markerPath)).toBe(true);
    // Keyed to THIS seat (sanitized) under the shipped restore-pending dir.
    expect(result.markerPath).toBe(join(openrigHome, "compaction", "restore-pending", `${SEAT}.json`));
    const marker = JSON.parse(readFileSync(result.markerPath, "utf8"));
    expect(marker.sessionName).toBe(SEAT);
    // The packet the real seam generated actually exists (restore-from-jsonl ran).
    expect(existsSync(marker.outputDir)).toBe(true);
  });

  it("is deterministic under the injected clock (byte-identical stamps across a double-run)", () => {
    const readStamps = (): { createdAt: unknown; outStamp: string | undefined } => {
      const dir = mkdtempSync(join(tmpdir(), "stub-compaction-det-"));
      const home = join(dir, ".openrig");
      const jsonl = writeFixtureJsonl(dir);
      const result = fireCompaction({
        hookScriptPath: HOOK_SCRIPT, sessionName: SEAT, openrigHome: home, cwd: dir,
        transcriptPath: jsonl, injectClockNow: INJECTED_ISO,
      });
      const marker = JSON.parse(readFileSync(result.markerPath, "utf8"));
      const out = { createdAt: marker.createdAt, outStamp: String(marker.outputDir).split("/").pop() };
      rmSync(dir, { recursive: true, force: true });
      return out;
    };
    const a = readStamps();
    const b = readStamps();
    expect(a).toEqual(b);
    expect(a.createdAt).toBe(INJECTED_ISO);
    expect(String(a.outStamp)).toContain(INJECTED_ISO.replace(/[:.]/g, "-"));
  });

  it("fails FAST when the shipped hook script is absent (HIGH-6 existence contract, never a silent skip)", () => {
    expect(() => fireCompaction({
      hookScriptPath: join(tmpDir, "no-such-precompact-hook.mjs"),
      sessionName: SEAT,
      openrigHome,
      cwd: tmpDir,
    })).toThrow(StubCompactionError);
  });
});
