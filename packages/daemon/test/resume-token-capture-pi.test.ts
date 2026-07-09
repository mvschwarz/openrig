// OPR.0.4.6.PI1 FR-6 — the Pi arm of the shared resume-token derive helper.
//
// The guard-fold regression this pins: before PI-1, a Pi runtime dead-ended at
// the derive helper's defensive noop, and even with a derived token the
// one-size id-shape validator rejected every path-shaped token — so the
// capture path failed SOFT (skip) and a Pi seat would run fine but never
// persist resume state. These tests assert the path now CAPTURES a valid Pi
// session-file path (not skips), and that validation failures stay honest
// skips with no token fabrication.

import { describe, it, expect } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";

const SESSION = "devpi-seat@some-rig";
const VALID_FILE = "/Users/someone/.openrig/state/pi/seat-a/sessions/2026-07-06T10-00-00_0197a2f0.jsonl";

function piStore(result: { ok: true; sessionFile: string } | { ok: false; reason: string }) {
  return {
    readSessionFile: (sessionName: string) => {
      expect(sessionName).toBe(SESSION);
      return result;
    },
  };
}

describe("deriveResumeToken — pi", () => {
  it("CAPTURES (not skips) a valid absolute .jsonl session-file path", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: VALID_FILE }) },
    );
    expect(r.outcome).toBe("captured");
    if (r.outcome === "captured") {
      expect(r.resumeType).toBe("pi_session_file");
      expect(r.token).toBe(VALID_FILE);
    }
  });

  it("trims whitespace from the sidecar value before validating", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: `  ${VALID_FILE}\n` }) },
    );
    expect(r.outcome).toBe("captured");
    if (r.outcome === "captured") expect(r.token).toBe(VALID_FILE);
  });

  it("is a silent noop when the pi runner-state dep is absent (older wiring / test)", async () => {
    const r = await deriveResumeToken({ runtime: "pi", sessionName: SESSION }, {});
    expect(r.outcome).toBe("noop");
  });

  it("skips honestly when the runner-state sidecar is missing", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: false, reason: "missing_sidecar" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });

  it("maps a sidecar parse failure to the parse_error skip reason", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: false, reason: "parse_error" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "parse_error" });
  });

  it("skips (never persists) a malformed session-file value — relative path", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: "sessions/relative.jsonl" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });

  it("skips an empty sidecar value as missing, never validating emptiness into a write", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: "   " }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });
});
