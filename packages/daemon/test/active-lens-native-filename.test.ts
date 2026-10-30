import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";

it.runIf(process.platform === "win32")("persists and updates an owned long-named activation lens without extending its basename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-native-name-"));
  try {
    const filePath = path.join(root, `${"l".repeat(245)}.json`);
    const store = new ActiveLensStore({ filePath });
    store.set("owned-first", "1");
    expect(new ActiveLensStore({ filePath }).get()).toMatchObject({ specName: "owned-first", specVersion: "1" });
    store.set("owned-second", "2");
    expect(new ActiveLensStore({ filePath }).get()).toMatchObject({ specName: "owned-second", specVersion: "2" });
    expect(fs.readdirSync(root)).toEqual([path.basename(filePath)]);
    store.clear(); expect(store.get()).toBeNull(); expect(fs.readdirSync(root)).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
