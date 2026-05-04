// Token / Context Usage Surface v0 (PL-012) — ContextUsageRing tests.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ContextUsageRing, deriveContextTier } from "../src/components/ContextUsageRing.js";

afterEach(() => cleanup());

describe("deriveContextTier (PL-012)", () => {
  it("returns 'unknown' when availability is not 'known'", () => {
    expect(deriveContextTier(50, "unknown")).toBe("unknown");
    expect(deriveContextTier(null, "known")).toBe("unknown");
    expect(deriveContextTier(undefined, "known")).toBe("unknown");
  });

  it(">= 80 → critical", () => {
    expect(deriveContextTier(80, "known")).toBe("critical");
    expect(deriveContextTier(95, "known")).toBe("critical");
  });

  it(">= 60 < 80 → warning", () => {
    expect(deriveContextTier(60, "known")).toBe("warning");
    expect(deriveContextTier(75, "known")).toBe("warning");
    expect(deriveContextTier(79, "known")).toBe("warning");
  });

  it("< 60 → low", () => {
    expect(deriveContextTier(0, "known")).toBe("low");
    expect(deriveContextTier(59, "known")).toBe("low");
  });
});

describe("ContextUsageRing (PL-012)", () => {
  it("renders with the appropriate tier data attribute", () => {
    render(<ContextUsageRing percent={90} availability="known" fresh testIdSuffix="alpha" />);
    expect(screen.getByTestId("context-ring-alpha").getAttribute("data-context-tier")).toBe("critical");
  });

  it("warning tier renders amber border", () => {
    render(<ContextUsageRing percent={70} availability="known" fresh testIdSuffix="beta" />);
    const el = screen.getByTestId("context-ring-beta");
    expect(el.getAttribute("data-context-tier")).toBe("warning");
    expect(el.className).toContain("border-amber-500");
  });

  it("low tier renders emerald border", () => {
    render(<ContextUsageRing percent={20} availability="known" fresh testIdSuffix="gamma" />);
    expect(screen.getByTestId("context-ring-gamma").className).toContain("border-emerald-500");
  });

  it("unknown tier renders dotted gray border", () => {
    render(<ContextUsageRing percent={null} availability="unknown" testIdSuffix="delta" />);
    const el = screen.getByTestId("context-ring-delta");
    expect(el.getAttribute("data-context-tier")).toBe("unknown");
    expect(el.className).toContain("border-dotted");
  });

  it("stale sample renders with reduced opacity", () => {
    render(<ContextUsageRing percent={75} availability="known" fresh={false} testIdSuffix="stale" />);
    expect(screen.getByTestId("context-ring-stale").className).toContain("opacity-50");
  });

  it("title surface includes percent + tier on known samples", () => {
    render(<ContextUsageRing percent={85} availability="known" fresh testIdSuffix="t" />);
    expect(screen.getByTestId("context-ring-t").getAttribute("title")).toContain("85%");
    expect(screen.getByTestId("context-ring-t").getAttribute("title")).toContain("critical");
  });
});
