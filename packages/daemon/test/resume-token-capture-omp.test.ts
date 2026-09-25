import { describe, expect, it } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";

const sessionName = "qa-worker@omp-rig";
const sessionFile = "/openrig/state/omp/qa-worker@omp-rig/sessions/2026-09-24_id.jsonl";

describe("OMP adoption resume token capture", () => {
  it("uses the OMP sidecar and never the Pi sidecar", async () => {
    const result = await deriveResumeToken(
      { runtime: "omp", sessionName },
      {
        ompRunnerStateStore: { readSessionFile: (name) => {
          expect(name).toBe(sessionName);
          return { ok: true, sessionFile };
        } },
        piRunnerStateStore: { readSessionFile: () => { throw new Error("Pi sidecar must not be read"); } },
      },
    );
    expect(result).toEqual({ outcome: "captured", resumeType: "omp_session_file", token: sessionFile });
  });

  it("refuses a malformed OMP sidecar token instead of persisting it", async () => {
    const result = await deriveResumeToken(
      { runtime: "omp", sessionName },
      { ompRunnerStateStore: { readSessionFile: () => ({ ok: true, sessionFile: "sessions/relative.jsonl" }) } },
    );
    expect(result).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });
});
