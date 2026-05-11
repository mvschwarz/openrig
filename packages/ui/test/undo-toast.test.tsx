import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { UndoToast } from "../src/components/for-you/UndoToast.js";

describe("UndoToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders the Undo control + label", () => {
    render(<UndoToast label="Dismissed" onUndo={() => {}} onExpire={() => {}} durationMs={5000} />);
    expect(screen.getByTestId("undo-toast")).toBeTruthy();
    expect(screen.getByTestId("undo-toast-button")).toBeTruthy();
    expect(screen.getByText(/dismissed/i)).toBeTruthy();
  });

  it("calls onUndo when the Undo button is clicked", () => {
    const onUndo = vi.fn();
    render(<UndoToast label="Dismissed" onUndo={onUndo} onExpire={() => {}} durationMs={5000} />);
    fireEvent.click(screen.getByTestId("undo-toast-button"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("calls onExpire after durationMs", () => {
    const onExpire = vi.fn();
    render(<UndoToast label="Dismissed" onUndo={() => {}} onExpire={onExpire} durationMs={5000} />);
    expect(onExpire).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onExpire if onUndo fired first", () => {
    const onUndo = vi.fn();
    const onExpire = vi.fn();
    render(<UndoToast label="Dismissed" onUndo={onUndo} onExpire={onExpire} durationMs={5000} />);
    fireEvent.click(screen.getByTestId("undo-toast-button"));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
