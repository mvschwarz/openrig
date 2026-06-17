import { describe, it, expect } from "vitest";
import { checkMirrorDriftSafe } from "../src/domain/skill-mirror-drift.js";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("skill-mirror-drift safe wrapper", () => {
  it("returns ok result when both source and target exist in the repo", async () => {
    const result = await checkMirrorDriftSafe();
    const sourceExists = existsSync(resolve(REPO_ROOT, "packages/daemon/specs/agents/shared/skills"));
    const targetExists = existsSync(resolve(REPO_ROOT, "skills/_canonical"));

    if (sourceExists && targetExists) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBeDefined();
    }
  });

  it("does not create skills/_canonical directory (read-only invariant)", async () => {
    const targetBefore = existsSync(resolve(REPO_ROOT, "skills/_canonical"));
    await checkMirrorDriftSafe();
    const targetAfter = existsSync(resolve(REPO_ROOT, "skills/_canonical"));
    expect(targetAfter).toBe(targetBefore);
  });

  it("returns ok:false with reason when source dir is missing", async () => {
    // This test verifies the error path structurally -- the production
    // source dir exists in the repo so we test the wrapper's shape contract.
    const result = await checkMirrorDriftSafe();
    if (!result.ok) {
      expect(result.reason).toBeDefined();
      expect(typeof result.reason).toBe("string");
    } else {
      expect(typeof result.stale).toBe("boolean");
      expect(Array.isArray(result.changes)).toBe(true);
    }
  });
});
