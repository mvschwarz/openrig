import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Mirror canonical skills from packages/daemon/specs/agents/shared/skills/
// to <repo-root>/skills/_canonical/. Hand-authored files at <repo-root>/skills/
// (README, CHANGELOG, LICENSE, plugin manifests) live alongside _canonical/
// and are NEVER touched by the mirror — strict-ownership lets us add new
// top-level files without coupling the script to the destination shape.

export const SOURCE_DIR = "packages/daemon/specs/agents/shared/skills/";
export const TARGET_DIR = "skills/_canonical/";

export const EXCLUDES = [
  "feedback.md",
  "evals/",
  ".DS_Store",
  "*.local.md",
];

function rsyncArgs({ dryRun }) {
  // --checksum compares file contents via hash instead of mtime+size.
  // Used in --check (dry-run) mode so the drift-detect is content-stable
  // — a `git checkout` or `cp` updating mtimes does NOT register as drift
  // when the bytes match. In apply mode we keep the default (mtime+size)
  // for speed; rsync's archive flag preserves mtime so subsequent checks
  // stay clean.
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n", "--checksum"] : []),
    ...EXCLUDES.map((p) => `--exclude=${p}`),
    SOURCE_DIR,
    TARGET_DIR,
  ];
}

// Parse rsync --itemize-changes output for content-meaningful changes.
// First-column codes per rsync(1):
//   `<` / `>` — file transferred (content change)
//   `c`        — created entry (file/dir/symlink/device)
//   `h`        — hardlink redirected
//   `.`        — item exists with NO update OR metadata-only update
//                (we want to ignore these — content is stable)
//   `*`        — message line; we only care about `*deleting `
// In --check mode the script invokes rsync with `--checksum`, so a `.`
// leading line means the bytes match even if mtime drifts (e.g., after
// `git checkout` or `cp`); we deliberately skip those to keep the
// drift-detect content-stable.
export function parseChanges(output) {
  const lines = output.split("\n").filter(Boolean);
  return lines.filter(
    (line) =>
      /^[<>ch][fdLDS]/.test(line.slice(0, 2)) ||
      line.startsWith("*deleting "),
  );
}

export function buildStaleMessage(changes) {
  return [
    "Skills mirror is stale at skills/_canonical/. Run: npm run mirror-skills",
    "Changes that would land:",
    ...changes.map((c) => `  ${c}`),
  ].join("\n");
}

function runRsync({ dryRun }, exec = execFileSync) {
  return exec("rsync", rsyncArgs({ dryRun }), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function ensureTargetExists() {
  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }
}

export function checkMode(exec = execFileSync) {
  ensureTargetExists();
  const output = runRsync({ dryRun: true }, exec);
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

export function applyMode(exec = execFileSync) {
  ensureTargetExists();
  return runRsync({ dryRun: false }, exec);
}

export function main(argv = process.argv.slice(2)) {
  const isCheck = argv.includes("--check");

  if (isCheck) {
    const { stale, changes } = checkMode();
    if (stale) {
      console.error(buildStaleMessage(changes));
      process.exitCode = 1;
    }
    return;
  }

  const output = applyMode();
  const changes = parseChanges(output);
  if (changes.length === 0) {
    console.log("Skills mirror already in sync; no changes.");
  } else {
    console.log(`Skills mirror updated. ${changes.length} change(s):`);
    for (const c of changes) console.log(`  ${c}`);
  }
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  main();
}
