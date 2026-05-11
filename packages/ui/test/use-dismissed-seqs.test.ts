import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDismissedSeqs, DISMISSED_SEQS_STORAGE_KEY } from "../src/hooks/useDismissedSeqs.js";

describe("useDismissedSeqs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty when localStorage has no entry", () => {
    const { result } = renderHook(() => useDismissedSeqs([1, 2, 3]));
    expect(result.current.dismissedSeqs.size).toBe(0);
  });

  it("reads existing dismissedSeqs from localStorage on mount", () => {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify([5, 7]));
    const { result } = renderHook(() => useDismissedSeqs([5, 7, 9]));
    expect(result.current.dismissedSeqs.has(5)).toBe(true);
    expect(result.current.dismissedSeqs.has(7)).toBe(true);
    expect(result.current.dismissedSeqs.has(9)).toBe(false);
  });

  it("recovers gracefully when localStorage contains malformed JSON", () => {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, "{not json[");
    const { result } = renderHook(() => useDismissedSeqs([1, 2]));
    expect(result.current.dismissedSeqs.size).toBe(0);
  });

  it("recovers gracefully when localStorage contains a non-array value", () => {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify({ not: "an-array" }));
    const { result } = renderHook(() => useDismissedSeqs([1, 2]));
    expect(result.current.dismissedSeqs.size).toBe(0);
  });

  it("dismiss(seq) adds to the set and persists to localStorage", () => {
    const { result } = renderHook(() => useDismissedSeqs([1, 2, 3]));
    act(() => result.current.dismiss(2));
    expect(result.current.dismissedSeqs.has(2)).toBe(true);
    const stored = JSON.parse(localStorage.getItem(DISMISSED_SEQS_STORAGE_KEY) ?? "[]") as number[];
    expect(stored).toContain(2);
  });

  it("undismiss(seq) removes from the set and persists to localStorage", () => {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify([2, 5]));
    const { result } = renderHook(() => useDismissedSeqs([2, 5, 7]));
    act(() => result.current.undismiss(2));
    expect(result.current.dismissedSeqs.has(2)).toBe(false);
    expect(result.current.dismissedSeqs.has(5)).toBe(true);
    const stored = JSON.parse(localStorage.getItem(DISMISSED_SEQS_STORAGE_KEY) ?? "[]") as number[];
    expect(stored).not.toContain(2);
    expect(stored).toContain(5);
  });

  it("auto-prunes entries with seq < min(currentSeqs) when currentSeqs change", () => {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify([1, 2, 100]));
    // currentSeqs has min=50 — seqs 1 and 2 have aged out of the activity buffer
    const { result } = renderHook(() => useDismissedSeqs([50, 75, 100]));
    expect(result.current.dismissedSeqs.has(1)).toBe(false);
    expect(result.current.dismissedSeqs.has(2)).toBe(false);
    expect(result.current.dismissedSeqs.has(100)).toBe(true);
    // Pruned entries also removed from localStorage
    const stored = JSON.parse(localStorage.getItem(DISMISSED_SEQS_STORAGE_KEY) ?? "[]") as number[];
    expect(stored).not.toContain(1);
    expect(stored).not.toContain(2);
    expect(stored).toContain(100);
  });

  it("does not prune when currentSeqs is empty (no min to compare against)", () => {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify([5, 10]));
    const { result } = renderHook(() => useDismissedSeqs([]));
    expect(result.current.dismissedSeqs.has(5)).toBe(true);
    expect(result.current.dismissedSeqs.has(10)).toBe(true);
  });

  it("dismiss is idempotent — same seq twice keeps single entry", () => {
    const { result } = renderHook(() => useDismissedSeqs([1, 2, 3]));
    act(() => result.current.dismiss(2));
    act(() => result.current.dismiss(2));
    expect(result.current.dismissedSeqs.has(2)).toBe(true);
    const stored = JSON.parse(localStorage.getItem(DISMISSED_SEQS_STORAGE_KEY) ?? "[]") as number[];
    expect(stored.filter((s) => s === 2)).toHaveLength(1);
  });

  it("undismiss on a seq that wasn't dismissed is a no-op", () => {
    const { result } = renderHook(() => useDismissedSeqs([1, 2]));
    expect(() => act(() => result.current.undismiss(99))).not.toThrow();
    expect(result.current.dismissedSeqs.size).toBe(0);
  });
});
