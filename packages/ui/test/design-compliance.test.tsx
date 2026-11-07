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

  // Test 4: Clean theme tokens meet WCAG AA contrast ratio (>= 4.5:1) on white ground
  it("Clean theme tokens meet WCAG AA contrast ratio (>= 4.5:1) on white ground", () => {
    function parseHsl(hslStr: string): [number, number, number] {
      const parts = hslStr.trim().split(/\s+/).map((p) => parseFloat(p));
      return [parts[0], parts[1], parts[2]];
    }
    function hslToRgb(h: number, s: number, l: number): [number, number, number] {
      s /= 100;
      l /= 100;
      const k = (n: number) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
    }
    function lum([r, g, b]: [number, number, number]): number {
      const a = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    }
    function contrast(rgb1: [number, number, number], rgb2: [number, number, number]): number {
      const l1 = lum(rgb1);
      const l2 = lum(rgb2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    const globalsCss = readFileSync(resolve(__dirname, "../src/globals.css"), "utf-8");
    const rootMatches = [...globalsCss.matchAll(/:root\s*\{([\s\S]*?)\}/g)];
    expect(rootMatches.length).toBeGreaterThan(0);
    const cleanThemeRoot = rootMatches[rootMatches.length - 1][1];

    const successMatch = cleanThemeRoot.match(/--success:\s*([^;]+);/);
    const warningMatch = cleanThemeRoot.match(/--warning:\s*([^;]+);/);

    expect(successMatch).not.toBeNull();
    expect(warningMatch).not.toBeNull();

    const successRgb = hslToRgb(...parseHsl(successMatch![1]));
    const warningRgb = hslToRgb(...parseHsl(warningMatch![1]));
    const white: [number, number, number] = [255, 255, 255];

    expect(contrast(successRgb, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warningRgb, white)).toBeGreaterThanOrEqual(4.5);
  });
});
