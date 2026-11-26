/** Tests session-name copying and its availability on seat cards. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { CopySessionNameButton } from "../src/components/CopySessionNameButton.js";
import { RigNode } from "../src/components/RigNode.js";
import { HybridAgentNode } from "../src/components/topology/HybridTopologyNodes.js";

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

  it("keeps the copy button in its initial state when both copy methods fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard copy denied"));
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    try {
      render(<CopySessionNameButton sessionName="eng-lead@my-rig" />);
      const button = screen.getByRole("button", { name: "Copy eng-lead@my-rig" });
      await act(async () => {
        fireEvent.click(button);
      });

      expect(writeText).toHaveBeenCalledWith("eng-lead@my-rig");
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(screen.getByRole("button", { name: "Copy eng-lead@my-rig" })).toBe(button);
      expect(screen.queryByTitle("Copied")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
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

describe("HybridAgentNode copy button", () => {
  it("offers to copy the full session name on the topology card", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <HybridAgentNode data={{ logicalId: "dev.impl", canonicalSessionName: "dev-impl@my-rig" }} />
        </ReactFlowProvider>
      </QueryClientProvider>,
    );

    const card = screen.getByTestId("hybrid-agent-node");
    expect(within(card).getByRole("button", { name: "Copy dev-impl@my-rig" })).toBeTruthy();
  });
});
