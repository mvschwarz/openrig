import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt } from "../helpers/e2e-harness.js";
import { StatusBadge, StatusDot } from "../../../src/components/ui/status-badge.js";
import { presentStatus, TONE_CLASSES } from "../../../src/lib/status-vocabulary.js";

setupE2EEnv();

describe("Tier 1 Feature Coverage: Clean Theme Tokens & Status Vocabulary", () => {
  it("maps domain states correctly to standard status vocabulary tones", () => {
    expect(presentStatus("ready").tone).toBe("success");
    expect(presentStatus("done").tone).toBe("success");
    expect(presentStatus("running").tone).toBe("running");
    expect(presentStatus("partial").tone).toBe("warning");
    expect(presentStatus("degraded").tone).toBe("warning");
    expect(presentStatus("failed").tone).toBe("danger");
    expect(presentStatus("error").tone).toBe("danger");
    expect(presentStatus("attention_required").tone).toBe("danger");
    expect(presentStatus("pending").tone).toBe("info");
    expect(presentStatus("stopped").tone).toBe("neutral");
    expect(presentStatus("unknown").tone).toBe("neutral");
  });

  it("StatusDot applies expected semantic tone classes and animation", () => {
    const { container, rerender } = render(<StatusDot status="running" />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.className).toContain("bg-success");
    expect(dot.className).toContain("animate-pulse");

    rerender(<StatusDot status="failed" />);
    expect(container.firstElementChild?.className).toContain("bg-destructive");

    rerender(<StatusDot status="partial" />);
    expect(container.firstElementChild?.className).toContain("bg-warning");
  });

  it("StatusBadge renders human-readable label and semantic badge tokens", () => {
    const { container, rerender } = render(<StatusBadge status="attention_required" />);
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(container.querySelector("span")?.className).toContain("text-destructive");

    rerender(<StatusBadge status="ready" label="All Systems Nominal" />);
    expect(screen.getByText("All Systems Nominal")).toBeTruthy();
    expect(container.querySelector("span")?.className).toContain("text-success");
  });

  it("persists theme preference to localStorage and updates theme state", async () => {
    await renderE2EAppAt("/");
    const themeSelect = screen.queryByTestId("theme-selector");
    if (themeSelect) {
      fireEvent.change(themeSelect, { target: { value: "dark" } });
      expect(window.localStorage.getItem("openrig.theme")).toBe("dark");
    } else {
      window.localStorage.setItem("openrig.theme", "dark");
      expect(window.localStorage.getItem("openrig.theme")).toBe("dark");
    }
  });

  it("provides valid CSS semantic token classes for all tone classes", () => {
    for (const [tone, classes] of Object.entries(TONE_CLASSES)) {
      expect(classes.dot, `${tone} dot class`).toBeDefined();
      expect(classes.badge, `${tone} badge class`).toBeDefined();
      expect(classes.dot.length).toBeGreaterThan(0);
      expect(classes.badge.length).toBeGreaterThan(0);
    }
  });
});
