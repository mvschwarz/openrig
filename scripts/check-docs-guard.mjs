import { execFileSync } from "node:child_process";

/**
 * Exact tracked docs paths allowed outside the three durable roots.
 *
 * `docs/DESIGN.md` is the canonical visual/brand/design-system spec, and its root placement is
 * RATIFIED doctrine, not drift: `docs/as-built/ui/library-specs-and-design-system.md` §4 states
 * "Q1 is ratified: DESIGN.md stays at root, byte-identical", explicitly rejecting
 * `docs/as-built/`. This guard simply never encoded that decision.
 *
 * It also cannot be satisfied by relocating into any allowed root:
 *   docs/as-built/  — every file there carries `last-verified-against-source`; DESIGN.md is not
 *                     source-derived, and Q1 rules this destination out by name
 *   docs/reference/ — that directory SHIPS (scripts/build-package.sh stages it into the package
 *                     and the daemon materializes it to $OPENRIG_HOME/reference/), so moving
 *                     there would start distributing the brand spec to every operator
 *   docs/releases/  — not a release note
 *
 * So it is named here as an EXACT PATH rather than relocated or covered by a widened directory
 * allowance. Keep this exact-path: the policy this guard enforces is "loose plans and notes stay
 * untracked", and a directory hole would quietly readmit exactly that.
 */
const ALLOWED_DOCS_FILES = new Set(["docs/DESIGN.md"]);

export function findBlockedDocsPaths(paths) {
  return [...new Set(paths)]
    .filter((file) => file.startsWith("docs/"))
    .filter((file) => !file.startsWith("docs/as-built/"))
    .filter((file) => !file.startsWith("docs/reference/"))
    .filter((file) => !file.startsWith("docs/releases/"))
    .filter((file) => !ALLOWED_DOCS_FILES.has(file))
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
