import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const GATE = resolve("scripts/check-substance-gate.mjs");

test("the content scan executes the named full-mode guard with the artifact boundary", () => {
  const harnessRoot = mkdtempSync(join(resolve("scripts"), ".substance-gate-child-"));
  try {
    withFixture(({ repo, rules, review, receipt }) => {
      const publicFile = join(repo, "public/guide.md");
      write(publicFile, "Generic product guidance.\n");
      write(join(repo, "dist/derived.js"), "export const value = true;\n");
      commitAll(repo, "named child fixture");
      const cutSha = gitHead(repo);
      writeFileSync(review, JSON.stringify({
        surfaces: [{
          path: "public/guide.md",
          sha256: sha256(publicFile),
          verdict: "ship",
          reason: "Generic product guidance.",
          candidateDispositions: [],
        }],
      }));

      const source = readFileSync(GATE, "utf8");
      const invocationPath = join(harnessRoot, "invocation.json");
      const gate = writeGateHarness(join(harnessRoot, "live"), source, invocationPath);
      const result = runGate({ repo, rules, review, receipt, cutSha, gate });
      assert.equal(result.status, 0, result.stderr);
      const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
      assert.equal(invocation.args["--repo"], repo);
      assert.equal(invocation.args["--rules"], rules);
      assert.equal(invocation.args["--mode"], "full");
      assert.equal(invocation.args["--tree"], repo);
      assert.equal(dirname(invocation.args["--files-manifest"]), dirname(invocation.args["--report"]));
      assert.equal(invocation.manifest.files.includes("public/guide.md"), true);
      assert.equal(invocation.manifest.files.includes("dist/derived.js"), false);

      const bypassSource = source.replace(
        "content: runFullArtifactScan(options, treeClasses.content),",
        "content: runArtifactScan(options, \"content\", treeClasses.content, rules),",
      );
      assert.notEqual(bypassSource, source);
      assert.match(bypassSource, /check-internal-leak-guard\.mjs/);
      const bypassInvocationPath = join(harnessRoot, "bypass-invocation.json");
      const bypassGate = writeGateHarness(
        join(harnessRoot, "bypass"),
        bypassSource,
        bypassInvocationPath,
      );
      const bypass = runGate({ repo, rules, review, receipt, cutSha, gate: bypassGate });
      assert.equal(bypass.status, 0, bypass.stderr);
      assert.equal(existsSync(bypassInvocationPath), false);
    });
  } finally {
    rmSync(harnessRoot, { recursive: true, force: true });
  }
});

test("the named substance gate writes a cut-bound, per-surface receipt and records the full scan", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "# Public guide\nGeneric user-facing guidance.\n");
    commitAll(repo, "public surface");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({
      surfaces: [{
        path: "public/guide.md",
        sha256: sha256(publicFile),
        verdict: "ship",
        reason: "Generic product guidance with no instance dependency.",
        candidateDispositions: [],
      }],
    }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(output.gate, "substance gate");
    assert.equal(output.judge, "dev-qa@fixture");
    assert.equal(output.cutSha, cutSha);
    assert.equal(output.surfaceCount, 1);
    assert.equal(output.fullScan.status, "pass");
    assert.deepEqual(output.fullScan.missingFromScan, []);
    assert.deepEqual(output.fullScan.extraInScan, []);
    assert.deepEqual(output.fullScan.scannedFiles, output.fullScan.artifactFiles);
    assert.deepEqual(output.treeClassPartition, {
      contentPathCount: output.fullScan.artifactFileCount,
      derivedPathCount: 0,
    });
    assert.deepEqual(output.activeRulesByClass, {
      content: {
        path_prefixes: 2,
        seat_and_rig_patterns: 1,
        host_patterns: 1,
        charged_terms: 1,
        internal_path_globs: 3,
        allowed_context_substrings: 1,
      },
      derived: {
        path_prefixes: 1,
        host_patterns: 1,
        internal_path_globs: 3,
        allowed_context_substrings: 1,
      },
    });
    assert.equal(output.blockingScans.content.status, "pass");
    assert.equal(output.blockingScans.content.findingCount, 0);
    assert.equal(output.blockingScans.derived.status, "pass");
    assert.equal(output.blockingScans.derived.findingCount, 0);
    assert.deepEqual(output.surfaces.map((surface) => surface.path), ["public/guide.md"]);
    assert.equal(output.surfaces[0].verdict, "ship");
  });
});

test("an internal-path contribution is refused with its class and all fix paths", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    write(join(repo, "public/guide.md"), "Continue at substrate/shared-docs/rigs/private.\n");
    commitAll(repo, "internal specimen");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({ surfaces: [] }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /internal-path/i);
    assert.match(result.stderr, /public\/guide\.md/);
    assert.match(result.stderr, /genericize/i);
    assert.match(result.stderr, /public home/i);
    assert.match(result.stderr, /re-home/i);
  });
});

