import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  SOURCE_DIR,
  TARGET_DIR,
  EXCLUDES,
  parseChanges,
  buildStaleMessage,
  checkMode,
  checkModeAbsolute,
} from "./mirror-skills.mjs";

test("parseChanges extracts file-change and deletion lines from itemize-changes output", () => {
  const output = [
    "sending incremental file list",
    ">f+++++++++ core/openrig-user/SKILL.md",
    ">f.st...... pm/plan-review/SKILL.md",
    ".f...p..... process/systematic-debugging/find-polluter.sh",
    ".f..t...... core/openrig-user/SKILL.md",
    "cd+++++++++ pods/",
    "*deleting old/skill-that-was-removed/SKILL.md",
    "*deleting old/skill-that-was-removed/SKILL.md",
    "*deleting old/another-removed-skill/SKILL.md",
    "",
    "sent 1234 bytes  received 56 bytes  2580.00 bytes/sec",
    "total size is 100  speedup is 0.08",
  ].join("\n");

  const changes = parseChanges(output);
  assert.deepEqual(changes, [
    ">f+++++++++ core/openrig-user/SKILL.md",
    ">f.st...... pm/plan-review/SKILL.md",
    ".f...p..... process/systematic-debugging/find-polluter.sh",
    "cd+++++++++ pods/",
    "*deleting old/skill-that-was-removed/SKILL.md",
    "*deleting old/another-removed-skill/SKILL.md",
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

test("stagePublicSkills applies membership, path, frontmatter, and fence transforms", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(
    typeof mirror.stagePublicSkills,
    "function",
    "stagePublicSkills must be exported",
  );

  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-red-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    write(
      join(canon, "public-skill", "SKILL.md"),
      [
        "---",
        "name: public-skill",
        "description: public",
        "distribution_scope: product-bound",
        "source_evidence: openrig-work/private.md",
        "curation_note: remove-me",
        "content_curator: reviewer",
        "transfer_test: pending",
        "naming_note: historical",
        "last_verified: 2026-07-01",
        "private_path: openrig-work/host-only.md",
        "internal_owner: operator-agent@kernel",
        "metadata:",
        "  openrig:",
        "    stage: factory-approved",
        "    sibling_skills:",
        "      - public-sibling",
        "---",
        "",
        "Visible.",
        "<!-- internal:begin -->",
        "operator-agent@kernel",
        "<!-- internal:end -->",
        "Still visible.",
        "",
      ].join("\n"),
    );
    write(join(canon, "public-skill", "notes.internal.md"), "secret\n");
    write(join(canon, "public-skill", "internal", "host.md"), "secret\n");
    write(join(canon, "private-skill", "SKILL.md"), "# private\n");
    write(join(canon, "operator-internal", "SKILL.md"), "# whole internal\n");

    await mirror.stagePublicSkills({
      canonRoot: canon,
      stagingRoot: staging,
      membership: membershipFixture({
        clean: ["public-skill", "operator-internal"],
      }),
      rules: fixtureRules(),
    });

    const shipped = readFileSync(
      join(staging, "public-skill", "SKILL.md"),
      "utf8",
    );
    assert.match(shipped, /name: public-skill/);
    assert.match(shipped, /metadata:/);
    assert.match(shipped, /stage: factory-approved/);
    assert.match(shipped, /public-sibling/);
    assert.match(shipped, /Visible\./);
    assert.match(shipped, /Still visible\./);
    assert.doesNotMatch(shipped, /distribution_scope/);
    assert.doesNotMatch(shipped, /source_evidence/);
    assert.doesNotMatch(shipped, /curation_note/);
    assert.doesNotMatch(shipped, /content_curator/);
    assert.doesNotMatch(shipped, /transfer_test/);
    assert.doesNotMatch(shipped, /naming_note/);
    assert.doesNotMatch(shipped, /last_verified/);
    assert.doesNotMatch(shipped, /private_path/);
    assert.doesNotMatch(shipped, /internal_owner/);
    assert.doesNotMatch(shipped, /operator-agent@kernel/);
    assert.equal(existsSync(join(staging, "public-skill", "notes.internal.md")), false);
    assert.equal(existsSync(join(staging, "public-skill", "internal")), false);
    assert.equal(existsSync(join(staging, "private-skill")), false);
    assert.equal(existsSync(join(staging, "operator-internal")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills preserves prose and executable source modes", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-modes-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    const skill = join(canon, "alpha", "SKILL.md");
    const script = join(canon, "alpha", "scripts", "run.sh");
    write(skill, "# Alpha\n");
    write(script, "#!/bin/sh\nexit 0\n");
    chmodSync(skill, 0o644);
    chmodSync(script, 0o755);

    await mirror.stagePublicSkills({
      canonRoot: canon,
      stagingRoot: staging,
      membership: membershipFixture({ clean: ["alpha"] }),
      rules: fixtureRules(),
    });

    assert.equal(
      statSync(join(staging, "alpha", "SKILL.md")).mode & 0o777,
      0o644,
    );
    assert.equal(
      statSync(join(staging, "alpha", "scripts", "run.sh")).mode & 0o777,
      0o755,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills applies existing EXCLUDES before scanning or copying", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-excludes-red-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    write(join(canon, "alpha", "SKILL.md"), "# Public alpha\n");
    for (const path of [
      "feedback.md",
      "evals/case.md",
      ".DS_Store",
      "notes.local.md",
    ]) {
      write(join(canon, "alpha", path), "founder-only excluded fixture\n");
    }

    await mirror.stagePublicSkills({
      canonRoot: canon,
      stagingRoot: staging,
      membership: membershipFixture({ clean: ["alpha"] }),
      rules: fixtureRules(),
    });

    assert.equal(
      readFileSync(join(staging, "alpha", "SKILL.md"), "utf8"),
      "# Public alpha\n",
    );
    for (const path of [
      "feedback.md",
      "evals",
      ".DS_Store",
      "notes.local.md",
    ]) {
      assert.equal(existsSync(join(staging, "alpha", path)), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills recursively strips configured keys and internal values while preserving clean metadata", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(typeof mirror.stagePublicSkills, "function");

  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-nested-red-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    write(
      join(canon, "public-skill", "SKILL.md"),
      [
        "---",
        "name: public-skill",
        "structure: public-sections",
        "metadata:",
        "  openrig:",
        "    stage: factory-approved",
        "    distribution_scope: product-bound",
        "    source_evidence: |",
        "      private provenance",
        "    curation_note: remove-me",
        "    content_curator: reviewer",
        "    transfer_test: pending",
        "    transfer_test_notes: remove-me-too",
        "    naming_note: historical",
        "    last_verified: 2026-07-01",
        "    structure: openrig-work/private-layout.md",
        "    source_location: openrig-work/private-source.md",
        "    sibling_skills:",
        "      - public-sibling",
        "---",
        "",
        "# Public",
        "",
      ].join("\n"),
    );

    await mirror.stagePublicSkills({
      canonRoot: canon,
      stagingRoot: staging,
      membership: membershipFixture({ clean: ["public-skill"] }),
      rules: fixtureRules(),
    });

    const shipped = readFileSync(
      join(staging, "public-skill", "SKILL.md"),
      "utf8",
    );
    assert.match(shipped, /metadata:/);
    assert.match(shipped, /stage: factory-approved/);
    assert.match(shipped, /sibling_skills:/);
    assert.match(shipped, /public-sibling/);
    for (const key of [
      "distribution_scope",
      "source_evidence",
      "curation_note",
      "content_curator",
      "transfer_test",
      "transfer_test_notes",
      "naming_note",
      "last_verified",
      "structure",
    ]) {
      assert.doesNotMatch(shipped, new RegExp(`^\\s*${key}:`, "m"));
    }
    assert.doesNotMatch(shipped, /^\s*source_location:/m);
    assert.doesNotMatch(shipped, /openrig-work\/private-(?:layout|source)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills aborts an unmatched internal fence with file and line", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(typeof mirror.stagePublicSkills, "function");

  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-red-"));
  try {
    const canon = join(root, "canon");
    write(
      join(canon, "public-skill", "SKILL.md"),
      "# Public\n\n<!-- internal:begin -->\nsecret\n",
    );

    await assert.rejects(
      mirror.stagePublicSkills({
        canonRoot: canon,
        stagingRoot: join(root, "staging"),
        membership: membershipFixture({ clean: ["public-skill"] }),
        rules: fixtureRules(),
      }),
      (error) => {
        assert.match(error.message, /public-skill\/SKILL\.md/);
        assert.match(error.message, /line 3/i);
        assert.match(error.message, /unbalanced|unmatched/i);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills strips internal fences from non-SKILL Markdown without sanitizing ordinary content", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-markdown-red-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    write(join(canon, "alpha", "SKILL.md"), "# Public skill\n");

    for (const path of ["references/guide.md", "references/walkthrough.mdx"]) {
      write(
        join(canon, "alpha", path),
        [
          "---",
          "distribution_scope: ordinary-reference-metadata",
          "---",
          "# Public before",
          "ordinary reference content remains",
          "<!-- internal:begin -->",
          "private prose deliberately outside the denylist",
          "<!-- internal:end -->",
          "# Public after",
          "",
        ].join("\n"),
      );
    }

    await mirror.stagePublicSkills({
      canonRoot: canon,
      stagingRoot: staging,
      membership: membershipFixture({ clean: ["alpha"] }),
      rules: fixtureRules(),
    });

    for (const path of ["references/guide.md", "references/walkthrough.mdx"]) {
      const shipped = readFileSync(join(staging, "alpha", path), "utf8");
      assert.match(shipped, /distribution_scope: ordinary-reference-metadata/);
      assert.match(shipped, /# Public before/);
      assert.match(shipped, /ordinary reference content remains/);
      assert.match(shipped, /# Public after/);
      assert.doesNotMatch(shipped, /internal:(?:begin|end)/);
      assert.doesNotMatch(shipped, /private prose deliberately/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills rejects an unmatched fence in non-SKILL Markdown with file and line", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-markdown-red-"));
  try {
    const canon = join(root, "canon");
    write(join(canon, "alpha", "SKILL.md"), "# Public skill\n");
    write(
      join(canon, "alpha", "references", "guide.mdx"),
      "# Public\n\n<!-- internal:begin -->\nprivate prose\n",
    );

    await assert.rejects(
      mirror.stagePublicSkills({
        canonRoot: canon,
        stagingRoot: join(root, "staging"),
        membership: membershipFixture({ clean: ["alpha"] }),
        rules: fixtureRules(),
      }),
      (error) => {
        assert.match(error.message, /alpha\/references\/guide\.mdx/);
        assert.match(error.message, /line 3/i);
        assert.match(error.message, /unbalanced|unmatched/i);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills rejects canon file symlinks before reading or staging outside bytes", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-symlink-red-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    const outside = join(root, "outside-file.txt");
    write(join(canon, "alpha", "SKILL.md"), "# Public skill\n");
    write(outside, "outside bytes deliberately outside the denylist\n");
    const link = join(canon, "alpha", "references", "linked.txt");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, "file");

    await assert.rejects(
      mirror.stagePublicSkills({
        canonRoot: canon,
        stagingRoot: staging,
        membership: membershipFixture({ clean: ["alpha"] }),
        rules: fixtureRules(),
      }),
      (error) => {
        assert.match(error.message, /symlink/i);
        assert.match(error.message, /alpha\/references\/linked\.txt/);
        return true;
      },
    );
    assert.equal(
      existsSync(join(staging, "alpha", "references", "linked.txt")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills rejects canon directory symlinks before recursion or staging outside bytes", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-symlink-red-"));
  try {
    const canon = join(root, "canon");
    const staging = join(root, "staging");
    const outside = join(root, "outside-directory");
    write(join(canon, "alpha", "SKILL.md"), "# Public skill\n");
    write(join(outside, "secret.txt"), "outside directory bytes\n");
    const link = join(canon, "alpha", "references", "linked-directory");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, "dir");

    await assert.rejects(
      mirror.stagePublicSkills({
        canonRoot: canon,
        stagingRoot: staging,
        membership: membershipFixture({ clean: ["alpha"] }),
        rules: fixtureRules(),
      }),
      (error) => {
        assert.match(error.message, /symlink/i);
        assert.match(error.message, /alpha\/references\/linked-directory/);
        return true;
      },
    );
    assert.equal(
      existsSync(join(staging, "alpha", "references", "linked-directory")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePublicSkills is deterministic for the same clean input", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(typeof mirror.stagePublicSkills, "function");

  const root = mkdtempSync(join(tmpdir(), "openrig-mirror-red-"));
  try {
    const canon = join(root, "canon");
    write(join(canon, "public-skill", "SKILL.md"), "---\nname: public-skill\n---\n\n# Public\n");
    write(join(canon, "public-skill", "references", "guide.md"), "# Guide\n");

    const first = join(root, "first");
    const second = join(root, "second");
    const input = {
      canonRoot: canon,
      membership: membershipFixture({ clean: ["public-skill"] }),
      rules: fixtureRules(),
    };
    await mirror.stagePublicSkills({ ...input, stagingRoot: first });
    await mirror.stagePublicSkills({ ...input, stagingRoot: second });

    assert.deepEqual(snapshotTree(first), snapshotTree(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shipSetFromMembership consumes exactly the six shipping categories", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(
    typeof mirror.shipSetFromMembership,
    "function",
    "shipSetFromMembership must be exported",
  );

  const shipSet = mirror.shipSetFromMembership({
    version: 0,
    product_public: {
      clean: ["clean", "duplicate"],
      ship_after_fix: ["after", "duplicate"],
      ship_misses_add: ["miss"],
      sanitize_borderlines_ship: ["sanitize"],
      // P6(A) leg-2 fix: restored_role_pm_selected is now a CONSUMED ship category. Before the fix
      // this member fell out of the ship set silently (the 0.4.8/864cea6b stranding); it must ship.
      restored_role_pm_selected: ["restored"],
    },
    vendored_ship_with_provenance: ["vendored"],
    not_public: {
      reclass_host_only: ["host-only"],
      private_with_public_sibling_pending: ["private"],
    },
    pending_author_public: ["pending"],
  });

  assert.deepEqual(shipSet, [
    "after",
    "clean",
    "duplicate",
    "miss",
    "restored",
    "sanitize",
    "vendored",
  ]);
});

test("shipSetFromMembership subtracts not_public and pending overlaps", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(typeof mirror.shipSetFromMembership, "function");

  const shipSet = mirror.shipSetFromMembership({
    version: 0,
    product_public: {
      clean: ["blocked", "ok", "pending"],
      ship_after_fix: [],
      ship_misses_add: [],
      sanitize_borderlines_ship: [],
    },
    vendored_ship_with_provenance: [],
    not_public: {
      reclass_host_only: ["blocked"],
    },
    pending_author_public: ["pending"],
  });

  assert.deepEqual(shipSet, ["ok"]);
});

test("checkGeneratedEdges detects layout and digest drift without invoking the leak scanner", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(
    typeof mirror.checkGeneratedEdges,
    "function",
    "checkGeneratedEdges must be exported",
  );

  const root = mkdtempSync(join(tmpdir(), "openrig-digest-red-"));
  try {
    const specPath = "packages/daemon/specs/agents/shared/skills";
    const canonicalPath = "skills/_canonical";
    const pluginPath = "packages/daemon/assets/plugins/openrig-core/skills";
    write(join(root, specPath, "core", "alpha", "SKILL.md"), "# Alpha\n");
    write(join(root, specPath, "core", "alpha", "references", "guide.md"), "# Guide\n");
    write(join(root, canonicalPath, "core", "alpha", "SKILL.md"), "# Alpha\n");
    write(join(root, canonicalPath, "core", "alpha", "references", "guide.md"), "# Guide\n");
    write(join(root, pluginPath, "alpha", "SKILL.md"), "# Alpha\n");
    write(join(root, pluginPath, "alpha", "references", "guide.md"), "# Guide\n");

    const layout = {
      version: 0,
      edges: {
        spec: { path: specPath, layout: "categorized" },
        canonical: { path: canonicalPath, layout: "mirror-of-spec" },
        plugin: { path: pluginPath, layout: "flat" },
      },
      skills: {
        alpha: { edges: ["spec", "canonical", "plugin"], category: "core" },
      },
    };
    const digests = {
      version: 1,
      edges: {
        spec: {
          "core/alpha/SKILL.md": sha256("# Alpha\n"),
          "core/alpha/references/guide.md": sha256("# Guide\n"),
        },
        canonical: {
          "core/alpha/SKILL.md": sha256("# Alpha\n"),
          "core/alpha/references/guide.md": sha256("# Guide\n"),
        },
        plugin: {
          "alpha/SKILL.md": sha256("# Alpha\n"),
          "alpha/references/guide.md": sha256("# Guide\n"),
        },
      },
    };
    let scannerCalls = 0;
    const clean = await mirror.checkGeneratedEdges({
      repoRoot: root,
      layout,
      digests,
      scan: () => {
        scannerCalls += 1;
        throw new Error("provisional scanner must not run from mirror --check");
      },
    });
    assert.deepEqual(clean, { stale: false, changes: [] });
    assert.equal(scannerCalls, 0);

    write(join(root, pluginPath, "alpha", "SKILL.md"), "# Changed\n");
    const drift = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests });
    assert.equal(drift.stale, true);
    assert.ok(
      drift.changes.some(
        (change) =>
          change.edge === "plugin" &&
          change.path === "alpha/SKILL.md" &&
          change.reason === "digest",
        ),
    );

    write(join(root, pluginPath, "alpha", "SKILL.md"), "# Alpha\n");
    write(join(root, pluginPath, "alpha", "unexpected.txt"), "extra\n");
    const added = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests });
    assert.ok(
      added.changes.some(
        (change) =>
          change.edge === "plugin" &&
          change.path === "alpha/unexpected.txt" &&
          change.reason === "unexpected",
      ),
    );

    rmSync(join(root, pluginPath, "alpha", "unexpected.txt"));
    rmSync(join(root, pluginPath, "alpha", "references", "guide.md"));
    const missing = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests });
    assert.ok(
      missing.changes.some(
        (change) =>
          change.edge === "plugin" &&
          change.path === "alpha/references/guide.md" &&
          change.reason === "missing",
      ),
    );

    write(join(root, pluginPath, "alpha", "guide.md"), "# Guide\n");
    const relocated = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests });
    assert.ok(
      relocated.changes.some(
        (change) =>
          change.edge === "plugin" &&
          change.path === "alpha/guide.md" &&
          change.reason === "unexpected",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkGeneratedEdges — external-canon-pending allowlist: named-missing tolerated, OTHER-missing loud, reappearance flagged stale", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-extcanon-"));
  try {
    const specPath = "packages/daemon/specs/agents/shared/skills";
    const canonicalPath = "skills/_canonical";
    const pluginPath = "packages/daemon/assets/plugins/openrig-core/skills";
    write(join(root, specPath, "core", "alpha", "SKILL.md"), "# Alpha\n"); // present + digested control
    write(join(root, canonicalPath, "core", "alpha", "SKILL.md"), "# Alpha\n");
    write(join(root, pluginPath, "alpha", "SKILL.md"), "# Alpha\n");
    const layout = {
      version: 0,
      edges: {
        spec: { path: specPath, layout: "categorized" },
        canonical: { path: canonicalPath, layout: "mirror-of-spec" },
        plugin: { path: pluginPath, layout: "flat" },
      },
      skills: {
        alpha: { edges: ["spec", "canonical", "plugin"], category: "core" },
        // external-canon-pending: in the layout ship set, NOT on disk → tolerated.
        "oversight-team": { edges: ["spec"], category: "pods" },
        // a DIFFERENT layout-demanded skill missing from disk → must stay LOUD (never blessed).
        "real-skill-gone": { edges: ["spec"], category: "core" },
      },
    };
    const alphaSha = sha256("# Alpha\n");
    const digests = {
      version: 1,
      edges: {
        spec: { "core/alpha/SKILL.md": alphaSha },
        canonical: { "core/alpha/SKILL.md": alphaSha },
        plugin: { "alpha/SKILL.md": alphaSha },
      },
    };

    // The mechanism is pinned via an injected set: the PRODUCTION default is now EMPTY
    // (oversight-team and retiring-and-inheriting-a-seat landed 2026-08-24; exemptions
    // self-destructed), so under the default EVERY layout-demanded missing skill is loud.
    const defaultRes = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests });
    assert.ok(
      defaultRes.changes.some((c) => c.path === "oversight-team" && c.reason === "layout-missing"),
      "production default allowlist is EMPTY — a missing skill is loud, nothing is tolerated",
    );

    const pending = new Set(["oversight-team"]);
    const res = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, externalCanonPending: pending });
    const tag = (c) => `${c.path}:${c.reason}`;
    assert.ok(
      !res.changes.some((c) => c.path === "oversight-team" && c.reason === "layout-missing"),
      "the named external-canon-pending skill is tolerated (no layout-missing)",
    );
    assert.ok(
      res.changes.some((c) => c.path === "real-skill-gone" && c.reason === "layout-missing"),
      "a NON-allowlisted layout-demanded missing skill stays LOUD",
    );
    assert.ok(
      !res.changes.some((c) => c.reason === "external-canon-allowlist-stale"),
      "no stale flag while the allowlisted skill is genuinely absent from disk",
    );

    // Self-destruct: when the allowlisted skill REAPPEARS on disk, its exemption is flagged stale.
    write(join(root, specPath, "pods", "oversight-team", "SKILL.md"), "# Oversight\n");
    const res2 = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, externalCanonPending: pending });
    assert.ok(
      res2.changes.some(
        (c) => c.path === "oversight-team" && c.reason === "external-canon-allowlist-stale",
      ),
      `reappeared allowlist entry flagged stale (got: ${res2.changes.map(tag).join(", ")})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkGeneratedEdges fails closed on empty or malformed control manifests", async () => {
  const mirror = await import("./mirror-skills.mjs");

  await assert.rejects(
    mirror.checkGeneratedEdges({
      repoRoot: "/unused",
      layout: {},
      digests: {},
    }),
    /layout|edges|control/i,
  );
  await assert.rejects(
    mirror.checkGeneratedEdges({
      repoRoot: "/unused",
      layout: {
        version: 0,
        edges: {
          spec: { path: "spec", layout: "categorized" },
        },
        skills: {},
      },
      digests: { version: 1, edges: {} },
    }),
    /digest|spec|control/i,
  );

  const root = mkdtempSync(join(tmpdir(), "openrig-partial-controls-red-"));
  try {
    write(join(root, "spec", "core", "alpha", "SKILL.md"), "# Alpha\n");
    await assert.rejects(
      mirror.checkGeneratedEdges({
        repoRoot: root,
        layout: {
          version: 0,
          edges: {
            spec: { path: "spec", layout: "categorized" },
          },
          skills: {
            alpha: { edges: ["spec"], category: "core" },
          },
        },
        digests: {
          version: 1,
          edges: {
            spec: {
              "core/alpha/SKILL.md": sha256("# Alpha\n"),
            },
          },
        },
      }),
      /canonical|plugin|spec|exactly three|control/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authoring regeneration stages canon and projects exact manifest layouts to all three edges", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(
    typeof mirror.regeneratePublicSkills,
    "function",
    "regeneratePublicSkills must be exported",
  );

  const root = mkdtempSync(join(tmpdir(), "openrig-authoring-red-"));
  try {
    const canonRoot = join(root, "canon");
    const repoRoot = join(root, "repo");
    write(join(canonRoot, "alpha", "SKILL.md"), "# Alpha\n");
    write(join(canonRoot, "alpha", "references", "guide.md"), "# Guide\n");
    write(join(canonRoot, "alpha", "feedback.md"), "private cycle\n");
    write(join(canonRoot, "alpha", "evals", "case.md"), "private eval\n");

    const result = await mirror.regeneratePublicSkills({
      canonRoot,
      repoRoot,
      membership: membershipFixture({ clean: ["alpha"] }),
      rules: fixtureRules(),
      layout: {
        version: 0,
        edges: {
          spec: { path: "spec", layout: "categorized" },
          canonical: { path: "canonical", layout: "mirror-of-spec" },
          plugin: { path: "plugin", layout: "flat" },
        },
        skills: {
          alpha: {
            edges: ["canonical", "plugin", "spec"],
            category: "core",
          },
        },
      },
    });

    for (const path of [
      "spec/core/alpha/SKILL.md",
      "canonical/core/alpha/SKILL.md",
      "plugin/alpha/SKILL.md",
      "spec/core/alpha/references/guide.md",
      "canonical/core/alpha/references/guide.md",
      "plugin/alpha/references/guide.md",
    ]) {
      assert.equal(readFileSync(join(repoRoot, path), "utf8").startsWith("#"), true);
    }
    assert.equal(existsSync(join(repoRoot, "spec/core/alpha/feedback.md")), false);
    assert.equal(existsSync(join(repoRoot, "plugin/alpha/evals")), false);
    assert.deepEqual(
      [...new Set(result.changes.map(({ edge }) => edge))].sort(),
      ["canonical", "plugin", "spec"],
    );
    assert.ok(result.changes.every(({ path }) => !path.includes("feedback.md")));

    await assert.rejects(
      mirror.regeneratePublicSkills({
        canonRoot,
        repoRoot,
        membership: membershipFixture({ clean: ["alpha", "missing"] }),
        rules: fixtureRules(),
        layout: {
          version: 0,
          edges: {
            spec: { path: "spec", layout: "categorized" },
            canonical: { path: "canonical", layout: "mirror-of-spec" },
            plugin: { path: "plugin", layout: "flat" },
          },
          skills: {
            alpha: { edges: ["spec"], category: "core" },
          },
        },
      }),
      /missing.*ship|ship.*missing|missing.*membership/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authoring regeneration reports and repairs permission-only drift on all three edges", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-authoring-modes-"));
  try {
    const canonRoot = join(root, "canon");
    const repoRoot = join(root, "repo");
    const expected = join(root, "expected-alpha");
    const prose = "# Alpha\n";
    const script = "#!/bin/sh\nexit 0\n";

    for (const base of [join(canonRoot, "alpha"), expected]) {
      write(join(base, "SKILL.md"), prose);
      write(join(base, "scripts", "run.sh"), script);
      chmodSync(join(base, "SKILL.md"), 0o644);
      chmodSync(join(base, "scripts", "run.sh"), 0o755);
    }

    const targets = [
      join(repoRoot, "canonical", "core", "alpha"),
      join(repoRoot, "plugin", "alpha"),
      join(repoRoot, "spec", "core", "alpha"),
    ];
    for (const target of targets) {
      write(join(target, "SKILL.md"), prose);
      write(join(target, "scripts", "run.sh"), script);
      chmodSync(join(target, "SKILL.md"), 0o644);
      chmodSync(join(target, "scripts", "run.sh"), 0o644);
      const before = checkModeAbsolute(expected, target);
      assert.equal(before.stale, true);
      assert.equal(before.changes.length, 1);
      assert.match(before.changes[0], /^\.f...p..... scripts\/run\.sh$/);
    }

    const result = await mirror.regeneratePublicSkills({
      canonRoot,
      repoRoot,
      membership: membershipFixture({ clean: ["alpha"] }),
      rules: fixtureRules(),
      layout: {
        version: 0,
        edges: {
          spec: { path: "spec", layout: "categorized" },
          canonical: { path: "canonical", layout: "mirror-of-spec" },
          plugin: { path: "plugin", layout: "flat" },
        },
        skills: {
          alpha: {
            edges: ["canonical", "plugin", "spec"],
            category: "core",
          },
        },
      },
    });

    assert.deepEqual(result.changes, [
      { edge: "canonical", path: "core/alpha/scripts/run.sh", reason: "mode" },
      { edge: "plugin", path: "alpha/scripts/run.sh", reason: "mode" },
      { edge: "spec", path: "core/alpha/scripts/run.sh", reason: "mode" },
    ]);
    for (const target of targets) {
      assert.equal(
        statSync(join(target, "SKILL.md")).mode & 0o777,
        0o644,
      );
      assert.equal(
        statSync(join(target, "scripts", "run.sh")).mode & 0o777,
        0o755,
      );
      assert.deepEqual(checkModeAbsolute(expected, target).changes, []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default apply refreshes controls after regeneration and enumerates every diff", async () => {
  const mirror = await import("./mirror-skills.mjs");
  assert.equal(
    typeof mirror.authoringApplyMode,
    "function",
    "authoringApplyMode must be exported",
  );

  const order = [];
  const result = await mirror.authoringApplyMode({
    generateControlPlaneJson: async () => {
      order.push("generate");
    },
    readAuthoringInputs: () => {
      order.push("read");
      return { fixture: true };
    },
    regeneratePublicSkills: async (inputs) => {
      order.push(`regenerate:${inputs.fixture}`);
      return {
        changes: [
          { edge: "canonical", path: "core/alpha/SKILL.md", reason: "write" },
          { edge: "plugin", path: "alpha/SKILL.md", reason: "write" },
          { edge: "spec", path: "core/alpha/SKILL.md", reason: "write" },
        ],
      };
    },
  });
  assert.deepEqual(order, [
    "generate",
    "read",
    "regenerate:true",
    "generate",
  ]);
  assert.equal(result.changes.length, 3);

  let defaultApplyCalls = 0;
  const messages = [];
  await mirror.main([], {
    authoringApplyMode: async () => {
      defaultApplyCalls += 1;
      return result;
    },
    log: (message) => messages.push(message),
  });
  assert.equal(defaultApplyCalls, 1);
  for (const change of result.changes) {
    assert.ok(
      messages.some(
        (message) =>
          message.includes(change.edge) && message.includes(change.path),
      ),
    );
  }
});

test("mirror main --check uses layout/digests and never activates the provisional scanner", async () => {
  const mirror = await import("./mirror-skills.mjs");
  let checkCalls = 0;
  let scannerCalls = 0;

  await mirror.main(["--check"], {
    checkGeneratedEdges: async () => {
      checkCalls += 1;
      return { stale: false, changes: [] };
    },
    scanInternalLeaks: () => {
      scannerCalls += 1;
      throw new Error("Plain B forbids scanner activation from mirror main");
    },
  });

  assert.equal(checkCalls, 1, "main --check must call the layout/digest verifier");
  assert.equal(scannerCalls, 0, "main --check must not call the provisional scanner");
});

test("checkModeAbsolute retains its one-source/one-target checksum contract", () => {
  const calls = [];
  const result = checkModeAbsolute("/source", "/target", (command, args) => {
    calls.push({ command, args });
    return "";
  });

  assert.equal(result.stale, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "rsync");
  assert.ok(calls[0].args.includes("-n"));
  assert.ok(calls[0].args.includes("--checksum"));
  assert.equal(calls[0].args.at(-2), "/source/");
  assert.equal(calls[0].args.at(-1), "/target/");
});

// --- helpers (test-only) ---

function fixtureRules() {
  return {
    path_prefixes: ["openrig-work/"],
    seat_and_rig_patterns: ["operator-agent@"],
    host_patterns: ["mm2-"],
    charged_terms: ["founder"],
    frontmatter_drop_keys: [
      "source_evidence",
      "curation_note",
      "content_curator",
      "transfer_test",
      "transfer_test_notes",
      "naming_note",
      "last_verified",
      "structure",
    ],
    internal_path_globs: ["*.internal.*", "**/internal/**", "*-internal/**"],
    section_fence: {
      begin: "<!-- internal:begin -->",
      end: "<!-- internal:end -->",
    },
    allowed_context_substrings: ["do not ship"],
  };
}

function membershipFixture({ clean = [] } = {}) {
  return {
    version: 0,
    product_public: {
      clean,
      ship_after_fix: [],
      ship_misses_add: [],
      sanitize_borderlines_ship: [],
    },
    vendored_ship_with_provenance: [],
    not_public: {},
    pending_author_public: [],
  };
}

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function snapshotTree(root) {
  const result = {};
  walk(root, (path) => {
    result[path.slice(root.length + 1)] = readFileSync(path);
  });
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
