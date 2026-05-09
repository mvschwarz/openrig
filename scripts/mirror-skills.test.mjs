import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SOURCE_DIR,
  TARGET_DIR,
  EXCLUDES,
  parseChanges,
  buildStaleMessage,
  checkMode,
} from "./mirror-skills.mjs";

test("parseChanges extracts file-change and deletion lines from itemize-changes output", () => {
  const output = [
    "sending incremental file list",
    ">f+++++++++ core/openrig-user/SKILL.md",
    ">f.st...... pm/plan-review/SKILL.md",
    "cd+++++++++ pods/",
    "*deleting old/skill-that-was-removed/SKILL.md",
    "",
    "sent 1234 bytes  received 56 bytes  2580.00 bytes/sec",
    "total size is 100  speedup is 0.08",
  ].join("\n");

  const changes = parseChanges(output);
  assert.deepEqual(changes, [
    ">f+++++++++ core/openrig-user/SKILL.md",
    ">f.st...... pm/plan-review/SKILL.md",
    "cd+++++++++ pods/",
    "*deleting old/skill-that-was-removed/SKILL.md",
  ]);
});

test("parseChanges returns empty array on a clean (already-mirrored) run", () => {
  const output = [
    "sending incremental file list",
    "",
    "sent 100 bytes  received 50 bytes  300.00 bytes/sec",
    "total size is 100  speedup is 0.67",
  ].join("\n");

  assert.deepEqual(parseChanges(output), []);
});

test("buildStaleMessage names the npm script and lists the pending changes", () => {
  const message = buildStaleMessage([
    ">f+++++++++ core/openrig-user/SKILL.md",
    "*deleting removed/SKILL.md",
  ]);

  assert.match(message, /Skills mirror is stale/);
  assert.match(message, /npm run mirror-skills/);
  assert.match(message, /core\/openrig-user\/SKILL\.md/);
  assert.match(message, /removed\/SKILL\.md/);
});

test("EXCLUDES bars curation-cycle bookkeeping and runtime artifacts from public surface", () => {
  // These exclusions are load-bearing — see SOP rule "feedback.md is
  // curation-cycle bookkeeping; runtime mirrors are for agent-loaded
  // skill content" (Cycle 2 retro). evals/ is per-skill eval-pilot
  // infrastructure (cases.yaml + harnesses + outcomes); it can leak
  // nested .agents/skills/ test fixtures that confuse skill inventory
  // tooling (Cycle 9 fixup retro 2026-05-09).
  assert.ok(EXCLUDES.includes("feedback.md"));
  assert.ok(EXCLUDES.includes("evals/"));
});

test("source SKILL.md inventory is non-empty (sanity check)", () => {
  // If this fails, either the source path moved or the package layout
  // changed; fix the SOURCE_DIR constant in mirror-skills.mjs.
  assert.ok(existsSync(SOURCE_DIR), `expected ${SOURCE_DIR} to exist`);
  const skills = walkSkillFiles(SOURCE_DIR);
  assert.ok(
    skills.length > 0,
    `expected at least one SKILL.md under ${SOURCE_DIR}`,
  );
});

test("mirror is in sync with source (drift-detect via --check)", () => {
  // The load-bearing assertion: skills/_canonical/ must not drift from
  // packages/daemon/specs/agents/shared/skills/. Failing this means
  // someone edited the source without running `npm run mirror-skills`.
  // Fix: run the script and re-commit.
  if (!existsSync(TARGET_DIR)) {
    // First-time bootstrap: target doesn't exist yet. The check would
    // report every source file as a pending change. Skip in that case
    // and let the operator run the initial mirror.
    return;
  }
  const { stale, changes } = checkMode(execFileSync);
  assert.equal(
    stale,
    false,
    stale
      ? `mirror drift detected (${changes.length} change(s)). Run: npm run mirror-skills`
      : "",
  );
});

test("excluded patterns are absent in the mirror target", () => {
  if (!existsSync(TARGET_DIR)) return;
  // Walk the target and assert nothing matches feedback.md / evals/ /
  // .DS_Store / *.local.md. The rsync exclusions should keep these
  // absent; this catches the case where the script was bypassed and
  // someone hand-copied content into _canonical/.
  const offenders = [];
  walk(TARGET_DIR, (path) => {
    const base = path.split("/").pop();
    if (base === "feedback.md") offenders.push(path);
    if (base === ".DS_Store") offenders.push(path);
    if (/\.local\.md$/.test(base)) offenders.push(path);
    if (path.includes("/evals/")) offenders.push(path);
  });
  assert.deepEqual(
    offenders,
    [],
    `excluded patterns leaked into mirror: ${offenders.join(", ")}`,
  );
});

// --- helpers (test-only) ---

function walkSkillFiles(root) {
  const out = [];
  walk(root, (path) => {
    if (path.endsWith("/SKILL.md")) out.push(path);
  });
  return out;
}

function walk(root, visit) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const s = statSync(path);
    if (s.isDirectory()) walk(path, visit);
    else visit(path);
  }
}
