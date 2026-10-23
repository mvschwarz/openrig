// Mutate cwd only in this child; never in the test runner or an installed daemon.
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { withNodeConfigResolver } from "../../src/domain/profile-resolution-worker.js";
import type { ResolutionContext } from "../../src/domain/profile-resolver.js";

const [root, mode] = process.argv.slice(2) as [string, string];
const context = JSON.parse(readFileSync(join(root, "context.json"), "utf8")) as ResolutionContext;
const gone = join(root, "gone");
mkdirSync(gone);
process.chdir(gone);
if (mode === "deleted-cached") process.cwd();
rmdirSync(gone);
const result = await withNodeConfigResolver(async resolve => {
  const first = await resolve(context);
  writeFileSync(join(root, ".agents", "skills", "different-folder", "SKILL.md"),
    "---\nname: renamed\ndescription: Test skill\n---\nBody\n");
  const next = await resolve(context);
  return { first, next };
});
console.log(JSON.stringify(result));
