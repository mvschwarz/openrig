import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { selectVariant } from "../src/domain/kernel-boot.js";

const specs = resolve(import.meta.dirname, "../specs");
const reviews = new SpecReviewService();

describe("kernel catalog preview versus selected materialization (#21)", () => {
  it("labels the library's default graph without pretending it is the running kernel", () => {
    const library = new SpecLibraryService({ roots: [{ path: specs, sourceType: "builtin" }], specReviewService: reviews });
    library.scan();
    const entry = library.list({ kind: "rig" }).find(e => e.relativePath === "rigs/launch/kernel/rig.yaml")!;
    const { yaml } = library.get(entry.id)!;
    const review = reviews.reviewRigSpec(yaml, "library_item");
    expect(review.summary).toBe(entry.summary);
    expect(review.summary).toContain("Library preview of the default dual-runtime template");
    expect(review.summary).toContain("not the running kernel");
    expect(review.summary).toContain("rig ps --nodes --rig kernel");
    expect(review.graph.nodes.map(n => n.runtime).sort()).toEqual(["claude-code", "codex", "codex", "terminal"]);
  });

  it.each([
    ["ok", "unavailable", "rig-claude-only.yaml", ["claude-code", "claude-code", "claude-code", "terminal"]],
    ["ok", "ok", "rig.yaml", ["claude-code", "codex", "codex", "terminal"]],
    ["unavailable", "ok", "rig-codex-only.yaml", ["codex", "codex", "codex", "terminal"]],
  ] as const)("keeps the %s/%s selection and its actual member runtimes", (claudeCode, codex, filename, runtimes) => {
    // Pure selection plus the exact selected source, not bootstrap/auth probing.
    expect(selectVariant({ claudeCode, codex })).toBe(filename);
    const yaml = readFileSync(resolve(specs, "rigs/launch/kernel", filename), "utf8");
    const selected = reviews.reviewRigSpec(yaml, "file_preview");
    expect(selected.graph.nodes.map(n => n.runtime).sort()).toEqual(runtimes);
  });
});
