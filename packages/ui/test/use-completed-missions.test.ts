import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useCompletedMissions,
  COMPLETED_MISSIONS_STORAGE_KEY,
} from "../src/hooks/useCompletedMissions.js";

describe("useCompletedMissions", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty when localStorage has no entry", () => {
    const { result } = renderHook(() => useCompletedMissions());
    expect(result.current.completedMissionIds.size).toBe(0);
  });

  it("reads existing completed mission ids from localStorage", () => {
    localStorage.setItem(
      COMPLETED_MISSIONS_STORAGE_KEY,
      JSON.stringify(["getting-started", "release-0-3-1"]),
    );
    const { result } = renderHook(() => useCompletedMissions());
    expect(result.current.completedMissionIds.has("getting-started")).toBe(true);
    expect(result.current.completedMissionIds.has("release-0-3-1")).toBe(true);
  });

  it("recovers gracefully from malformed JSON", () => {
    localStorage.setItem(COMPLETED_MISSIONS_STORAGE_KEY, "{not json[");
    const { result } = renderHook(() => useCompletedMissions());
    expect(result.current.completedMissionIds.size).toBe(0);
  });

  it("recovers gracefully from non-array values", () => {
    localStorage.setItem(COMPLETED_MISSIONS_STORAGE_KEY, JSON.stringify({ not: "an-array" }));
    const { result } = renderHook(() => useCompletedMissions());
    expect(result.current.completedMissionIds.size).toBe(0);
  });

  it("markCompleted(id) adds to the set and persists to localStorage", () => {
    const { result } = renderHook(() => useCompletedMissions());
    act(() => result.current.markCompleted("getting-started"));
    expect(result.current.completedMissionIds.has("getting-started")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(COMPLETED_MISSIONS_STORAGE_KEY) ?? "[]") as string[];
    expect(stored).toContain("getting-started");
  });

  it("markCompleted is idempotent — same id twice keeps one entry", () => {
    const { result } = renderHook(() => useCompletedMissions());
    act(() => result.current.markCompleted("getting-started"));
    act(() => result.current.markCompleted("getting-started"));
    const stored = JSON.parse(localStorage.getItem(COMPLETED_MISSIONS_STORAGE_KEY) ?? "[]") as string[];
    expect(stored.filter((id) => id === "getting-started")).toHaveLength(1);
  });

  it("unmarkCompleted(id) removes from set and persists", () => {
    localStorage.setItem(COMPLETED_MISSIONS_STORAGE_KEY, JSON.stringify(["getting-started"]));
    const { result } = renderHook(() => useCompletedMissions());
    act(() => result.current.unmarkCompleted("getting-started"));
    expect(result.current.completedMissionIds.has("getting-started")).toBe(false);
    const stored = JSON.parse(localStorage.getItem(COMPLETED_MISSIONS_STORAGE_KEY) ?? "[]") as string[];
    expect(stored).not.toContain("getting-started");
  });
});
