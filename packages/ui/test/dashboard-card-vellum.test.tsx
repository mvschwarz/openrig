import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dashboardCardSurfaceClass } from "../src/components/dashboard/cards/card-surface.js";

describe("Dashboard card vellum surface", () => {
  it("uses a shared translucent vellum body across all six dashboard cards", () => {
    const srcRoot = path.resolve(__dirname, "../src/components/dashboard/cards");
    const cardFiles = [
      "TopologyCard.tsx",
      "ProjectCard.tsx",
      "ForYouCard.tsx",
      "SpecsCard.tsx",
      "SearchCard.tsx",
      "SettingsCard.tsx",
    ];

    expect(dashboardCardSurfaceClass).toContain("bg-white/40");
    expect(dashboardCardSurfaceClass).toContain("backdrop-blur-[8px]");
    expect(dashboardCardSurfaceClass).toContain("hover:bg-white/50");
    expect(dashboardCardSurfaceClass).toContain("hover:hard-shadow-hover");

    for (const file of cardFiles) {
      const source = readFileSync(path.join(srcRoot, file), "utf8");
      expect(source).toContain("dashboardCardSurfaceClass");
      expect(source).not.toContain('className="h-full hover:hard-shadow-hover"');
    }
  });
});
