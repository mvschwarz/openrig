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
  RSYNC_MISSING_MESSAGE,
} from "./mirror-skills.mjs";
import { buildEdgeDigests } from "../packages/daemon/scripts/gen-control-plane-json.mjs";

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
      sourceFor: (skill) => join(canon, skill),
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
      sourceFor: (skill) => join(canon, skill),
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
      sourceFor: (skill) => join(canon, skill),
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
      sourceFor: (skill) => join(canon, skill),
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
        sourceFor: (skill) => join(canon, skill),
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
      sourceFor: (skill) => join(canon, skill),
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
        sourceFor: (skill) => join(canon, skill),
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
        sourceFor: (skill) => join(canon, skill),
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
        sourceFor: (skill) => join(canon, skill),
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
      sourceFor: (skill) => join(canon, skill),
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
    const sources = { membership: membershipFixture({ clean: ["alpha"] }), rules: fixtureRules() };
    const clean = await mirror.checkGeneratedEdges({
      repoRoot: root,
      layout,
      digests,
      ...sources,
      scan: () => {
        scannerCalls += 1;
        throw new Error("provisional scanner must not run from mirror --check");
      },
    });
    assert.deepEqual(clean, { stale: false, changes: [] });
    assert.equal(scannerCalls, 0);

    write(join(root, pluginPath, "alpha", "SKILL.md"), "# Changed\n");
    const drift = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources });
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
    const added = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources });
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
    const missing = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources });
    assert.ok(
      missing.changes.some(
        (change) =>
          change.edge === "plugin" &&
          change.path === "alpha/references/guide.md" &&
          change.reason === "missing",
      ),
    );

    write(join(root, pluginPath, "alpha", "guide.md"), "# Guide\n");
    const relocated = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources });
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
    const sources = { membership: membershipFixture({ clean: ["alpha"] }), rules: fixtureRules() };
    const defaultRes = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources });
    assert.ok(
      defaultRes.changes.some((c) => c.path === "oversight-team" && c.reason === "layout-missing"),
      "production default allowlist is EMPTY — a missing skill is loud, nothing is tolerated",
    );

    const pending = new Set(["oversight-team"]);
    const res = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources, externalCanonPending: pending });
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
    const res2 = await mirror.checkGeneratedEdges({ repoRoot: root, layout, digests, ...sources, externalCanonPending: pending });
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

