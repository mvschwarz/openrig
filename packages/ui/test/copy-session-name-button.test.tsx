import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { CopySessionNameButton } from "../src/components/CopySessionNameButton.js";
import { RigNode } from "../src/components/RigNode.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CopySessionNameButton", () => {
  it("copies the full session name and shows that it was copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopySessionNameButton sessionName="eng-lead@my-rig" testId="copy" />);

    const button = screen.getByTestId("copy");
    expect(button.getAttribute("aria-label")).toBe("Copy eng-lead@my-rig");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeText).toHaveBeenCalledWith("eng-lead@my-rig");
    expect(button.getAttribute("aria-label")).toBe("Copied eng-lead@my-rig");
  });

  it("does not pass the click on to the card", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <CopySessionNameButton sessionName="eng-lead@my-rig" testId="copy" />
      </div>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("copy"));
    });

    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("goes back to the copy icon after a moment", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    render(<CopySessionNameButton sessionName="eng-lead@my-rig" testId="copy" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("copy"));
    });
    expect(screen.getByTestId("copy").getAttribute("title")).toBe("Copied");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("copy").getAttribute("title")).toBe("Copy eng-lead@my-rig");
  });
});

describe("RigNode copy button", () => {
  const baseNode = {
    logicalId: "dev.impl",
    role: "worker",
    runtime: "claude-code",
    model: null,
    status: "running",
    binding: null,
    rigId: "rig-1",
  };

  it("offers to copy the full session name when the seat has one", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{ ...baseNode, canonicalSessionName: "dev-impl@my-rig" }} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId("toolbar-copy-session-name").getAttribute("aria-label")).toBe("Copy dev-impl@my-rig");
  });

  it("shows no copy button without a session name", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={baseNode} />
      </ReactFlowProvider>,
    );
    expect(screen.queryByTestId("toolbar-copy-session-name")).toBeNull();
  });
});
