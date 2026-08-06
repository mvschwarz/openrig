import { describe, it, expect, vi } from "vitest";
import { crashCartCommand, type CrashCartEmit } from "../src/commands/crash-cart.js";

// Crash-cart C3 unit-B — the `rig crash-cart --json` verb (coupling ruling C, 4 rails). It prints ONE
// JSON = emitCrashCartState's verdict (read-only). A fail-closed refusal still prints STRUCTURED JSON
// (never exit-code-only). emit + write are injected → the action is deterministic; the real-dep
// assembly is glue proven by the real daemon-down run.

function run(emit: () => Promise<CrashCartEmit>) {
  const write = vi.fn();
  const cmd = crashCartCommand({ emit, write });
  return { write, done: cmd.parseAsync(["--json"], { from: "user" }) };
}

describe("crashCartCommand — prints the emit verdict as ONE JSON", () => {
  it("UP → JSON {state:'up'}", async () => {
    const { write, done } = run(async () => ({ state: "up" }));
    await done;
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ state: "up" });
  });

  it("DOWN → JSON with the discovery", async () => {
    const emit: CrashCartEmit = { state: "down", discovery: { header: { lastActivityAt: null, lastBootAt: null, firstBootAt: null, hostId: null, stopReason: null, priorUptimeMs: null }, foundOnHost: [], whereWorkStopped: [] } };
    const { write, done } = run(async () => emit);
    await done;
    expect(JSON.parse(write.mock.calls[0][0])).toEqual(emit);
  });

  it("DOWN + refusal → STRUCTURED JSON (refusal note, no discovery); still printed, not exit-code-only", async () => {
    const { write, done } = run(async () => ({ state: "down", refusal: "a daemon answered /healthz — refusing" }));
    await done;
    const out = JSON.parse(write.mock.calls[0][0]);
    expect(out.state).toBe("down");
    expect(out.refusal).toContain("refusing");
    expect(out.discovery).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("UNVERIFIED → JSON with the evidence", async () => {
    const { write, done } = run(async () => ({ state: "unverified", evidence: { pidState: "alive", probeResult: "timeout", failedSignal: "healthz timed out" } }));
    await done;
    expect(JSON.parse(write.mock.calls[0][0]).evidence.probeResult).toBe("timeout");
  });
});
