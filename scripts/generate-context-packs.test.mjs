// OPR.0.5.3.7 R2 — tests for the package-time context-pack generator.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const GEN = join(HERE, "generate-context-packs.mjs");
const distUrl = (p) => pathToFileURL(join(REPO, "packages/daemon/dist/domain/context-packs", p)).href;
const { parseManifest } = await import(distUrl("manifest-parser.js"));
const { ContextPackLibraryService } = await import(distUrl("context-pack-library-service.js"));
const { assembleBundle } = await import(distUrl("bundle-assembler.js"));
const { EXCLUDES } = await import(pathToFileURL(join(HERE, "mirror-skills.mjs")).href);
const REAL_SKILLS = join(REPO, "packages/daemon/specs/agents/shared/skills");
const REAL_STATIC_PACKS = join(REPO, "packages/daemon/context-packs-src");

// Independent computation of the mirror's exclude-only ship set on a real tree —
// the discriminator that catches any narrowing of the projection (r2 HIGH-1).
function mirrorShipSet(dir, rel = "") {
  const names = new Set(EXCLUDES.filter((p) => !p.includes("/") && !p.includes("*")));
  const dirs = new Set(EXCLUDES.filter((p) => p.endsWith("/")).map((p) => p.replace(/\/+$/, "")));
  const globs = EXCLUDES.filter((p) => p.startsWith("*.")).map((p) => p.slice(1));
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!dirs.has(e.name)) out.push(...mirrorShipSet(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name));
    } else if (e.isFile() && !names.has(e.name) && !globs.some((s) => e.name.endsWith(s))) {
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return out.sort();
}

function skill(root, rel, { name, description, files }) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const fm = `---\nname: ${name}\ndescription: ${description}\n---\n`;
  writeFileSync(join(dir, "SKILL.md"), fm + `# ${name}\n\nbody of ${name}\n`);
  for (const [fname, content] of Object.entries(files || {})) writeFileSync(join(dir, fname), content);
}

function run(source, out, args = []) {
  return execFileSync("node", [GEN, ...args], {
    encoding: "utf8",
    env: { ...process.env, OPENRIG_SKILLS_SOURCE: source, OPENRIG_PACKS_OUT: out, OPENRIG_PACKAGE_VERSION: "0.5.3" },
  });
}

function scratch() {
  const base = mkdtempSync(join(tmpdir(), "s07-genpacks-"));
  return { source: join(base, "skills"), out: join(base, "out"), base };
}

