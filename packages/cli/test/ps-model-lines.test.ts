import { describe, it, expect } from "vitest";
import { modelLines } from "../src/commands/ps.js";

// #1680: a runtime without a model reader gets one summary line, not one UNKNOWN line per seat.
describe("rig ps — model lines", () => {
  const unsupported = { status: "unknown", model: null, source: null, observedAt: null, generation: "current", reason: "unsupported-runtime" };
  const seat = (name: string, runtime: string, model: string | null, observation: unknown = unsupported) =>
    ({ canonicalSessionName: name, runtime, model, sessionStatus: "running", modelObservation: observation });

  it("collapses a runtime's seats without a model reader into one line that keeps every configured model", () => {
    const lines = modelLines([
      seat("a@k", "omp", "anthropic/claude-opus-5-5:high"),
      seat("b@k", "omp", "anthropic/claude-opus-5-5:low"),
      seat("c@k", "omp", "anthropic/claude-opus-5-5:high"),
    ] as never);
    expect(lines).toEqual([
      "Model (3 omp seats): last observed UNKNOWN (unsupported-runtime: no model reader for omp); configured anthropic/claude-opus-5-5:high ×2, anthropic/claude-opus-5-5:low",
    ]);
  });

  it("labels accepted runner models as reported samples, including the existing community identifier grammar", () => {
    const lines = modelLines([seat("runner@k", "synth", "configured", { status: "observed", model: "provider/会話?model=1", source: "runner_reported",
      observedAt: "2026-10-21T10:00:00Z", generation: "current", reason: null })] as never);
    expect(lines).toEqual(["Model (runner@k): configured configured; last observed provider/会話?model=1 (runner-reported; sample 2026-10-21T10:00:00Z)"]);
  });

  it("keeps one line per seat for a lone seat, and for seats whose runtime has a model reader", () => {
    const observed = { status: "observed", model: "claude-opus-5-5", source: "claude-assistant-response", observedAt: "2026-10-21T10:00:00Z", generation: "current", reason: null };
    const lines = modelLines([
      seat("h@k", "terminal", null),
      seat("x@k", "claude-code", "claude-opus-5-5", observed),
      seat("y@k", "codex", "gpt-5.5", { ...unsupported, reason: "model-record-unavailable" }),
    ] as never);
    expect(lines).toEqual([
      "Model (h@k): configured not-declared; last observed UNKNOWN (unsupported-runtime)",
      "Model (x@k): configured claude-opus-5-5; last observed claude-opus-5-5 (claude-assistant-response; native record 2026-10-21T10:00:00Z)",
      "Model (y@k): configured gpt-5.5; last observed UNKNOWN (model-record-unavailable)",
    ]);
  });
});
