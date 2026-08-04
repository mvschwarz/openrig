// Slice-03 V3 delivery-free noun gate: context packs are composed and managed
// by `rig context`; startup_files must never turn one into a send_text action.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeStartupBlock, validateStartupFile } from "../src/domain/startup-validation.js";

describe("startup_files rejects the retired delivery-coupled context_pack representation", () => {
  it.each([
    { kind: "context_pack", ref: "packs/release-priming" },
    { kind: "context_pack", name: "release-priming", version: "1" },
  ])("rejects $kind input rather than converting it to send_text", (entry) => {
    const errors = validateStartupFile(entry, 0, "");
    expect(errors.join("\n")).toMatch(/context_pack.*not supported|compose.*dedicated.*delivery/i);
  });

  it("preserves ordinary startup file normalization", () => {
    expect(validateStartupFile({ kind: "file", path: "skill.md" }, 0, "")).toEqual([]);
    const block = normalizeStartupBlock({ files: [{ path: "skill.md" }] });
    expect(block.files[0]).toMatchObject({ kind: "file", path: "skill.md" });
  });

  it("has no production representation or expansion path from context_pack to send_text", () => {
    const paths = [
      "../src/domain/startup-validation.ts",
      "../src/domain/runtime-adapter.ts",
      "../src/domain/types.ts",
      "../src/domain/rigspec-instantiator.ts",
    ];
    const source = paths.map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    expect(source).not.toContain("contextPackRef");
    expect(source).not.toContain("expandContextPackStartupFiles");
    expect(source).not.toMatch(/kind\??:\s*"file"\s*\|\s*"context_pack"/);
    expect(source).not.toMatch(/context_pack[\s\S]{0,500}send_text/);
  });
});
