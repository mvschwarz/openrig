import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { TerminalViewsStore } from "../src/domain/terminal/terminal-views-store.js";

it("round-trips, replaces and removes views in an owned valid long filename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "views-long-"));
  const name = "v".repeat(240) + ".yaml", file = path.join(root, name);
  const view = { id: "owned", name: "first", members: [{ seat: "owned@fixture", tmuxSession: "owned@fixture" }] };
  try {
    const store = new TerminalViewsStore(file);
    store.save(view);
    store.save({ ...view, name: "updated" });
    expect(new TerminalViewsStore(file).get("owned")?.name).toBe("updated");
    store.remove("owned");
    expect(new TerminalViewsStore(file).list()).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([name]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
