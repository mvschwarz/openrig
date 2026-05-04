// Slice Story View v0 — TestsVerificationTab focused tests.
//
// This is the founder-named load-bearing tab; orch will bounce drops
// of the inline screenshot rendering or video player. These tests
// pin both behaviors as a regression gate.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TestsVerificationTab } from "../src/components/slices/tabs/TestsVerificationTab.js";
import type { SliceDetail, ProofPacketRendered } from "../src/hooks/useSlices.js";

function makePacket(overrides: Partial<ProofPacketRendered> = {}): ProofPacketRendered {
  return {
    dirName: "pl005-phase-a-mission-control-queue-observability-20260504",
    primaryMarkdown: { relPath: "PL005-headed-browser-dogfood.md", content: "All green ✅" },
    additionalMarkdown: [],
    screenshots: [],
    videos: [],
    traces: [],
    passFailBadge: "pass",
    ...overrides,
  };
}

function makeTests(packets: ProofPacketRendered[], aggregate?: { passCount: number; failCount: number }): SliceDetail["tests"] {
  return {
    proofPackets: packets,
    aggregate: aggregate ?? { passCount: packets.length, failCount: 0 },
  };
}

describe("PL-slice-story-view-v0 TestsVerificationTab", () => {
  afterEach(() => cleanup());

  it("renders empty state when slice has no proof packet (graceful — pre-dogfood slices)", () => {
    render(<TestsVerificationTab sliceName="x" tests={{ proofPackets: [], aggregate: { passCount: 0, failCount: 0 } }} />);
    expect(screen.getByTestId("tests-empty")).toBeDefined();
  });

  it("renders header aggregate '<pass> pass, <fail> fail · N packets'", () => {
    render(<TestsVerificationTab sliceName="x" tests={makeTests([makePacket(), makePacket({ dirName: "second", passFailBadge: "fail" })], { passCount: 1, failCount: 1 })} />);
    const aggregate = screen.getByTestId("tests-aggregate");
    expect(aggregate.textContent).toContain("1 pass, 1 fail");
    expect(aggregate.textContent).toContain("2 packets");
  });

  it("renders the primary markdown body inline (not just a file-path link)", () => {
    const tests = makeTests([makePacket({
      primaryMarkdown: { relPath: "PL019-dogfood.md", content: "PASS — all six tabs render correctly on PL-005 Phase A." },
    })]);
    render(<TestsVerificationTab sliceName="pl-019" tests={tests} />);
    const md = screen.getByTestId("tests-packet-primary-md-pl005-phase-a-mission-control-queue-observability-20260504");
    expect(md.textContent).toContain("PASS — all six tabs render");
    expect(md.textContent).toContain("PL019-dogfood.md");
  });

  it("MANDATORY (founder-named): renders <img> tag inline for each screenshot path", () => {
    const tests = makeTests([makePacket({
      screenshots: ["screenshots/mission-control-active-work.png", "headed-browser/screenshots/edge-fired.png"],
    })]);
    render(<TestsVerificationTab sliceName="my-slice" tests={tests} />);
    const img1 = screen.getByTestId("tests-packet-screenshot-screenshots/mission-control-active-work.png") as HTMLImageElement;
    const img2 = screen.getByTestId("tests-packet-screenshot-headed-browser/screenshots/edge-fired.png") as HTMLImageElement;
    expect(img1.tagName).toBe("IMG");
    expect(img2.tagName).toBe("IMG");
    expect(img1.getAttribute("src")).toContain("/api/slices/my-slice/proof-asset/");
    expect(img1.getAttribute("src")).toContain("mission-control-active-work.png");
    expect(img2.getAttribute("src")).toContain("edge-fired.png");
  });

  it("MANDATORY (founder-named): renders <video controls> player for each video path", () => {
    const tests = makeTests([makePacket({
      videos: ["videos/demo.mp4", "videos/walkthrough.webm"],
    })]);
    render(<TestsVerificationTab sliceName="vid-slice" tests={tests} />);
    const v1 = screen.getByTestId("tests-packet-video-videos/demo.mp4") as HTMLVideoElement;
    const v2 = screen.getByTestId("tests-packet-video-videos/walkthrough.webm") as HTMLVideoElement;
    expect(v1.tagName).toBe("VIDEO");
    expect(v2.tagName).toBe("VIDEO");
    expect(v1.hasAttribute("controls")).toBe(true);
    expect(v1.getAttribute("src")).toContain("/api/slices/vid-slice/proof-asset/videos/demo.mp4");
  });

  it("does NOT render <video> when videos array is empty (real-world: QA hasn't captured yet)", () => {
    render(<TestsVerificationTab sliceName="x" tests={makeTests([makePacket({ videos: [] })])} />);
    expect(screen.queryByTestId("tests-packet-videos-pl005-phase-a-mission-control-queue-observability-20260504")).toBeNull();
  });

  it("does NOT render screenshots section when screenshots array is empty", () => {
    render(<TestsVerificationTab sliceName="x" tests={makeTests([makePacket({ screenshots: [] })])} />);
    expect(screen.queryByTestId("tests-packet-screenshots-pl005-phase-a-mission-control-queue-observability-20260504")).toBeNull();
  });

  it("renders pass/fail badge per packet with the correct semantic class", () => {
    const tests = makeTests([
      makePacket({ dirName: "p1", passFailBadge: "pass" }),
      makePacket({ dirName: "p2", passFailBadge: "fail" }),
      makePacket({ dirName: "p3", passFailBadge: "partial" }),
      makePacket({ dirName: "p4", passFailBadge: "unknown" }),
    ]);
    render(<TestsVerificationTab sliceName="x" tests={tests} />);
    expect(screen.getByTestId("tests-packet-badge-p1").textContent).toContain("pass");
    expect(screen.getByTestId("tests-packet-badge-p2").textContent).toContain("fail");
    expect(screen.getByTestId("tests-packet-badge-p3").textContent).toContain("partial");
    expect(screen.getByTestId("tests-packet-badge-p4").textContent).toContain("unknown");
    expect(screen.getByTestId("tests-packet-badge-p1").className).toContain("emerald");
    expect(screen.getByTestId("tests-packet-badge-p2").className).toContain("red");
    expect(screen.getByTestId("tests-packet-badge-p3").className).toContain("amber");
  });

  it("renders trace download links when traces present", () => {
    const tests = makeTests([makePacket({ traces: ["headed-browser/trace.zip"] })]);
    render(<TestsVerificationTab sliceName="t-slice" tests={tests} />);
    const section = screen.getByTestId("tests-packet-traces-pl005-phase-a-mission-control-queue-observability-20260504");
    const link = section.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toContain("/api/slices/t-slice/proof-asset/headed-browser/trace.zip");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("hides additional markdown behind a <details> disclosure when present", () => {
    const tests = makeTests([makePacket({
      additionalMarkdown: [{ relPath: "extra.md", content: "extra content" }],
    })]);
    render(<TestsVerificationTab sliceName="x" tests={tests} />);
    expect(screen.getByTestId("tests-packet-additional-md-toggle-pl005-phase-a-mission-control-queue-observability-20260504")).toBeDefined();
  });
});
