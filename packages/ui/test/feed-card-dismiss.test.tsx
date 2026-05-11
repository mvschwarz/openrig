import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FeedCard } from "../src/components/for-you/FeedCard.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

function makeCard(overrides: Partial<FeedCardModel> = {}): FeedCardModel {
  return {
    id: "queue.enqueued-42",
    kind: "progress",
    title: "Sample card",
    body: "Sample body",
    receivedAt: 1234567890,
    createdAt: new Date(1234567890 * 1000).toISOString(),
    source: {
      seq: 42,
      type: "queue.enqueued",
      payload: {},
    } as unknown as FeedCardModel["source"],
    ...overrides,
  };
}

describe("FeedCard dismiss surfaces", () => {
  afterEach(() => {
    cleanup();
  });

  it("does NOT render dismiss control when onDismiss is omitted", () => {
    render(<FeedCard card={makeCard()} />);
    expect(screen.queryByTestId("feed-card-dismiss")).toBeNull();
  });

  it("renders dismiss button (hover-X) when onDismiss is provided", () => {
    render(<FeedCard card={makeCard()} onDismiss={() => {}} />);
    expect(screen.getByTestId("feed-card-dismiss")).toBeTruthy();
  });

  it("clicking dismiss button calls onDismiss with card.source.seq", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard({ source: { seq: 42, type: "queue.enqueued", payload: {} } as unknown as FeedCardModel["source"] })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("feed-card-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith(42);
  });

  it("Backspace key on focused card calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    fireEvent.keyDown(article, { key: "Backspace" });
    expect(onDismiss).toHaveBeenCalledWith(42);
  });

  it("Delete key on focused card calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    fireEvent.keyDown(article, { key: "Delete" });
    expect(onDismiss).toHaveBeenCalledWith(42);
  });

  it("other keys (e.g. Enter, Escape) do NOT call onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    fireEvent.keyDown(article, { key: "Enter" });
    fireEvent.keyDown(article, { key: "Escape" });
    fireEvent.keyDown(article, { key: "a" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("article has tabIndex=0 when onDismiss provided so it can receive focus", () => {
    render(<FeedCard card={makeCard()} onDismiss={() => {}} />);
    const article = screen.getByTestId("feed-card-progress");
    expect(article.getAttribute("tabindex")).toBe("0");
  });

  it("touch swipe-right past threshold triggers onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");

    article.getBoundingClientRect = () =>
      ({ width: 400, left: 0, right: 400, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.touchStart(article, { touches: [{ clientX: 50, clientY: 50, identifier: 1 }] });
    fireEvent.touchEnd(article, { changedTouches: [{ clientX: 300, clientY: 50, identifier: 1 }] });

    expect(onDismiss).toHaveBeenCalledWith(42);
  });

  it("touch swipe-right BELOW threshold does NOT trigger onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    article.getBoundingClientRect = () =>
      ({ width: 400, left: 0, right: 400, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.touchStart(article, { touches: [{ clientX: 50, clientY: 50, identifier: 1 }] });
    fireEvent.touchEnd(article, { changedTouches: [{ clientX: 100, clientY: 50, identifier: 1 }] });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("leftward swipe does NOT trigger onDismiss (only right-swipe dismisses)", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    article.getBoundingClientRect = () =>
      ({ width: 400, left: 0, right: 400, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.touchStart(article, { touches: [{ clientX: 300, clientY: 50, identifier: 1 }] });
    fireEvent.touchEnd(article, { changedTouches: [{ clientX: 50, clientY: 50, identifier: 1 }] });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