test("authoring regeneration writes each generated copy from the skill's one home and never writes a home", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-authoring-homes-"));
  try {
    const { repoRoot, inputs } = homeFixture(root);
    const homeBytes = () => snapshotTree(join(repoRoot, "spec"));
    const before = homeBytes();

    const first = await mirror.regeneratePublicSkills(inputs);
    assert.deepEqual(first.undeclared, []);
    for (const [copy, home] of [
      ["canonical/core/two", "spec/core/two"],
      ["canonical/process/three", "spec/process/three"],
      ["plugin/three", "spec/process/three"],
    ]) {
      assert.deepEqual(snapshotTree(join(repoRoot, copy)), snapshotTree(join(repoRoot, home)));
    }
    assert.deepEqual(homeBytes(), before);
    assert.deepEqual((await mirror.regeneratePublicSkills(inputs)).changes, []);

    write(join(repoRoot, "spec/core/two/SKILL.md"), "# Two, edited\n");
    assert.deepEqual((await mirror.regeneratePublicSkills(inputs)).changes, [
      { edge: "canonical", path: "core/two/SKILL.md", reason: "write" },
    ]);

    write(join(repoRoot, "spec/process/three/references/guide.md"), "# Guide, edited\n");
    assert.deepEqual((await mirror.regeneratePublicSkills(inputs)).changes, [
      { edge: "canonical", path: "process/three/references/guide.md", reason: "write" },
      { edge: "plugin", path: "three/references/guide.md", reason: "write" },
    ]);

    write(join(repoRoot, "plugin/solo/SKILL.md"), "# Solo, edited\n");
    assert.deepEqual((await mirror.regeneratePublicSkills(inputs)).changes, []);
    assert.equal(readFileSync(join(repoRoot, "plugin/solo/SKILL.md"), "utf8"), "# Solo, edited\n");
    assert.deepEqual((await mirror.regeneratePublicSkills(inputs)).changes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authoring regeneration repairs permission-only drift in generated copies from the home's modes", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-authoring-modes-"));
  try {
    const { repoRoot, inputs } = homeFixture(root);
    write(join(repoRoot, "spec/process/three/scripts/run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repoRoot, "spec/process/three/scripts/run.sh"), 0o755);
    await mirror.regeneratePublicSkills(inputs);
    for (const copy of ["canonical/process/three", "plugin/three"]) {
      chmodSync(join(repoRoot, copy, "scripts/run.sh"), 0o644);
    }

    const result = await mirror.regeneratePublicSkills(inputs);
    assert.deepEqual(result.changes, [
      { edge: "canonical", path: "process/three/scripts/run.sh", reason: "mode" },
      { edge: "plugin", path: "three/scripts/run.sh", reason: "mode" },
    ]);
    for (const copy of ["canonical/process/three", "plugin/three", "spec/process/three"]) {
      assert.equal(statSync(join(repoRoot, copy, "scripts/run.sh")).mode & 0o777, 0o755);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged files keep the source's exact mode, so a publishable home passes under umask 0077 and 0022", async () => {
  const mirror = await import("./mirror-skills.mjs");
  for (const mask of [0o077, 0o022]) {
    const root = mkdtempSync(join(tmpdir(), "openrig-umask-"));
    const previous = process.umask(mask);
    try {
      const { repoRoot, inputs, layout } = homeFixture(root);
      write(join(repoRoot, "spec/process/three/scripts/run.sh"), "#!/bin/sh\nexit 0\n");
      // A clean checkout's modes, whatever the umask that wrote the fixture.
      for (const path of ["spec/core/two/SKILL.md", "spec/process/three/SKILL.md", "spec/process/three/references/guide.md", "plugin/solo/SKILL.md"]) {
        chmodSync(join(repoRoot, path), 0o644);
      }
      chmodSync(join(repoRoot, "spec/process/three/scripts/run.sh"), 0o755);

      await mirror.regeneratePublicSkills(inputs);
      for (const copy of ["canonical/process/three", "plugin/three"]) {
        assert.equal(statSync(join(repoRoot, copy, "SKILL.md")).mode & 0o777, 0o644, `${copy} under ${mask.toString(8)}`);
        assert.equal(statSync(join(repoRoot, copy, "scripts/run.sh")).mode & 0o777, 0o755, `${copy} under ${mask.toString(8)}`);
      }
      assert.deepEqual(
        await mirror.checkGeneratedEdges({
          repoRoot,
          layout,
          digests: buildEdgeDigests({ repoRoot, layout }),
          membership: inputs.membership,
          rules: inputs.rules,
        }),
        { stale: false, changes: [] },
        `umask ${mask.toString(8)}`,
      );
      assert.deepEqual((await mirror.regeneratePublicSkills(inputs)).changes, []);
    } finally {
      process.umask(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a missing source refuses before any write, and an undeclared skill stays in place and is reported", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-authoring-visible-"));
  try {
    const { repoRoot, inputs, layout } = homeFixture(root);
    await mirror.regeneratePublicSkills(inputs);

    write(join(repoRoot, "spec/core/stray/SKILL.md"), "# Stray\n");
    write(join(repoRoot, "plugin/loose/SKILL.md"), "# Loose\n");
    write(join(repoRoot, "canonical/core/old/SKILL.md"), "# Old\n");
    const result = await mirror.regeneratePublicSkills(inputs);
    assert.deepEqual(result.undeclared, [
      { edge: "plugin", path: "loose" },
      { edge: "spec", path: "core/stray" },
    ]);
    assert.ok(existsSync(join(repoRoot, "spec/core/stray/SKILL.md")));
    assert.ok(existsSync(join(repoRoot, "plugin/loose/SKILL.md")));
    assert.ok(result.changes.length > 0);
    assert.ok(result.changes.every(({ edge, reason }) => edge === "canonical" && reason === "delete"));
    assert.equal(existsSync(join(repoRoot, "canonical/core/old")), false);
    const check = await mirror.checkGeneratedEdges({
      repoRoot,
      layout,
      digests: buildEdgeDigests({ repoRoot, layout }),
      membership: inputs.membership,
      rules: inputs.rules,
    });
    for (const path of ["core/stray/SKILL.md", "loose/SKILL.md"]) {
      assert.ok(check.changes.some((change) => change.path === path && change.reason === "layout-unexpected"), path);
    }

    rmSync(join(repoRoot, "spec/core/two"), { recursive: true });
    const copyBefore = snapshotTree(join(repoRoot, "canonical"));
    await assert.rejects(
      mirror.regeneratePublicSkills(inputs),
      /Missing shipping skill source: spec\/core\/two/,
    );
    assert.deepEqual(snapshotTree(join(repoRoot, "canonical")), copyBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check catches a generated copy that differs from its home even after the digests are re-pinned", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-check-source-"));
  try {
    const { repoRoot, inputs, layout } = homeFixture(root);
    await mirror.regeneratePublicSkills(inputs);
    const check = () =>
      mirror.checkGeneratedEdges({
        repoRoot,
        layout,
        digests: buildEdgeDigests({ repoRoot, layout }),
        membership: inputs.membership,
        rules: inputs.rules,
      });
    assert.deepEqual(await check(), { stale: false, changes: [] });

    write(join(repoRoot, "canonical/core/two/SKILL.md"), "# Hand-edited copy\n");
    assert.deepEqual((await check()).changes, [
      { edge: "canonical", path: "core/two/SKILL.md", reason: "copy-diverged" },
    ]);

    write(join(repoRoot, "canonical/core/two/SKILL.md"), readFileSync(join(repoRoot, "spec/core/two/SKILL.md")));
    write(join(repoRoot, "spec/process/three/SKILL.md"), "# Three, edited without regenerating\n");
    rmSync(join(repoRoot, "plugin/three/references/guide.md"));
    write(join(repoRoot, "plugin/three/extra.md"), "# Extra\n");
    assert.deepEqual(
      (await check()).changes.map(({ edge, path, reason }) => `${edge} ${path} ${reason}`).sort(),
      [
        "canonical process/three/SKILL.md copy-diverged",
        "plugin three/SKILL.md copy-diverged",
        "plugin three/extra.md copy-extra",
        "plugin three/references/guide.md copy-missing",
      ].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a home that its public copy would change is refused before any write and named by --check", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-home-public-"));
  try {
    const { repoRoot, inputs, layout } = homeFixture(root);
    await mirror.regeneratePublicSkills(inputs);
    const copyBefore = snapshotTree(join(repoRoot, "canonical"));
    write(
      join(repoRoot, "spec/core/two/SKILL.md"),
      "---\nname: two\nmetadata:\n  openrig:\n    stage: WIP\n    transfer_test: pending\n---\n# Two\n",
    );
    write(join(repoRoot, "spec/process/three/evals/case.md"), "eval\n");

    await assert.rejects(mirror.regeneratePublicSkills(inputs), (error) => {
      assert.match(error.message, /public copies would drop/);
      assert.match(error.message, /spec\/core\/two\/SKILL\.md/);
      assert.match(error.message, /spec\/process\/three\/evals\/case\.md/);
      return true;
    });
    assert.deepEqual(snapshotTree(join(repoRoot, "canonical")), copyBefore);

    const check = await mirror.checkGeneratedEdges({
      repoRoot,
      layout,
      digests: buildEdgeDigests({ repoRoot, layout }),
      membership: inputs.membership,
      rules: inputs.rules,
    });
    for (const [edge, path] of [
      ["spec", "core/two/SKILL.md"],
      ["spec", "process/three/evals/case.md"],
    ]) {
      assert.ok(
        check.changes.some((change) => change.edge === edge && change.path === path && change.reason === "source-not-public"),
        path,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a generated output that overlaps a home is refused before anything is staged or replaced", async () => {
  const mirror = await import("./mirror-skills.mjs");
  const root = mkdtempSync(join(tmpdir(), "openrig-overlap-"));
  try {
    const { repoRoot, inputs } = homeFixture(root);
    const layout = structuredClone(inputs.layout);
    layout.edges.canonical.path = "spec";
    const before = snapshotTree(join(repoRoot, "spec"));
    await assert.rejects(
      mirror.regeneratePublicSkills({ ...inputs, layout }),
      /Refusing to regenerate: the canonical output .* overlaps the source of/,
    );
    assert.deepEqual(snapshotTree(join(repoRoot, "spec")), before);
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

test("permission-drift detection is itemization-width portable: rsync 3.x and openrsync forms both detect, non-permission forms never do", () => {
  // rsync 3.x emits an 11-char itemization field, openrsync a 9-char one; the
  // parser keys on `.f` + `p` at index 5 and must be indifferent to the width.
  const drive = (lines) =>
    checkModeAbsolute("/source", "/target", () => lines.join("\n") + "\n");

  const long = drive([".f...p..... scripts/run.sh"]);
  assert.equal(long.stale, true);
  assert.deepEqual(long.changes, [".f...p..... scripts/run.sh"]);

  const short = drive([".f...p... scripts/run.sh"]);
  assert.equal(short.stale, true);
  assert.deepEqual(short.changes, [".f...p... scripts/run.sh"]);

  const negative = drive([
    "sending incremental file list",
    ".f..t...... scripts/run.sh",
    ".f..t.... scripts/run.sh",
    "total size is 100  speedup is 0.08",
  ]);
  assert.equal(negative.stale, false);
  assert.deepEqual(negative.changes, []);
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

test("a missing rsync is reported by name with how to install it, not as a bare ENOENT", () => {
  const missing = () => {
    const err = new Error("spawnSync rsync ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  assert.throws(() => checkModeAbsolute("/source", "/target", missing), (err) => {
    assert.equal(err.message, RSYNC_MISSING_MESSAGE);
    assert.match(err.message, /rsync on PATH/);
    assert.equal(err.cause.code, "ENOENT");
    return true;
  });
  // Any other rsync failure keeps its own error.
  const other = new Error("rsync exited 23");
  assert.throws(() => checkModeAbsolute("/source", "/target", () => { throw other; }), (err) => err === other);
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

// Three shipped skills, one per home shape: spec-only copy plus canonical, spec plus canonical and
// plugin, and plugin-only. Only the homes exist until the first regeneration.
function homeFixture(root) {
  const repoRoot = join(root, "repo");
  write(join(repoRoot, "spec/core/two/SKILL.md"), "---\nname: two\ndescription: Use when two.\n---\n# Two\n");
  write(join(repoRoot, "spec/process/three/SKILL.md"), "# Three\n");
  write(join(repoRoot, "spec/process/three/references/guide.md"), "# Guide\n");
  write(join(repoRoot, "plugin/solo/SKILL.md"), "# Solo\n");
  const layout = {
    version: 0,
    edges: {
      canonical: { path: "canonical", layout: "mirror-of-spec" },
      plugin: { path: "plugin", layout: "flat" },
      spec: { path: "spec", layout: "categorized" },
    },
    skills: {
      solo: { edges: ["plugin"], category: null },
      three: { edges: ["canonical", "plugin", "spec"], category: "process" },
      two: { edges: ["canonical", "spec"], category: "core" },
    },
  };
  return {
    repoRoot,
    layout,
    inputs: {
      repoRoot,
      layout,
      membership: membershipFixture({ clean: ["solo", "three", "two"] }),
      rules: fixtureRules(),
    },
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
