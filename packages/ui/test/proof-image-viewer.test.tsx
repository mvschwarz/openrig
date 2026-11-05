import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProofImageViewer } from "../src/components/project/ProofImageViewer.js";

afterEach(() => { cleanup(); document.getElementById("shell-content")?.remove(); });

describe("proof preview below the shell header", () => {
  it("escapes positioned cards and anchors to the shell content", () => {
    const content = document.createElement("div");
    content.id = "shell-content";
    document.body.append(content);
    const onClose = vi.fn();
    const view = render(<article className="relative overflow-hidden"><ProofImageViewer sliceName="demo" relPath="proof/image.png" onClose={onClose} /></article>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toBe(content);
    expect(view.container.contains(dialog)).toBe(false);
    expect(dialog.className).toContain("absolute");
    expect(dialog.className).toContain("top-0");
    expect(dialog.className).not.toContain("top-14");
    fireEvent.click(screen.getByRole("button", { name: "Close screenshot preview" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
