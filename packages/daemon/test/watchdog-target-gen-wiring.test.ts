import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// GHOST-STAGE (i-c) WIRING PIN. The fire-time target-generation gate in WatchdogPolicyEngine is INERT
// unless startup injects the REAL live-generation resolver — with resolveTargetGeneration absent the
// gate no-ops and a generation-bound wake fires at the successor (the dead-invalidator class). The
// engine is constructed deep in startup (not unit-constructable), so this pins the enable path at
// source: a drop of the wiring line fails HERE, before it can ship a silently-disabled gate.
describe("(i-c) wiring pin — startup injects the real target-generation resolver into the watchdog", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/startup.ts", import.meta.url)),
    "utf-8",
  );

  it("passes resolveTargetGeneration to the WatchdogPolicyEngine, wired to the live occupant-generation", () => {
    expect(src).toMatch(/resolveTargetGeneration:\s*\(s\)\s*=>\s*sessionRegistry\.currentOccupantGenerationForSession\(s\)/);
  });

  it("passes the queue's terminal-timer resolver to the pre-delivery seam", () => {
    expect(src).toMatch(
      /resolvePreDeliveryTerminalReason:\s*\(\{ jobId \}\)\s*=>\s*queueRepoInstance\.resolveWatchdogPreDeliveryTerminalReason\(jobId\)/,
    );
  });
});
