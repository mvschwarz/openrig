// V0.3.1 slice 15 walk-items 6 + 11 — FileLink primitive tests.
//
// FileLink is a thin wrapper over the existing FileReferenceTrigger
// that constructs FileViewerData from simpler props (path + root +
// optional absolutePath / kind / readPath). On click the drawer
// selection becomes `{ type: "file", data }`. Image-kind inference
// happens in FileViewer at render time, so FileLink itself doesn't
// run its own inference path — this test file verifies the data
// shape that flows to setSelection so a downstream FileViewer would
// honor inferKind correctly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { FileLink } from "../src/components/ui/FileLink.js";

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithDrawerCtx(ui: React.ReactNode) {
  const setSelection = vi.fn();
  const utils = render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
  return { setSelection, ...utils };
}

describe("FileLink primitive", () => {
  it("renders as a clickable element with the default testId 'file-link' and the path as the visible label", () => {
    const { getByTestId } = renderWithDrawerCtx(
      <FileLink path="README.md" root="workspace" />,
    );
    const trigger = getByTestId("file-link");
    expect(trigger.textContent).toBe("README.md");
  });

  it("renders custom children when provided (label distinct from raw path)", () => {
    const { getByTestId } = renderWithDrawerCtx(
      <FileLink path="missions/release-0.3.1/README.md" root="workspace">
        <span>release-0.3.1</span>
      </FileLink>,
    );
    expect(getByTestId("file-link").textContent).toBe("release-0.3.1");
  });

  it("honors a custom testId override", () => {
    const { getByTestId } = renderWithDrawerCtx(
      <FileLink path="x.md" root="workspace" testId="custom-file-link" />,
    );
    expect(getByTestId("custom-file-link")).toBeTruthy();
  });

  it("click → setSelection({ type: 'file', data: { path, root } })", () => {
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileLink path="notes.md" root="workspace" />,
    );
    fireEvent.click(getByTestId("file-link"));
    expect(setSelection).toHaveBeenCalledOnce();
    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: { path: "notes.md", root: "workspace" },
    });
  });

  it("threads absolutePath + readPath + kind through to the drawer payload", () => {
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileLink
        path="screenshot.png"
        absolutePath="/abs/path/screenshot.png"
        readPath="screenshots/screenshot.png"
        kind="image"
      />,
    );
    fireEvent.click(getByTestId("file-link"));
    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: {
        path: "screenshot.png",
        absolutePath: "/abs/path/screenshot.png",
        readPath: "screenshots/screenshot.png",
        kind: "image",
      },
    });
  });

  it("walk-item 6 fix: image extensions flow through without explicit kind (FileViewer infers at render time)", () => {
    // FileLink doesn't run kind inference itself — it just constructs
    // FileViewerData with the path. FileViewer.inferKind() picks up
    // .png/.jpg/.jpeg/.gif/.webp/.svg → "image" at render time. This
    // test asserts the data shape is clean (no spurious kind injection)
    // so the downstream inference path is unblocked.
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileLink path="cover.jpg" root="workspace" />,
    );
    fireEvent.click(getByTestId("file-link"));
    const call = setSelection.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.kind).toBeUndefined();
    expect(call.data.path).toBe("cover.jpg");
  });
});
