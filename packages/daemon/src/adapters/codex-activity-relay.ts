import fs from "node:fs";
import path from "node:path";
import { replaceFile } from "./replace-file.js";

/** Keep the running daemon's relay at an install-independent entry point. */
export function stageCodexActivityRelay({
  stateDir,
  sourceDir = path.resolve(import.meta.dirname, "../../assets/plugins/openrig-core/hooks/scripts"),
}: {
  stateDir: string;
  sourceDir?: string;
}): string {
  const targetDir = path.join(stateDir, "runtime/assets/plugins/openrig-core/hooks/scripts");
  // Read every required asset before changing the published copy. Publish the
  // helper first so the entry point never precedes its dependency.
  const assets = ["permission-stop-descriptor.cjs", "activity-relay.cjs"].map(name => ({
    source: path.join(sourceDir, name),
    target: path.join(targetDir, name),
    content: fs.readFileSync(path.join(sourceDir, name)),
  }));
  fs.mkdirSync(targetDir, { recursive: true });
  for (const asset of assets) {
    let current: Buffer | undefined;
    try {
      current = fs.readFileSync(asset.target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!current?.equals(asset.content)) replaceFile(asset.source, asset.target, { atomicOnly: true });
  }
  return path.join(targetDir, "activity-relay.cjs");
}
