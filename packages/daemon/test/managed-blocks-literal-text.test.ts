// Managed block content is authored text (culture, guidance, config). Every
// projection must write it unchanged. String.prototype.replace expands `$$`,
// `$&`, `` $` `` and `$'` in a replacement STRING, so the text below carries
// each of them, plus `$1`, which these capture-free patterns never expand.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/domain/generated-file-hygiene.js", () => ({ excludeNewGeneratedFiles: () => [] }));

import { MANAGED_BLOCK_END, MANAGED_BLOCK_START, mergeManagedBlock } from "../src/domain/managed-blocks.js";

const DOLLAR_TEXT = "echo $$ pid; printf $'\\n'; regex $& and $` and $'; keep $1 literal";
const FILE = "/ws/AGENTS.md";

function memoryFs(files: Record<string, string> = {}) {
  const store: Record<string, string> = { ...files };
  return {
    store,
    exists: (p: string) => p in store,
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    mkdirp: () => {},
  };
}

const managedBlock = (id: string, content: string) => `${MANAGED_BLOCK_START(id)}\n${content}\n${MANAGED_BLOCK_END(id)}`;

describe("managed blocks keep authored $ sequences literal", () => {
  it("re-projection writes the same block the first write did", () => {
    const fs = memoryFs();
    mergeManagedBlock(fs, FILE, "core", DOLLAR_TEXT);
    expect(fs.store[FILE]).toBe(managedBlock("core", DOLLAR_TEXT));
    for (let i = 0; i < 3; i++) {
      mergeManagedBlock(fs, FILE, "core", DOLLAR_TEXT);
      // Trailing blank-line growth on re-merge is pre-existing and out of scope here.
      expect(fs.store[FILE]!.trimEnd()).toBe(managedBlock("core", DOLLAR_TEXT));
    }
  });

  it("replaces an existing block literally and leaves the text around it unchanged", () => {
    const before = "User intro with $& and $$\n\n";
    const after = "\n\nUser notes with $' and $`\n";
    const fs = memoryFs({ [FILE]: `${before}${managedBlock("core", "old guidance")}${after}` });
    const expected = `${before}${managedBlock("core", DOLLAR_TEXT)}${after}`;
    for (let i = 0; i < 3; i++) {
      mergeManagedBlock(fs, FILE, "core", DOLLAR_TEXT);
      expect(fs.store[FILE]!.trimEnd()).toBe(expected.trimEnd());
    }
  });

  it("replaces a legacy-marker block with the OpenRig form, literally", () => {
    const legacy = "<!-- BEGIN RIGGED MANAGED BLOCK: core -->\nold guidance\n<!-- END RIGGED MANAGED BLOCK: core -->";
    const before = "Before $$ text\n\n";
    const after = "\n\nAfter $' text\n";
    const fs = memoryFs({ [FILE]: `${before}${legacy}${after}` });
    mergeManagedBlock(fs, FILE, "core", DOLLAR_TEXT);
    expect(fs.store[FILE]!.trimEnd()).toBe(`${before}${managedBlock("core", DOLLAR_TEXT)}${after}`.trimEnd());
    expect(fs.store[FILE]).not.toContain("RIGGED MANAGED BLOCK");
  });
});
