// Workflows in Spec Library + Activation Lens v0 — active lens store tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";

describe("ActiveLensStore (Workflows in Spec Library v0)", () => {
  let tmp: string;
  let filePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "active-lens-"));
    filePath = join(tmp, "active-workflow-lens.json");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no lens file exists", () => {
    const store = new ActiveLensStore({ filePath });
    expect(store.get()).toBeNull();
  });

  it("set persists name + version + activatedAt timestamp", () => {
    const store = new ActiveLensStore({
      filePath,
      now: () => new Date("2026-05-04T12:34:56Z"),
    });
    const lens = store.set("rsi-v2-hot-potato", "1");
    expect(lens.specName).toBe("rsi-v2-hot-potato");
    expect(lens.specVersion).toBe("1");
    expect(lens.activatedAt).toBe("2026-05-04T12:34:56.000Z");

    const re = store.get();
    expect(re).toEqual(lens);
  });

  it("set replaces an existing lens (single-active invariant)", () => {
    const store = new ActiveLensStore({ filePath });
    store.set("first", "1");
    store.set("second", "2");
    const lens = store.get();
    expect(lens?.specName).toBe("second");
    expect(lens?.specVersion).toBe("2");
  });

  it("clear removes the lens file", () => {
    const store = new ActiveLensStore({ filePath });
    store.set("foo", "1");
    expect(existsSync(filePath)).toBe(true);
    store.clear();
    expect(existsSync(filePath)).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("clear is a no-op when no file exists", () => {
    const store = new ActiveLensStore({ filePath });
    expect(() => store.clear()).not.toThrow();
  });

  it("returns null for malformed JSON", () => {
    writeFileSync(filePath, "{not-json", "utf-8");
    const store = new ActiveLensStore({ filePath });
    expect(store.get()).toBeNull();
  });

  it("returns null when stored object is missing specName/specVersion", () => {
    writeFileSync(filePath, JSON.stringify({ activatedAt: "2026-01-01T00:00:00Z" }), "utf-8");
    const store = new ActiveLensStore({ filePath });
    expect(store.get()).toBeNull();
  });

  it("creates parent directory lazily on first set", () => {
    const nested = join(tmp, "does", "not", "exist", "lens.json");
    const store = new ActiveLensStore({ filePath: nested });
    store.set("foo", "1");
    expect(existsSync(nested)).toBe(true);
  });
});
