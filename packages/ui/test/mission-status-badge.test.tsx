// V1 attempt-3 Phase 3 — MissionStatusBadge tests (SC-26).

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  MissionStatusBadge,
  parseMissionStatus,
} from "../src/components/MissionStatusBadge.js";

describe("MissionStatusBadge", () => {
  it("renders with status label", () => {
    render(<MissionStatusBadge status="active" />);
    expect(screen.getByTestId("mission-status-active")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("supports custom label", () => {
    render(<MissionStatusBadge status="shipped" label="DELIVERED" />);
    expect(screen.getByText("DELIVERED")).toBeTruthy();
  });

  it("status=blocked applies warning border", () => {
    const { container } = render(<MissionStatusBadge status="blocked" />);
    const el = container.querySelector("[data-testid='mission-status-blocked']") as HTMLElement;
    expect(el.className).toContain("border-warning");
  });
});

describe("parseMissionStatus (SC-26 — PROGRESS.md frontmatter source)", () => {
  it("parses YAML frontmatter status: active", () => {
    const md = "---\nstatus: active\n---\n# Mission";
    expect(parseMissionStatus(md)).toBe("active");
  });

  it("parses status: in_progress as active", () => {
    expect(parseMissionStatus("---\nstatus: in_progress\n---\n")).toBe("active");
  });

  it("parses status: shipped", () => {
    expect(parseMissionStatus("---\nstatus: shipped\n---\n")).toBe("shipped");
  });

  it("parses status: blocked", () => {
    expect(parseMissionStatus("---\nstatus: blocked\n---\n")).toBe("blocked");
  });

  it("returns unknown when no frontmatter", () => {
    expect(parseMissionStatus("# Just a heading")).toBe("unknown");
  });

  it("returns unknown for null/undefined input", () => {
    expect(parseMissionStatus(null)).toBe("unknown");
    expect(parseMissionStatus(undefined)).toBe("unknown");
  });
});
