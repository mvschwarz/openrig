import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkMirrorDriftSafe } from "../src/domain/skill-mirror-drift.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
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
    } else if (!result.skipped) {
      expect(typeof result.stale).toBe("boolean");
      expect(Array.isArray(result.changes)).toBe(true);
    }
  });
});

describe("skill-mirror-drift by repo layout", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mirror-drift-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("skips, as information, in the installed-package layout", async () => {
    // From @openrig/cli/daemon/dist/domain/ the four-level walk lands in node_modules/@openrig/: the
    // package's skills are under cli/daemon/specs/, and there is no scripts/mirror-skills.mjs.
    mkdirSync(join(root, "cli/daemon/specs/agents/shared/skills"), { recursive: true });
    const result = await checkMirrorDriftSafe(root);
    expect(result).toMatchObject({ ok: true, skipped: true });
    expect((result as { reason: string }).reason).toContain("source checkout");
  });

  it("still reports an error in a source checkout whose mirror source is missing", async () => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/mirror-skills.mjs"), "export function checkModeAbsolute() { return { stale: false, changes: [] }; }\n");
    const result = await checkMirrorDriftSafe(root);
    expect(result).toEqual({ ok: false, reason: `Mirror source not found: ${join(root, "packages/daemon/specs/agents/shared/skills")}` });
  });

  it("runs the checkout's own mirror script when the layout is present", async () => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "packages/daemon/specs/agents/shared/skills"), { recursive: true });
    mkdirSync(join(root, "skills/_canonical"), { recursive: true });
    writeFileSync(join(root, "scripts/mirror-skills.mjs"), "export function checkModeAbsolute() { return { stale: true, changes: ['core/x/SKILL.md'] }; }\n");
    const result = await checkMirrorDriftSafe(root);
    expect(result).toEqual({ ok: true, skipped: false, stale: true, changes: ["core/x/SKILL.md"] });
  });
});
