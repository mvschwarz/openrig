import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel } from "../src/crash-cart/crash-cart-model.js";

// Crash-cart C3 (SUB-3b) — renderScreen dispatches to the daemon-down screens on the resolved signal
// carried in RenderOptions. DOWN → the cockpit; UNVERIFIED → the distinct cannot-verify screen; absent
// (UP / normal) → the fleet views untouched. The cockpit is DOWN-only; UNVERIFIED never offers restore.

const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

describe("renderScreen — daemon-down dispatch", () => {
  it("DOWN → the crash-cart cockpit (RESTORE EVERYTHING + the daemon-down header)", () => {
    const body = renderScreen(view.get(), snap, { daemonState: "down", crashCart: demoCrashCartModel() }).lines.join("\n");
    expect(body).toContain("◌ daemon not running");
    expect(body).toContain("⏎ RESTORE EVERYTHING");
  });

  it("UNVERIFIED → the cannot-verify screen; NO restore offered", () => {
    const body = renderScreen(view.get(), snap, {
      daemonState: "unverified",
      daemonEvidence: { pidState: "alive (pid 7)", probeResult: "timeout", failedSignal: "healthz timed out" },
    }).lines.join("\n");
    expect(body).toContain("cannot verify the daemon");
    expect(body).toContain("alive (pid 7)");
    expect(body).not.toContain("RESTORE EVERYTHING");
  });

  it("absent daemonState (UP / normal) → the fleet views, no cockpit", () => {
    const body = renderScreen(view.get(), snap, {}).lines.join("\n");
    expect(body).not.toContain("RESTORE EVERYTHING");
    expect(body).not.toContain("cannot verify the daemon");
  });
});
