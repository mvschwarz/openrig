import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAllowedFile } from "@openrig/daemon/local-reading";
import { parseCommand } from "../src/grammar.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("literal TUI command arguments", () => {
  it("reads the requested file, not a different file with collapsed spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-literal-argument-")); roots.push(root);
    writeFileSync(join(root, "run  book.md"), "requested document");
    writeFileSync(join(root, "run book.md"), "different document");
    const action = parseCommand("read workspace/run  book.md");
    expect(action.type).toBe("file-open");
    if (action.type !== "file-open") throw new Error("file action required");
    expect(readAllowedFile([{ name: "workspace", canonicalPath: realpathSync(root) }], action.target.root, action.target.path).content).toBe("requested document");
  });
  it.each(["two  spaces", "a\tb", "Unicode α  β"])("keeps find/prefix filter parity for %s", (text) => {
    expect(parseCommand(`find ${text}`)).toEqual(parseCommand(`/${text}`));
  });
  it("preserves literal file path and heading arguments", () => {
    expect(parseCommand("read workspace/path  name.md#My  heading")).toEqual({ type: "file-open", target: { root: "workspace", path: "path  name.md", anchor: "My  heading" } });
  });
  it("still trims command delimiters, accepts tabs between verb and argument, and reports missing args", () => {
    expect(parseCommand("  tab   graph  ")).toEqual({ type: "tab", tab: "graph" });
    expect(parseCommand("tab\tgraph")).toEqual({ type: "tab", tab: "graph" });
    expect(parseCommand("read   ").type).toBe("error");
    expect(parseCommand("  ")).toEqual({ type: "noop" });
    expect(parseCommand("frobnicate  argument").type).toBe("error");
  });
});
