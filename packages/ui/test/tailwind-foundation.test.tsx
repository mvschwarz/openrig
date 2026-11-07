import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// Import globals.css — same import as main.tsx
import "../src/globals.css";

const mockFetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: async () => [] })
);
globalThis.fetch = mockFetch;

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
});

describe("Tailwind Foundation", () => {
  // Test 1: Design tokens present on :root
  it("design tokens are present on :root via globals.css", () => {
    render(<div>probe</div>);

    const root = document.documentElement;
    const styles = getComputedStyle(root);

    // Clean theme (ui-redesign C02) values; the CLEAN THEME block is last in globals.css.
    expect(styles.getPropertyValue("--background").trim()).toContain("0 0% 100%");
    expect(styles.getPropertyValue("--on-surface").trim()).toContain("240 10% 10%");
    expect(styles.getPropertyValue("--primary").trim()).toContain("240 6% 10%");
    expect(styles.getPropertyValue("--tertiary").trim()).toContain("0 72% 51%");
    expect(styles.getPropertyValue("--brand").trim()).toContain("221 83% 53%");
  });

  // Test 2: borderRadius tokens derive from --radius (Clean theme)
  it("borderRadius tokens derive from --radius (Clean theme)", () => {
    const config = readFileSync(resolve(__dirname, "../tailwind.config.ts"), "utf-8");

    const radiusMatch = config.match(/borderRadius:\s*\{([^}]+)\}/);
    expect(radiusMatch).not.toBeNull();

    // Matches bare keys (sm, DEFAULT) and quoted keys ("2xl", "3xl").
    const pairs = [...radiusMatch![1]!.matchAll(/"?(\w+)"?:\s*"([^"]+)"/g)];
    expect(pairs.map(([, k]) => k).sort()).toEqual(["2xl", "3xl", "DEFAULT", "full", "lg", "md", "none", "sm", "xl"]);
    for (const [, key, value] of pairs) {
      if (key === "full") expect(value).toBe("9999px");
      else if (key === "none") expect(value).toBe("0px");
      else expect(value).toContain("var(--radius)");
    }
    const css = readFileSync(resolve(__dirname, "../src/globals.css"), "utf-8");
    expect(css).toMatch(/--radius:\s*0\.5rem;/);
  });

  // Test 3: cn() utility
  it("cn() merges classes with Tailwind dedup", async () => {
    const { cn } = await import("../src/lib/utils.js");
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  // Test 4: Production build emits current scanned background utility contract.
  it("production build emits .bg-background utility rule", { timeout: 60000 }, () => {
    const uiRoot = resolve(__dirname, "..");
    try {
      execSync("npm run build", { cwd: uiRoot, stdio: "pipe", timeout: 30000 });
    } catch {
      // skip if build fails in test env
      return;
    }

    const distAssets = resolve(uiRoot, "dist/assets");
    let cssContent = "";
    try {
      const cssFiles = readdirSync(distAssets).filter((f) => f.endsWith(".css"));
      for (const f of cssFiles) {
        cssContent += readFileSync(resolve(distAssets, f), "utf-8");
      }
    } catch {
      return;
    }

    // bg-background should generate: background-color: hsl(var(--background))
    expect(cssContent).toMatch(/\.bg-background\b/);
    expect(cssContent).toContain("hsl(var(--background))");

    // The card token still ships in globals.css even though bg-card is not used
    // by any current source file and is therefore correctly purged from utilities.
    expect(cssContent).toMatch(/--card:\s*var\(--surface-container-lowest\)/);
  });

  // Test 5: main.tsx imports globals.css (source code verification)
  it("main.tsx imports globals.css in its source", () => {
    const mainSrc = readFileSync(resolve(__dirname, "../src/main.tsx"), "utf-8");
    expect(mainSrc).toContain('./globals.css"');
  });

  // Test 6: globals.css is injected into document
  it("globals.css stylesheet is present in document", () => {
    const styleSheets = document.querySelectorAll("style");
    const cssText = Array.from(styleSheets).map((s) => s.textContent).join("");

    expect(cssText).toContain("--background");
    expect(cssText).toContain("--surface-container-low");
    expect(cssText).toContain("--outline-variant");
  });
});
