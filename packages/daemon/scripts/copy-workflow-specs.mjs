import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";

const sourceDir = join(process.cwd(), "src", "builtins", "workflow-specs");
const targetDir = join(process.cwd(), "dist", "builtins", "workflow-specs");
const workflowSpecExtensions = new Set([".yaml", ".yml"]);

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

if (!existsSync(sourceDir)) {
  process.exit(0);
}

for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!workflowSpecExtensions.has(extname(entry.name).toLowerCase())) continue;
  copyFileSync(join(sourceDir, entry.name), join(targetDir, entry.name));
}