test("human judgment cannot be synthesized: every current file hash needs a reasoned verdict", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    write(join(repo, "public/guide.md"), "Generic product guidance.\n");
    commitAll(repo, "clean but unreviewed");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({ surfaces: [] }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public\/guide\.md/);
    assert.match(result.stderr, /missing.*judgment|unreviewed/i);
  });
});

test("a human refusal preserves the classifier class and teaches every fix path", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "Plausibly generic words whose meaning still depends on one internal position.\n");
    commitAll(repo, "substance-level specimen");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({
      surfaces: [{
        path: "public/guide.md",
        sha256: sha256(publicFile),
        verdict: "position-knowledge",
        reason: "The wording only makes sense to one internal role.",
        candidateDispositions: [],
      }],
    }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /classifier verdict position-knowledge/i);
    assert.match(result.stderr, /genericize/i);
    assert.match(result.stderr, /public home/i);
    assert.match(result.stderr, /re-home/i);
    assert.equal(existsSync(receipt), false);
  });
});

test("a dirty worktree cannot produce a receipt bound to its unchanged HEAD", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "Generic product guidance.\n");
    commitAll(repo, "clean release cut");
    const cutSha = gitHead(repo);
    write(publicFile, "Uncommitted bytes that are not part of the cut.\n");
    writeFileSync(review, JSON.stringify({ surfaces: [] }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release cut is dirty/i);
    assert.equal(existsSync(receipt), false);
  });
});

test("every mechanical S15 candidate needs its own disposition", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "Last verified 2026-08-28.\n");
    commitAll(repo, "dated surface");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({
      surfaces: [{
        path: "public/guide.md",
        sha256: sha256(publicFile),
        verdict: "ship",
        reason: "Review intentionally omits the dated candidate.",
        candidateDispositions: [],
      }],
    }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /date/i);
    assert.match(result.stderr, /2026-08-28/);
    assert.match(result.stderr, /undispositioned/i);
  });
});

test("duplicate same-line mechanical candidates consume dispositions by occurrence", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "Connect to :4545, then retry :4545.\n");
    commitAll(repo, "duplicate mechanical candidates");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({
      surfaces: [{
        path: "public/guide.md",
        sha256: sha256(publicFile),
        verdict: "ship",
        reason: "Generic repeated example ports.",
        candidateDispositions: [
          { kind: "port", line: 1, value: ":4545", disposition: "Generic example." },
          { kind: "port", line: 1, value: ":4545", disposition: "Generic example." },
        ],
      }],
    }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(receipt, "utf8"));
    assert.deepEqual(output.surfaces[0].candidates, [
      { kind: "port", line: 1, value: ":4545", disposition: "Generic example." },
      { kind: "port", line: 1, value: ":4545", disposition: "Generic example." },
    ]);
  });
});

test("the gate runs the full scanner over packager files outside the human-review roots", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "Generic product guidance.\n");
    write(join(repo, "outside.md"), "founder-only fixture\n");
    commitAll(repo, "outside full-scan specimen");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({
      surfaces: [{
        path: "public/guide.md",
        sha256: sha256(publicFile),
        verdict: "ship",
        reason: "Generic product guidance.",
        candidateDispositions: [],
      }],
    }));

    const result = runGate({ repo, rules, review, receipt, cutSha, surfaceRoot: "public" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside\.md/);
    assert.match(result.stderr, /founder/i);
    assert.match(result.stderr, /full scan/i);
  });
});

test("derived artifacts retain injection checks", () => {
  for (const specimen of [
    { path: "dist/absolute.js", content: "const root = '/Users/example/build';\n" },
    { path: "dist/host.js", content: "const host = 'mm2-build';\n" },
    { path: "dist/fixture.internal.js", content: "export const value = true;\n" },
  ]) {
    withFixture(({ repo, rules, review, receipt }) => {
      const publicFile = join(repo, "public/guide.md");
      write(publicFile, "Generic product guidance.\n");
      write(join(repo, specimen.path), specimen.content);
      commitAll(repo, `derived injection specimen ${specimen.path}`);
      const cutSha = gitHead(repo);
      writeFileSync(review, JSON.stringify({
        surfaces: [{
          path: "public/guide.md",
          sha256: sha256(publicFile),
          verdict: "ship",
          reason: "Generic product guidance.",
          candidateDispositions: [],
        }],
      }));

      const result = runGate({ repo, rules, review, receipt, cutSha });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(specimen.path.replaceAll(".", "\\.")));
      assert.equal(existsSync(receipt), false);
    });
  }
});

