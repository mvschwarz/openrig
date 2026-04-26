import { execFileSync } from "node:child_process";

export function findBlockedDocsPaths(paths) {
  return [...new Set(paths)]
    .filter((file) => file.startsWith("docs/"))
    .filter((file) => !file.startsWith("docs/as-built/"))
    .filter((file) => !file.startsWith("docs/reference/"))
    .filter((file) => !file.startsWith("docs/releases/"))
    .sort();
}

export function listTrackedDocsPaths(exec = execFileSync) {
  const output = exec("git", ["ls-files", "docs/**"], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildDocsGuardMessage(blockedPaths) {
  const lines = [
    "Blocked tracked docs paths detected outside docs/as-built/, docs/reference/, and docs/releases/:",
    ...blockedPaths.map((file) => `- ${file}`),
    "",
    "Only docs/as-built/, docs/reference/, and docs/releases/ are allowed to be tracked.",
    "Keep plans and local notes untracked under docs/ or move durable docs into docs/as-built/, docs/reference/, or docs/releases/ if they truly belong in git.",
  ];
  return lines.join("\n");
}

export function main() {
  const blockedPaths = findBlockedDocsPaths(listTrackedDocsPaths());
  if (blockedPaths.length === 0) return;
  console.error(buildDocsGuardMessage(blockedPaths));
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
