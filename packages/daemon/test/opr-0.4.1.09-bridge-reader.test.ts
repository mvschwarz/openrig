// OPR.0.4.1.09 (part 2b — reader side): the compaction-restore bridge resolves ONLY this
// seat's keyed marker. The previous fallback-to-newest handed a seat with NO marker the
// NEWEST marker on disk — which can be ANOTHER seat's restore state (the reader-side
// parallel of the part-1 wrong-seat extra bug). No seat identity / no keyed marker -> no
// delivery (absence = the loud JSONL fallback the restore prompt already describes), never
// a wrong-seat guess. The bridge also surfaces the per-seat restoreMapPath the PreCompact
// writer (precompact-hook.mjs) recorded. Spawn-based to match how Claude invokes the hook.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, "..", "assets", "plugins", "openrig-core", "hooks", "scripts", "compaction-restore-bridge.cjs");
const SEAT = "test-seat@kernel";

function runBridge(home: string, input: Record<string, unknown>, seat: string = SEAT) {
  const result = spawnSync(process.execPath, [BRIDGE], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: seat, RIGGED_HOME: undefined } as NodeJS.ProcessEnv,
  });
  return { stdout: result.stdout || "", status: result.status };
}

function writeMarker(home: string, seat: string, data: Record<string, unknown>) {
  const p = join(home, "compaction", "restore-pending", `${seat}.json`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

let tmpDir: string;
let home: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "opr0419-bridge-")); home = join(tmpDir, ".openrig"); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe("OPR.0.4.1.09 part 2b — bridge reader resolves ONLY this seat's marker (never wrong-seat)", () => {
  it("REGRESSION: a seat with NO marker + a DIFFERENT seat's marker on disk -> NOT delivered (no newest-fallback)", () => {
    // Only the OTHER seat's marker exists; the resolving seat (test-seat@kernel) has none.
    writeMarker(home, "advisor-lead@kernel", {
      version: 1, sessionName: "advisor-lead@kernel", outputDir: "/tmp/x", deliveryCount: 0,
    });
    const { stdout } = runBridge(home, { hook_event_name: "UserPromptSubmit" });
    // Pre-fix the newest-fallback delivered advisor's marker; now: no delivery.
    expect(stdout.trim()).toBe("");
  });

  it("defense-in-depth: refuses this seat's keyed marker when its sessionName declares a DIFFERENT seat", () => {
    writeMarker(home, SEAT, {
      version: 1, sessionName: "advisor-lead@kernel", outputDir: "/tmp/x", deliveryCount: 0,
    });
    const { stdout } = runBridge(home, { hook_event_name: "UserPromptSubmit" });
    expect(stdout.trim()).toBe("");
  });

  // R5 marker-lifecycle (P6-3), STALE-FIRING-premise-false face: deliver-once is not
  // enough — a not-yet-delivered marker written for a DIFFERENT compaction (its own
  // transcriptPath/session identity) must NOT fire for the current session. Bind the
  // fire to EVENT+IDENTITY, not recency.
  it("STALE-FIRING (R5): a not-yet-delivered marker for a DIFFERENT compaction/session is NOT fired for the current start", () => {
    writeMarker(home, SEAT, {
      version: 1, sessionName: SEAT, sessionId: "sess-A", transcriptPath: "/t/sess-A.jsonl",
      outputDir: "/tmp/x", deliveryCount: 0, deliveredAt: null,
    });
    // Same seat, but the current start is a DIFFERENT session/compaction — the marker's premise is false.
    const { stdout } = runBridge(home, { hook_event_name: "UserPromptSubmit", session_id: "sess-B", transcript_path: "/t/sess-B.jsonl" });
    expect(stdout.trim()).toBe(""); // must NOT fire stale content
  });

  it("delivers THIS seat's marker once and surfaces the restoreMapPath the writer recorded (idempotent)", () => {
    const restoreMapPath = join(home, "compaction", "post-compact-extra", `${SEAT}.md`);
    writeMarker(home, SEAT, {
      version: 1, sessionName: SEAT,
      outputDir: "/tmp/claude-compaction-restore/sess-x",
      expectedAck: "restored from packet at <path>; resumed at step <X>",
      postCompactInstruction: "",
      restoreMapPath,
      deliveryCount: 0, deliveredAt: null,
    });
    const first = runBridge(home, { hook_event_name: "UserPromptSubmit" });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("additionalContext");
    expect(first.stdout).toContain("Per-seat restore map");
    expect(first.stdout).toContain(`${SEAT}.md`);
    const second = runBridge(home, { hook_event_name: "UserPromptSubmit" });
    expect(second.stdout.trim()).toBe(""); // deliver-once (deliveryCount > 0)
  });

  it("omits the restore-map line when the marker has no restoreMapPath (back-compat)", () => {
    writeMarker(home, SEAT, {
      version: 1, sessionName: SEAT, outputDir: "/tmp/claude-compaction-restore/sess-y",
      deliveryCount: 0, deliveredAt: null,
    });
    const { stdout } = runBridge(home, { hook_event_name: "UserPromptSubmit" });
    expect(stdout).toContain("additionalContext");
    expect(stdout).not.toContain("Per-seat restore map");
  });
});
