import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Four levels up from packages/daemon/{src,dist}/domain/ is the repo root in a source checkout. In the
// published package this file sits at @openrig/cli/daemon/dist/domain/, so the same walk lands in
// node_modules/@openrig/, where there is no mirror to check.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MIRROR_SCRIPT = "scripts/mirror-skills.mjs";

export type MirrorDriftSafeResult =
  | { ok: true; skipped: false; stale: boolean; changes: string[] }
  // Not a source checkout (an installed package): the check has nothing to compare and is skipped.
  | { ok: true; skipped: true; reason: string }
  | { ok: false; reason: string };

export async function checkMirrorDriftSafe(repoRoot: string = REPO_ROOT): Promise<MirrorDriftSafeResult> {
  const scriptPath = resolve(repoRoot, MIRROR_SCRIPT);
  if (!existsSync(scriptPath)) {
    return {
      ok: true,
      skipped: true,
      reason: `Mirror drift check skipped: no ${MIRROR_SCRIPT} under ${repoRoot}; it runs only in an OpenRig source checkout`,
    };
  }
  const sourceDir = resolve(repoRoot, "packages/daemon/specs/agents/shared/skills");
  const targetDir = resolve(repoRoot, "skills/_canonical");
  if (!existsSync(sourceDir)) {
    return { ok: false, reason: `Mirror source not found: ${sourceDir}` };
  }
  if (!existsSync(targetDir)) {
    return { ok: false, reason: `Mirror target not found: ${targetDir}` };
  }

  try {
    const mod = await import(pathToFileURL(scriptPath).href) as {
      checkModeAbsolute: (source: string, target: string) => { stale: boolean; changes: string[] };
    };
    const result = mod.checkModeAbsolute(sourceDir, targetDir);
    return { ok: true, skipped: false, stale: result.stale, changes: result.changes };
  } catch (err) {
    return { ok: false, reason: `Mirror drift check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
