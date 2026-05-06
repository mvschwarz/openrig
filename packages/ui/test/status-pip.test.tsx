// V1 Shell Redesign — Phase 1 — StatusPip primitive.
//
// API surface + tone mapping + negative-assertion (discipline ritual #8):
// status-pip is for SEMANTIC status only, not kind-taxonomy. Tests assert
// it does not render workspace-kind labels by accident.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPip, type StatusPipStatus } from "../src/components/ui/status-pip";

const ALL_STATUSES: StatusPipStatus[] = [
  "active",
  "running",
  "stopped",
  "warning",
  "error",
  "info",
];

describe("StatusPip (Phase 1 primitive)", () => {
  it("renders dot variant by default with role=status", () => {
    render(<StatusPip status="active" testId="sp" />);
    expect(screen.getByTestId("sp").getAttribute("role")).toBe("status");
  });

  it.each(ALL_STATUSES)("dot variant tone for %s status maps to expected class", (status) => {
    const { container } = render(<StatusPip status={status} testId={`sp-${status}`} />);
    const root = container.querySelector(`[data-testid='sp-${status}']`) as HTMLElement;
    const dot = root.querySelector("span[aria-hidden]") as HTMLElement;
    if (status === "active" || status === "running") expect(dot.className).toContain("bg-success");
    if (status === "stopped") expect(dot.className).toContain("bg-stone-400");
    if (status === "warning") expect(dot.className).toContain("bg-warning");
    if (status === "error") expect(dot.className).toContain("bg-tertiary");
    if (status === "info") expect(dot.className).toContain("bg-secondary");
  });

  it("pill variant includes label text", () => {
    render(<StatusPip status="error" label="FAILED" variant="pill" testId="sp-pill" />);
    const root = screen.getByTestId("sp-pill");
    expect(root.textContent).toContain("FAILED");
  });

  it("pill variant tone classes apply to the wrapper", () => {
    const { container } = render(
      <StatusPip status="warning" variant="pill" testId="sp-w-pill" />,
    );
    const root = container.querySelector("[data-testid='sp-w-pill']") as HTMLElement;
    expect(root.className).toContain("border-warning");
    expect(root.className).toContain("text-warning");
  });

  it("renders label in dot variant when provided", () => {
    render(<StatusPip status="active" label="LIVE" testId="sp-dlbl" />);
    expect(screen.getByText("LIVE")).toBeTruthy();
  });

  it("aria-label falls back to status when no label", () => {
    render(<StatusPip status="info" testId="sp-aria" />);
    expect(screen.getByTestId("sp-aria").getAttribute("aria-label")).toBe("info");
  });

  // Negative-assertion (ritual #8): StatusPip is for semantic status, not kind taxonomy.
  // Make sure forbidden workspace-kind strings never bleed into the rendering.
  const FORBIDDEN_KIND_LABELS = ["user", "project", "knowledge", "lab", "delivery"];
  it("does NOT render workspace-kind taxonomy labels for any status", () => {
    for (const s of ALL_STATUSES) {
      const { container, unmount } = render(<StatusPip status={s} />);
      for (const kind of FORBIDDEN_KIND_LABELS) {
        expect(container.textContent ?? "").not.toMatch(new RegExp(`\\b${kind}\\b`, "i"));
      }
      unmount();
    }
  });
});
