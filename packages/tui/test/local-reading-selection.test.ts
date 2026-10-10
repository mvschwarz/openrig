import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalReadingController, localLines, type LocalRequest, type LocalResult } from "../src/local-reading.js";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openrig-local-selection-")); scratch.push(root);
  const requests: LocalRequest[] = [];
  const controller = new LocalReadingController(async (request) => {
    requests.push(request);
    if (request.op === "read") return { content: "fixture content" };
    return { entries: readdirSync(join(root, request.path ?? ""), { withFileTypes: true })
      .map((entry) => ({ label: entry.name, root: "fixture", path: join(request.path ?? "", entry.name), source: join(root, entry.name), kind: entry.isDirectory() ? "directory" : "file" })) };
  }, () => {});
  return { root, requests, controller };
}
describe("local reader listing selection", () => {
  it("keeps a visible, usable selection when disk refresh removes the selected last entry", async () => {
    const { root, requests, controller } = fixture();
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(root, name), name);
    await controller.load({ op: "list", root: "fixture", path: "" });
    await controller.key("select:2");
    rmSync(join(root, "c.md"));
    await controller.key("r");
    expect(controller.state.selected).toBe(1);
    expect(localLines(controller.state).some((line) => line.text === "▶ b.md")).toBe(true);
    await controller.key("enter");
    expect(requests.at(-1)).toEqual({ op: "read", root: "fixture", path: "b.md" });
  });
  it("clamps a restored parent selection if its siblings disappear while reading a child", async () => {
    const { root, controller } = fixture();
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(root, name), name);
    await controller.load({ op: "list", root: "fixture", path: "" });
    await controller.key("select:2"); await controller.key("enter");
    rmSync(join(root, "b.md")); rmSync(join(root, "c.md"));
    await controller.key("escape");
    expect(controller.state.selected).toBe(0);
    expect(localLines(controller.state).some((line) => line.text === "▶ a.md")).toBe(true);
  });
  it("keeps a still-valid selection and resets an empty listing to zero", async () => {
    const { root, controller } = fixture();
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(root, name), name);
    await controller.load({ op: "list", root: "fixture", path: "" });
    await controller.key("select:1"); await controller.key("r");
    expect(controller.state.selected).toBe(1);
    for (const name of ["a.md", "b.md", "c.md"]) rmSync(join(root, name));
    await controller.key("r");
    expect(controller.state.selected).toBe(0);
    expect(localLines(controller.state).some((line) => line.text === "No visible entries in this selected directory.")).toBe(true);
  });
  it("pages through a directory listing and opens the resulting selection", async () => {
    const { root, requests, controller } = fixture();
    for (let index = 0; index < 25; index++) writeFileSync(join(root, `${String(index).padStart(2, "0")}.md`), "content");
    await controller.load({ op: "list", root: "fixture", path: "" });
    await controller.key("pagedown");
    expect(controller.state.selected).toBe(10);
    await controller.key("pageup");
    expect(controller.state.selected).toBe(0);
    for (let count = 0; count < 3; count++) await controller.key("pagedown");
    expect(controller.state.selected).toBe(24);
    await controller.key("enter");
    expect(requests.at(-1)).toEqual({ op: "read", root: "fixture", path: "24.md" });
  });
  it("does not change a newer selection when an old listing finishes late", async () => {
    let finish!: (result: LocalResult) => void;
    const controller = new LocalReadingController(() => new Promise((resolve) => { finish = resolve; }), () => {});
    const pending = controller.load({ op: "list", root: "fixture", path: "old" });
    controller.close(); controller.state.selected = 4;
    finish({ entries: [] }); await pending;
    expect(controller.state.selected).toBe(4);
  });
});
