import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { act } from "react";
import { Command } from "cmdk";
import { Toaster, toast } from "sonner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

describe("ui-redesign dependencies work under jsdom", () => {
  it("cmdk filters items as you type", () => {
    render(
      <Command label="Palette">
        <Command.Input placeholder="Search" />
        <Command.List>
          <Command.Empty>No results</Command.Empty>
          <Command.Item value="Rigs">Rigs</Command.Item>
          <Command.Item value="Inbox">Inbox</Command.Item>
        </Command.List>
      </Command>,
    );
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "inb" } });
    expect(screen.queryByText("Rigs")).toBeNull();
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  it("sonner renders a toast", async () => {
    render(<Toaster />);
    await act(async () => {
      toast.success("Saved");
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("radix dropdown opens from the keyboard", () => {
    render(
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>Open</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item>Stop rig</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>,
    );
    fireEvent.keyDown(screen.getByText("Open"), { key: "Enter" });
    expect(screen.queryByText("Stop rig")).toBeTruthy();
  });
});
