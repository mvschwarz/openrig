import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("W4 production wiring", () => {
  it("constructs one decision store and shares it with the enforcer and routes", () => {
    const startup = readFileSync(join(here, "../src/startup.ts"), "utf8");
    const server = readFileSync(join(here, "../src/server.ts"), "utf8");

    expect(startup).toContain('import("./domain/enforcer-decision-store.js")');
    expect(startup.match(/new EnforcerDecisionStore\(/g)).toHaveLength(1);
    expect(startup).toMatch(/decisionStore:\s*enforcerDecisionStore/);
    expect(startup).toMatch(/deps\.enforcerDecisionStore\s*=\s*enforcerDecisionStore/);

    expect(server).toMatch(/enforcerDecisionStore\?:\s*import\("\.\/domain\/enforcer-decision-store\.js"\)\.EnforcerDecisionStore/);
    expect(server).toContain('c.set("enforcerDecisionStore" as never, deps.enforcerDecisionStore)');
    expect(server).toContain("compactionRoutes");
  });
});
