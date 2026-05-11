import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LibraryTopLevelEntry } from "../src/components/specs/LibraryTopLevelEntry.js";

interface DemoItem {
  id: string;
  name: string;
  group: string;
}

const items: DemoItem[] = [
  { id: "a", name: "Alpha", group: "first" },
  { id: "b", name: "Beta", group: "first" },
  { id: "c", name: "Gamma", group: "second" },
];

describe("LibraryTopLevelEntry", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the page title from displayName", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo Library"
        iconKind="skill"
        items={items}
        folderField="group"
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: /demo library/i })).toBeTruthy();
  });

  it("renders all items grouped by folderField value", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={items}
        folderField="group"
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={() => {}}
      />,
    );
    expect(screen.getByTestId("library-folder-first")).toBeTruthy();
    expect(screen.getByTestId("library-folder-second")).toBeTruthy();
    expect(screen.getByTestId("library-item-a")).toBeTruthy();
    expect(screen.getByTestId("library-item-b")).toBeTruthy();
    expect(screen.getByTestId("library-item-c")).toBeTruthy();
  });

  it("groups with the same folder value are merged into one section", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={items}
        folderField="group"
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={() => {}}
      />,
    );
    const firstFolder = screen.getByTestId("library-folder-first");
    expect(firstFolder.textContent).toMatch(/2/); // count = 2 items in "first"
  });

  it("clicking an item calls onItemClick with the item object", () => {
    const onItemClick = vi.fn();
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={items}
        folderField="group"
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={onItemClick}
      />,
    );
    fireEvent.click(screen.getByTestId("library-item-a"));
    expect(onItemClick).toHaveBeenCalledWith(items[0]);
  });

  it("renders emptyState when items is empty", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={[]}
        folderField="group"
        emptyState={<div data-testid="empty-marker">No items yet — add some</div>}
        onItemClick={() => {}}
      />,
    );
    expect(screen.getByTestId("empty-marker")).toBeTruthy();
    expect(screen.queryByTestId("library-folder-first")).toBeNull();
  });

  it("does NOT render emptyState when items has values", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={items}
        folderField="group"
        emptyState={<div data-testid="empty-marker">empty</div>}
        onItemClick={() => {}}
      />,
    );
    expect(screen.queryByTestId("empty-marker")).toBeNull();
  });

  it("folder groups are sorted alphabetically by group key", () => {
    const shuffled: DemoItem[] = [
      { id: "z", name: "Zed", group: "zulu" },
      { id: "a", name: "Alpha", group: "alpha" },
      { id: "m", name: "Mike", group: "mike" },
    ];
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={shuffled}
        folderField="group"
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={() => {}}
      />,
    );
    const folders = screen.getAllByTestId(/^library-folder-/);
    const keys = folders.map((node) => node.getAttribute("data-testid"));
    expect(keys).toEqual([
      "library-folder-alpha",
      "library-folder-mike",
      "library-folder-zulu",
    ]);
  });

  it("uses formatFolderLabel when provided to render folder header text", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={items}
        folderField="group"
        formatFolderLabel={(folder) => `Group: ${String(folder).toUpperCase()}`}
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={() => {}}
      />,
    );
    expect(screen.getByText(/group: first/i)).toBeTruthy();
    expect(screen.getByText(/group: second/i)).toBeTruthy();
  });

  it("has data-testid root anchored on slug for downstream selectors", () => {
    render(
      <LibraryTopLevelEntry
        slug="demo"
        displayName="Demo"
        iconKind="skill"
        items={items}
        folderField="group"
        emptyState={<div data-testid="empty">empty</div>}
        onItemClick={() => {}}
      />,
    );
    expect(screen.getByTestId("library-top-level-demo")).toBeTruthy();
  });
});
