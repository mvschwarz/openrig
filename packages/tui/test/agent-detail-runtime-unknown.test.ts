// LEG-7 LOW 2 — dead-arm cleanup (fold-wave qitem 79159e6f). The icon-fix QA (5a70e200, review50-r1)
// found the agent-detail runtime field's `?? "— (not served)"` placeholder is UNREACHABLE via the
// production API: the daemon coerces a null runtime to the string "unknown" BEFORE it crosses the wire
// (whoami-service.ts and siblings), so render.ts never sees a null runtime. Repoint the defensive
// fallback to "unknown" to MATCH that coercion — honest (what actually renders), kills the misleading
// dead "— (not served)" arm, and PINS the previously-unpinned null-runtime case (the icon-fix guard's
// standing advisory).
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

describe("agent-detail runtime fallback = daemon-consistent `unknown`, never the dead `— (not served)` (LEG-7 LOW 2)", () => {
  it("an agent whose runtime is absent renders `runtime: unknown` — never `— (not served)`", () => {
    const snap = structuredClone(demoSnapshot()) as FleetSnapshot;
    // Force the absent-runtime case the type forbids but the defensive arm handles (the daemon would
    // have already coerced it to "unknown"; here we drive the render layer directly).
    const agent = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    (agent as { runtime?: string }).runtime = undefined;

    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({
      type: "drill",
      resource: "agent",
      name: agent.name,
      target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
    });
    const lines = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines;
    // Scope to the RUNTIME line only — the sibling `cwd:` field legitimately renders "— (not served)"
    // for an absent working directory (a different, honest use of the placeholder we do NOT touch).
    const runtimeLine = lines.find((l) => l.includes("runtime:"))!;

    expect(runtimeLine).toMatch(/runtime:\s+unknown/); // matches the daemon's null→"unknown" coercion
    expect(runtimeLine).not.toContain("— (not served)"); // the misleading dead RUNTIME placeholder is gone
  });
});
