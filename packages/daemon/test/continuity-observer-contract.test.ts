import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(import.meta.dirname, path), "utf8");
}

describe("S20 P5 current-occupant observer contract", () => {
  it("has one generation mint definition, two reservation callers, two injectors, and one faithful relay", () => {
    const registry = source("../src/domain/session-registry.ts");
    const launcher = source("../src/domain/node-launcher.ts");
    const handover = source("../src/domain/seat-handover-service.ts");
    const successor = source("../src/domain/successor-session-launcher.ts");
    const relay = source("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");

    expect(registry.match(/reserveOccupantGeneration\(\):/g)).toHaveLength(1);
    expect(launcher.match(/reserveOccupantGeneration\(\)/g)).toHaveLength(1);
    expect(handover.match(/reserveOccupantGeneration\(\)/g)).toHaveLength(1);
    expect(launcher).toMatch(/OPENRIG_OCCUPANT_GENERATION:\s*occupantGeneration/);
    expect(successor).toMatch(/OPENRIG_OCCUPANT_GENERATION:\s*input\.occupantGeneration/);
    expect(relay).toMatch(/const generation = firstString\(env\.OPENRIG_OCCUPANT_GENERATION/);
    expect(relay).toMatch(/generation,/);
  });

  it("persists the successor pane at commit and the reconciler rereads that canonical column", () => {
    const handover = source("../src/domain/seat-handover-service.ts");
    const reconciler = source("../src/domain/seat-identity-reconciler.ts");

    expect(handover).toMatch(/UPDATE bindings[\s\S]*tmux_pane = \?/);
    expect(reconciler).toMatch(/b\.tmux_pane as tmux_pane/);
    expect(reconciler).toMatch(/getPanePid\(seat\.tmux_pane\)/);
  });
});
