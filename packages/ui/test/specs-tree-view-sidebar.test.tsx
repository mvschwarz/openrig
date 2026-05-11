import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SpecsTreeView } from "../src/components/specs/SpecsTreeView.js";
import { createTestRouter } from "./helpers/test-router.js";

// velocity-guard 18.C BLOCKING-CONCERN repair (Blocker 2):
// Top-level "Skills" sidebar link must both navigate to /specs/skills
// AND expand the Skills section below (per IMPL-PRD §3.3 + T7).

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // All Library endpoints return empty so the Section renders its
  // "No skills yet." placeholder when expanded — visible expansion
  // proof without needing real Library data.
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => [],
  }));
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function renderTree() {
  return render(
    createTestRouter({
      path: "/specs",
      initialPath: "/specs",
      component: () => <SpecsTreeView />,
    }),
  );
}

describe("SpecsTreeView — top-level sidebar Skills link", () => {
  it("renders a Skills top-level link in the sidebar", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-skills-top-level")).toBeTruthy();
    });
  });

  it("Skills section is collapsed by default (chevron right; no placeholder visible)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-skills")).toBeTruthy();
    });
    // Default expanded state for "skills" is false; placeholder not rendered.
    expect(screen.queryByText(/no skills yet/i)).toBeNull();
  });

  it("clicking the sidebar Skills top-level link expands the Skills section below", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-skills-top-level")).toBeTruthy();
    });
    expect(screen.queryByText(/no skills yet/i)).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-skills-top-level"));

    await waitFor(() => {
      // After the click, the section's expanded body renders. Because
      // useLibrarySkills mock returns [], the Section shows its
      // "No skills yet." placeholder — proof of expansion.
      expect(screen.getByText(/no skills yet/i)).toBeTruthy();
    });
  });
});

describe("SpecsTreeView — top-level sidebar Plugins link (slice 18 Checkpoint D)", () => {
  it("renders a Plugins top-level link in the sidebar", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-plugins-top-level")).toBeTruthy();
    });
  });

  it("Plugins section is collapsed by default (placeholder absent)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-plugins")).toBeTruthy();
    });
    expect(screen.queryByText(/no plugins yet/i)).toBeNull();
  });

  it("clicking the sidebar Plugins top-level link expands the Plugins section below", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-plugins-top-level")).toBeTruthy();
    });
    expect(screen.queryByText(/no plugins yet/i)).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-plugins-top-level"));

    await waitFor(() => {
      expect(screen.getByText(/no plugins yet/i)).toBeTruthy();
    });
  });
});