test("generates a valid, daemon-parseable pack per skill; SKILL.md is the instruction", () => {
  const { source, out, base } = scratch();
  try {
    skill(source, "core/attention-queue", { name: "attention-queue", description: "Coordinate work.", files: {} });
    skill(source, "process/tdd", {
      name: "test-driven-development",
      description: "Write the test first.",
      files: {
        "anti-patterns.md": "# anti-patterns\n",
        "helper.sh": "#!/bin/sh\necho no\n",
        "example.ts": "export const x = 1;\n",
        "feedback.md": "internal\n",       // mirror EXCLUDE
        "notes.local.md": "local\n",        // mirror EXCLUDE (*.local.md)
      },
    });
    run(source, out);

    // both packs exist under skills/<rel>
    assert.ok(existsSync(join(out, "skills/core/attention-queue/manifest.yaml")));
    assert.ok(existsSync(join(out, "skills/process/tdd/manifest.yaml")));

    // manifest parses through the DAEMON's parser and SKILL.md leads as instruction
    const m1 = parseManifest(readFileSync(join(out, "skills/core/attention-queue/manifest.yaml"), "utf8"), "m1");
    assert.equal(m1.name, "attention-queue");
    assert.equal(m1.version, "0.5.3");
    assert.equal(m1.files[0].path, "SKILL.md");
    assert.equal(m1.files[0].role, "instruction");

    // the .sh/.ts helpers ARE packed + copied (mirror ship set — served as text);
    // the mirror EXCLUDES (feedback.md, *.local.md) are dropped.
    const m2 = parseManifest(readFileSync(join(out, "skills/process/tdd/manifest.yaml"), "utf8"), "m2");
    const paths = m2.files.map((f) => f.path);
    assert.ok(paths.includes("SKILL.md"));
    assert.ok(paths.includes("anti-patterns.md"));
    assert.ok(paths.includes("helper.sh"), "helper.sh must be packed (mirror ship set)");
    assert.ok(paths.includes("example.ts"), "example.ts must be packed (mirror ship set)");
    assert.ok(existsSync(join(out, "skills/process/tdd/helper.sh")), "helper.sh must be copied");
    assert.ok(!paths.includes("feedback.md"), "feedback.md is a mirror EXCLUDE");
    assert.ok(!paths.includes("notes.local.md"), "*.local.md is a mirror EXCLUDE");
    assert.equal(m2.files.find((f) => f.path === "helper.sh").role, "reference");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("MALFORMED PROJECTION FAILS THE BUILD — a '..' content path is rejected at package time, non-zero exit", () => {
  const { source, out, base } = scratch();
  try {
    skill(source, "core/ok", { name: "ok", description: "fine", files: {} });
    // a content file whose name forges a traversal segment: the daemon parser
    // rejects the resulting files[].path, and the generator must fail the build.
    skill(source, "core/bad", { name: "bad", description: "trap", files: { "notes..md": "x" } });
    let failed = false;
    try {
      run(source, out);
    } catch (err) {
      failed = true;
      assert.equal(err.status, 1, "exit code must be 1 (build failure)");
      assert.match(String(err.stderr), /FAILING THE BUILD/);
    }
    assert.ok(failed, "generator must exit non-zero on a malformed projection");
    // and it must NOT have written a partial/invalid library
    assert.ok(!existsSync(join(out, "skills/core/bad")), "no invalid pack should be written");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--check validates without writing (the build/CI drift gate)", () => {
  const { source, out, base } = scratch();
  try {
    skill(source, "core/x", { name: "x", description: "d", files: {} });
    const stdout = run(source, out, ["--check"]);
    assert.match(stdout, /--check OK/);
    assert.ok(!existsSync(out), "--check must not write the output tree");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("STALENESS BY CONSTRUCTION — editing canon after generation does not change generated bytes", () => {
  const { source, out, base } = scratch();
  try {
    skill(source, "core/x", { name: "x", description: "d", files: {} });
    run(source, out);
    const before = readFileSync(join(out, "skills/core/x/SKILL.md"), "utf8");
    // mutate the CANON after packing
    writeFileSync(join(source, "core/x/SKILL.md"), "---\nname: x\ndescription: d\n---\n# HACKED\n");
    const after = readFileSync(join(out, "skills/core/x/SKILL.md"), "utf8");
    assert.equal(after, before, "packed bytes must be decoupled from canon after generation");
    assert.doesNotMatch(after, /HACKED/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deterministic — two runs produce byte-identical manifests", () => {
  const a = scratch(), b = scratch();
  try {
    for (const s of [a, b]) skill(s.source, "core/x", { name: "x", description: "d", files: { "ref.md": "r" } });
    run(a.source, a.out);
    run(b.source, b.out);
    assert.equal(
      readFileSync(join(a.out, "skills/core/x/manifest.yaml"), "utf8"),
      readFileSync(join(b.out, "skills/core/x/manifest.yaml"), "utf8"),
    );
  } finally {
    rmSync(a.base, { recursive: true, force: true });
    rmSync(b.base, { recursive: true, force: true });
  }
});

test("REAL CANON: projected membership == the mirror ship set (no narrowing) — r2 HIGH-1", () => {
  const out = mkdtempSync(join(tmpdir(), "s07-real-"));
  try {
    run(REAL_SKILLS, out); // project the real canon
    const ref = "process/systematic-debugging";
    const expected = mirrorShipSet(join(REAL_SKILLS, ref));
    const m = parseManifest(readFileSync(join(out, "skills", ref, "manifest.yaml"), "utf8"), "m");
    const got = m.files.map((f) => f.path).sort();
    assert.deepEqual(got, expected, "pack files[] must equal the mirror ship set for the skill (no dropped assets)");
    // the exact helpers r2 flagged, referenced by the served prose:
    assert.ok(got.includes("find-polluter.sh"), "find-polluter.sh must be projected");
    assert.ok(got.includes("condition-based-waiting-example.ts"), "condition-based-waiting-example.ts must be projected");
    // and copied to disk
    assert.ok(existsSync(join(out, "skills", ref, "find-polluter.sh")));
    assert.ok(existsSync(join(out, "skills", ref, "condition-based-waiting-example.ts")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("REAL CANON: referenced helpers are DELIVERED in the served bundle (packed-path proof) — r2 HIGH-1", () => {
  const out = mkdtempSync(join(tmpdir(), "s07-serve-"));
  try {
    run(REAL_SKILLS, out);
    const lib = new ContextPackLibraryService({ roots: [{ path: out, sourceType: "builtin" }] });
    lib.scan();
    const entry = lib.getByRef("skills/process/systematic-debugging");
    assert.ok(entry, "systematic-debugging must be served from the builtin root");
    const bundle = assembleBundle({ packEntry: entry });
    assert.equal(bundle.missingFiles.length, 0, "no dangling files — the referenced helpers are present");
    // the helper the prose points at must be in the served bundle, header AND content:
    assert.match(bundle.text, /find-polluter\.sh/, "helper .sh path must be in the served bundle");
    assert.match(bundle.text, /find-polluter\.sh <file_or_dir_to_check>/, "helper .sh CONTENT must be served");
    assert.match(bundle.text, /condition-based-waiting-example\.ts/, "helper .ts path must be in the served bundle");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ── Test-A preflight repair (row 0ac358a9): STATIC packs projection ─────────
// The builtin library previously carried only skill projections; the world
// install ships as a STATIC committed pack (manifest + parent files) projected
// through the same script and validated by the same daemon parser.

function runWithStatic(source, staticSource, out, args = []) {
  return execFileSync("node", [GEN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_SKILLS_SOURCE: source,
      OPENRIG_STATIC_PACKS_SOURCE: staticSource,
      OPENRIG_PACKS_OUT: out,
      OPENRIG_PACKAGE_VERSION: "0.5.3",
    },
  });
}

function staticWorldPack(root, rel, { withCharged = false } = {}) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.md"), `# A\n\nalpha body${withCharged ? " for the founder" : ""}\n`);
  writeFileSync(join(dir, "b.md"), "# B\n\nbeta body\n");
  writeFileSync(
    join(dir, "manifest.yaml"),
    [
      'name: "mini-world"',
      'version: "0"',
      'purpose: "mini world for the projection pin"',
      "files:",
      '  - path: "a.md"',
      '    role: "world"',
      '  - path: "b.md"',
      '    role: "world"',
      "atoms:",
      '  - id: alpha',
      '    address: "a.md"',
      "    taxonomy: world",
      "    situations: [fresh]",
      "    purpose: depth",
      "    order: 10",
      "    priority: core",
      '  - id: beta',
      '    address: "b.md"',
      "    taxonomy: world",
      "    situations: [fresh, post-compaction]",
      "    purpose: width",
      "    order: 20",
      "    priority: core",
      "",
    ].join("\n"),
  );
}

test("STATIC PACK PROJECTED: a committed world pack lands in the builtin root with its atoms graph, version stamped", () => {
  const { source, out, base } = scratch();
  try {
    skill(source, "core/x", { name: "x", description: "d", files: {} });
    const staticSrc = join(base, "static");
    staticWorldPack(staticSrc, "world/install");
    runWithStatic(source, staticSrc, out);
    assert.ok(existsSync(join(out, "world/install/manifest.yaml")), "world/install must be projected");
    assert.ok(existsSync(join(out, "world/install/a.md")), "pack content must be copied");
    const m = parseManifest(readFileSync(join(out, "world/install/manifest.yaml"), "utf8"), "w");
    assert.equal(m.version, "0.5.3", "the projection must stamp the package version over the placeholder");
    assert.equal(m.atoms.length, 2, "the atoms graph must survive projection");
    assert.deepEqual(m.atoms.map((a) => a.id), ["alpha", "beta"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function expectStaticLeakFailure(base, mutate, label) {
  const { source, out } = { source: join(base, "skills"), out: join(base, "out") };
  skill(source, "core/x", { name: "x", description: "d", files: {} });
  const staticSrc = join(base, "static");
  staticWorldPack(staticSrc, "world/install");
  mutate(join(staticSrc, "world/install"));
  let failed = false;
  try {
    runWithStatic(source, staticSrc, out);
  } catch (err) {
    failed = true;
    assert.equal(err.status, 1, `${label}: exit code must be 1 (build failure)`);
  }
  assert.ok(failed, `${label}: must fail the build`);
}

test("STATIC PACK LEAK GUARD runs the FULL committed authority: charged term, path prefix, AND seat/rig identity each FAIL THE BUILD", () => {
  for (const [label, content] of [
    ["charged term", "# A\n\nalpha body for the founder\n"],
    ["internal path prefix", "# A\n\nsee openrig-work/skills for the library\n"],
    ["instance seat/rig identity", "# A\n\nroute it to dev50@v-openrig-build when done\n"],
  ]) {
    const base = mkdtempSync(join(tmpdir(), "s05-leak-"));
    try {
      expectStaticLeakFailure(base, (dir) => writeFileSync(join(dir, "a.md"), content), label);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("REF COLLISION across sources FAILS THE BUILD with no output mutation (B3)", () => {
  const base = mkdtempSync(join(tmpdir(), "s05-collide-"));
  try {
    const source = join(base, "skills");
    const out = join(base, "out");
    // a skill projecting to ref skills/world/install ...
    skill(source, "world/install", { name: "world-install-skill", description: "d", files: {} });
    // ... and a static pack claiming the SAME ref
    const staticSrc = join(base, "static");
    staticWorldPack(staticSrc, "skills/world/install");
    let failed = false;
    try {
      runWithStatic(source, staticSrc, out);
    } catch (err) {
      failed = true;
      assert.equal(err.status, 1, "collision must exit 1");
      assert.match(String(err.stderr), /duplicate|collid/i);
    }
    assert.ok(failed, "duplicate pack ref across sources must fail the build");
    assert.ok(!existsSync(out), "no output may be written on a collision");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("PRODUCTION LIBRARY: only the public onboarding-width and world-example static packs ship", () => {
  const out = mkdtempSync(join(tmpdir(), "s05-world-"));
  try {
    run(REAL_SKILLS, out);
    assert.deepEqual(readdirSync(REAL_STATIC_PACKS).sort(), ["onboarding-width", "world-example"]);
    assert.ok(
      !existsSync(join(out, "world/install")),
      "the production builtin library must not publish the internal world/install pack",
    );
    const widthDir = join(out, "onboarding-width");
    assert.deepEqual(readdirSync(widthDir).sort(), [
      "manifest.yaml",
      "public-reference-material.md",
      "public-what-you-can-do.md",
    ]);
    const manifest = parseManifest(readFileSync(join(widthDir, "manifest.yaml"), "utf8"), "onboarding-width");
    assert.equal(manifest.name, "onboarding-width");
    assert.deepEqual(manifest.files.map((file) => file.path), [
      "public-what-you-can-do.md",
      "public-reference-material.md",
    ]);
    const exampleDir = join(out, "world-example");
    assert.deepEqual(readdirSync(exampleDir).sort(), ["manifest.yaml", "your-world.md"]);
    const exampleManifest = parseManifest(readFileSync(join(exampleDir, "manifest.yaml"), "utf8"), "world-example");
    assert.equal(exampleManifest.name, "world-example");
    assert.deepEqual(exampleManifest.files.map((file) => file.path), ["your-world.md"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
