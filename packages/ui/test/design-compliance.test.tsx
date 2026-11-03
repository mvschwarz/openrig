import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC_DIR = resolve(__dirname, "../src");
const COMPONENTS_DIR = resolve(SRC_DIR, "components");

function readAllTsx(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readAllTsx(fullPath));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      results.push(readFileSync(fullPath, "utf-8"));
    }
  }
  return results;
}

describe("Design System Compliance", () => {
  // Test 1: border radius comes only from the --radius token scale — no non-zero
  // hardcoded radius in config, no inline borderRadius in source files
  it("border radius comes only from the --radius token scale", () => {
    const config = readFileSync(resolve(__dirname, "../tailwind.config.ts"), "utf-8");
    const radiusMatch = config.match(/borderRadius:\s*\{([^}]+)\}/);
    expect(radiusMatch).not.toBeNull();

    // All radius values derive from --radius (except `none: "0px"` and `full: "9999px"`)
    const pairs = [...radiusMatch![1]!.matchAll(/"?(\w+)"?:\s*"([^"]+)"/g)];
    for (const [, key, value] of pairs) {
      if (key === "full") expect(value).toBe("9999px");
      else if (key === "none") expect(value).toBe("0px");
      else expect(value).toContain("var(--radius)");
    }

    // No inline borderRadius in source files
    const allSource = readAllTsx(COMPONENTS_DIR);
    for (const src of allSource) {
      // Allow borderRadius: 0 or 0px, but not any positive value
      const inlineRadius = src.match(/borderRadius:\s*(\d+)/g) ?? [];
      for (const match of inlineRadius) {
        const value = parseInt(match.replace(/borderRadius:\s*/, ""), 10);
        expect(value).toBe(0);
      }
    }
  });

  // Test 2: All node status colors match design system mapping
  it("status color mapping matches design-system.md", async () => {
    const { getStatusColorClass } = await import("../src/lib/status-colors.js");

    expect(getStatusColorClass("running")).toBe("bg-success");
    expect(getStatusColorClass("idle")).toBe("bg-foreground-muted");
    expect(getStatusColorClass("exited")).toBe("bg-destructive");
    expect(getStatusColorClass("detached")).toBe("bg-warning");
    expect(getStatusColorClass(null)).toBe("bg-foreground-muted/50");
    expect(getStatusColorClass("unknown")).toBe("bg-foreground-muted/50");
  });

  // Test 3: Data displays use monospace font classes
  it("data display components use font-mono for IDs and values", () => {
    // Check key components that display data
    const rigCard = readFileSync(resolve(SRC_DIR, "components/RigCard.tsx"), "utf-8");
    expect(rigCard).toContain("font-mono");

    const snapshotPanel = readFileSync(resolve(SRC_DIR, "components/SnapshotPanel.tsx"), "utf-8");
    expect(snapshotPanel).toContain("font-mono");

    const rigNode = readFileSync(resolve(SRC_DIR, "components/RigNode.tsx"), "utf-8");
    expect(rigNode).toContain("font-mono");

    // V1 polish slice Phase 5.1 P5.1-1: NodeDetailPanel.tsx RETIRED;
    // canonical agent-detail surface is LiveNodeDetails.tsx now (which
    // also uses font-mono per the tactical aesthetic).
    const liveNodeDetails = readFileSync(resolve(SRC_DIR, "components/LiveNodeDetails.tsx"), "utf-8");
    expect(liveNodeDetails).toContain("font-mono");

    const importFlow = readFileSync(resolve(SRC_DIR, "components/ImportFlow.tsx"), "utf-8");
    expect(importFlow).toContain("font-mono");
  });
});
