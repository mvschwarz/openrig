// V1 attempt-3 Phase 3 bounce-fix — A3 formatter tests.

import { describe, it, expect } from "vitest";
import { formatEventPayload } from "../src/lib/format-event-payload.js";

describe("formatEventPayload (Phase 3 bounce-fix A3)", () => {
  it("prefers payload.summary when present", () => {
    expect(formatEventPayload({ summary: "Slice PL-014 shipped" })).toBe(
      "Slice PL-014 shipped",
    );
  });

  it("falls back to body when no summary", () => {
    expect(formatEventPayload({ body: "Some body text" })).toBe("Some body text");
  });

  it("falls back to detail / message / title", () => {
    expect(formatEventPayload({ detail: "Detail text" })).toBe("Detail text");
    expect(formatEventPayload({ message: "Msg text" })).toBe("Msg text");
    expect(formatEventPayload({ title: "Title" })).toBe("Title");
  });

  it("returns key=value compact preview when no message key", () => {
    const result = formatEventPayload({
      qitem_id: "qitem-abc",
      state: "pending",
      destination_session: "driver@vel",
    });
    expect(result).toContain("qitem_id=qitem-abc");
    expect(result).toContain("state=pending");
    expect(result).toContain("destination_session=driver@vel");
  });

  it("skips noise keys like timestamps", () => {
    const result = formatEventPayload({
      ts_created: "2026-05-06",
      received_at: 12345,
      qitem_id: "qitem-x",
      state: "done",
    });
    expect(result).not.toContain("ts_created");
    expect(result).not.toContain("received_at");
    expect(result).toContain("qitem_id=qitem-x");
    expect(result).toContain("state=done");
  });

  it("limits compact preview to 4 keys", () => {
    const result = formatEventPayload({
      a: "1",
      b: "2",
      c: "3",
      d: "4",
      e: "5",
      f: "6",
    });
    expect(result.split("·").length).toBe(4);
  });

  it("falls back to JSON.stringify when only nested objects", () => {
    const result = formatEventPayload({
      nested: { foo: "bar" },
      list: [1, 2, 3],
    });
    expect(result).toContain("{");
  });

  it("returns '—' for null/undefined/non-object", () => {
    expect(formatEventPayload(null)).toBe("—");
    expect(formatEventPayload(undefined)).toBe("—");
    expect(formatEventPayload("a string")).toBe("—");
    expect(formatEventPayload(42)).toBe("—");
  });

  it("truncates very long strings with ellipsis", () => {
    const long = "x".repeat(500);
    const result = formatEventPayload({ summary: long });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith("…")).toBe(true);
  });
});