test("derived archaeology terms do not block and the receipt records the exact active rules", () => {
  withFixture(({ repo, rules, review, receipt }) => {
    const publicFile = join(repo, "public/guide.md");
    write(publicFile, "Generic product guidance.\n");
    write(join(repo, "dist/derived.js"), "founder operator-agent@ substrate/shared-docs/\n");
    commitAll(repo, "derived archaeology specimen");
    const cutSha = gitHead(repo);
    writeFileSync(review, JSON.stringify({
      surfaces: [{
        path: "public/guide.md",
        sha256: sha256(publicFile),
        verdict: "ship",
        reason: "Generic product guidance.",
        candidateDispositions: [],
      }],
    }));

    const result = runGate({ repo, rules, review, receipt, cutSha });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(output.treeClassPartition.derivedPathCount, 1);
    assert.equal(output.treeClassPartition.contentPathCount + 1, output.fullScan.artifactFileCount);
    assert.deepEqual(output.activeRulesByClass.derived, {
      path_prefixes: 1,
      host_patterns: 1,
      internal_path_globs: 3,
      allowed_context_substrings: 1,
    });
    assert.deepEqual(output.blockingScans.derived, {
      status: "pass",
      artifactFileCount: 1,
      scannedFileCount: 1,
      findingCount: 0,
    });
    assert.equal("derivedFindings" in output, false);
  });
});

test("the release ceremony names the gate and its durable receipt", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["gate:substance"], "node scripts/check-substance-gate.mjs");
  const ceremony = readFileSync("docs/releases/README.md", "utf8");
  assert.match(ceremony, /substance gate/i);
  assert.match(ceremony, /gate:substance/);
  assert.match(ceremony, /receipt/i);
  assert.match(ceremony, /judge|judged/i);
  assert.match(ceremony, /cut sha/i);
});

function writeGateHarness(root, source, invocationPath) {
  mkdirSync(root, { recursive: true });
  const gate = join(root, "check-substance-gate.mjs");
  writeFileSync(gate, source);
  writeFileSync(
    join(root, "internal-leak-scanner.mjs"),
    readFileSync(resolve("scripts/internal-leak-scanner.mjs")),
  );
  writeFileSync(join(root, "check-internal-leak-guard.mjs"), [
    "import { readFileSync, writeFileSync } from \"node:fs\";",
    `const invocationPath = ${JSON.stringify(invocationPath)};`,
    "const rawArgs = process.argv.slice(2);",
    "const args = Object.fromEntries(Array.from({ length: rawArgs.length / 2 }, (_, index) =>",
    "  [rawArgs[index * 2], rawArgs[index * 2 + 1]]));",
    "const manifest = JSON.parse(readFileSync(args[\"--files-manifest\"], \"utf8\"));",
    "writeFileSync(invocationPath, JSON.stringify({ args, manifest }));",
    "writeFileSync(args[\"--report\"], JSON.stringify({",
    "  mode: args[\"--mode\"],",
    "  scannedFiles: manifest.files,",
    "  findingCount: 0,",
    "}));",
  ].join("\n"));
  return gate;
}

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "openrig-substance-gate-"));
  const repo = join(root, "repo");
  const rules = join(root, "rules.json");
  const review = join(root, "review.json");
  const receipt = join(root, "receipt.json");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "qa@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "QA"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "openrig-substance-gate-fixture",
    version: "1.0.0",
    files: ["public", "dist", "outside.md", "substance-surfaces.json"],
  }));
  writeFileSync(join(repo, "substance-surfaces.json"), JSON.stringify({
    schemaVersion: 1,
    roots: ["public"],
  }));
  writeFileSync(rules, JSON.stringify({
    path_prefixes: ["substrate/shared-docs/", "/Users/example/"],
    seat_and_rig_patterns: ["operator-agent@"],
    host_patterns: ["mm2-"],
    charged_terms: ["founder"],
    internal_path_globs: ["*.internal.*", "**/internal/**", "*-internal/**"],
    allowed_context_substrings: ["do not ship"],
  }));
  try {
    run({ root, repo, rules, review, receipt });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runGate({ repo, rules, review, receipt, cutSha, gate = GATE }) {
  return spawnSync(process.execPath, [
    gate,
    "--repo", repo,
    "--package-root", repo,
    "--surface-manifest", join(repo, "substance-surfaces.json"),
    "--rules", rules,
    "--review", review,
    "--receipt", receipt,
    "--judge", "dev-qa@fixture",
    "--cut-sha", cutSha,
  ], { encoding: "utf8" });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commitAll(repo, message) {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", message], { cwd: repo });
}

function gitHead(repo) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
