import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake file handle only when a test sets one; every other open() is the real one.
const fake = vi.hoisted(() => ({ handle: null as null | { stat(): Promise<unknown>; read(...a: unknown[]): Promise<{ bytesRead: number }>; close(): Promise<void> } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => (fake.handle ? Promise.resolve(fake.handle) : actual.open(...args)) };
});

const { readShortRegularFile } = await import("../src/adapters/tmux-control.js");

describe("readShortRegularFile reads the whole file or nothing", () => {
  afterEach(() => { fake.handle = null; });

  it("returns the bytes of a short regular file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-short-"));
    try {
      writeFileSync(join(dir, "f"), "hello");
      expect((await readShortRegularFile(join(dir, "f"), 4096))?.toString()).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the read returns fewer bytes than the file's size (a short read)", async () => {
    let closed = false;
    fake.handle = {
      stat: async () => ({ isFile: () => true, size: 10 }),
      read: async (buffer: unknown) => { (buffer as Buffer).write("hello", 0); return { bytesRead: 5 }; },
      close: async () => { closed = true; },
    };
    expect(await readShortRegularFile("/fake/short", 4096)).toBeNull();
    expect(closed).toBe(true);
  });

  it("returns null when the file grew between the stat and the read", async () => {
    fake.handle = {
      stat: async () => ({ isFile: () => true, size: 5 }),
      read: async (buffer: unknown) => { (buffer as Buffer).write("hello world", 0); return { bytesRead: 11 }; },
      close: async () => {},
    };
    expect(await readShortRegularFile("/fake/grew", 4096)).toBeNull();
  });
});
