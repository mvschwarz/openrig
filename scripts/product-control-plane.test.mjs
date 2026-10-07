import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const GENERATOR = resolve("packages/daemon/scripts/gen-control-plane-json.mjs");
const MIRROR = resolve("scripts/mirror-skills.mjs");
const NAMES = ["product-public-skills", "internal-tokens", "skill-edge-layout"];

test("regeneration preserves product policy bytes in place and when exporting", () => {
  withFixture(({ root, policyBytes }) => {
    for (const output of [join(root, "scripts"), join(root, "export")]) {
      const result = run(GENERATOR, root, ["--repo-root", root, "--output", output]);
      assert.equal(result.status, 0, result.stderr);
      for (const name of NAMES) {
        assert.deepEqual(readFileSync(join(output, `${name}.generated.json`)), policyBytes[name]);
        assert.deepEqual(readFileSync(join(root, "scripts", `${name}.generated.json`)), policyBytes[name]);
      }
      const digests = JSON.parse(readFileSync(join(output, "skill-edge-digests.generated.json")));
      assert.ok(digests.edges.plugin["alpha/SKILL.md"]);
    }
  });
});

test("legacy YAML inputs refuse with product pointers before changing policy files", () => {
  withFixture(({ root, legacy, policyBytes }) => {
    const result = run(GENERATOR, root, [
      "--repo-root", root, "--output", join(root, "scripts"),
      "--membership", legacy.membership, "--denylist", legacy.denylist, "--layout", legacy.layout,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /product-public-skills\.generated\.json/);
    for (const name of NAMES) {
      assert.deepEqual(readFileSync(join(root, "scripts", `${name}.generated.json`)), policyBytes[name]);
    }
    for (const [index, flag] of ["membership", "denylist", "layout"].entries()) {
      const single = run(GENERATOR, root, [
        "--repo-root", root, "--output", join(root, "scripts"), `--${flag}`, legacy[flag],
      ]);
      assert.notEqual(single.status, 0);
      assert.ok(single.stderr.includes(`${NAMES[index]}.generated.json`), single.stderr);
      for (const name of NAMES) {
        assert.deepEqual(readFileSync(join(root, "scripts", `${name}.generated.json`)), policyBytes[name]);
      }
    }
  });
});

test("authoring apply uses product policy despite conflicting legacy YAML environment", () => {
  withFixture(({ root, legacy, policyBytes }) => {
    const script = join(root, "packages/daemon/scripts/gen-control-plane-json.mjs");
    mkdirSync(dirname(script), { recursive: true });
    // Forward the real invocation: a symlink would defeat the generator's main-module check.
    write(script, `import { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, [${JSON.stringify(GENERATOR)}, ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exitCode = r.status ?? 1;\n`);
    write(join(root, "canon/alpha/SKILL.md"), "# Alpha from authoring source\n");
    const result = run(MIRROR, root, [], {
      OPENRIG_SKILL_CANON_ROOT: join(root, "canon"),
      OPENRIG_PRODUCT_PUBLIC_SKILLS_YAML: legacy.membership,
      OPENRIG_INTERNAL_TOKENS_YAML: legacy.denylist,
      OPENRIG_SKILL_EDGE_LAYOUT_YAML: legacy.layout,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of NAMES) {
      assert.deepEqual(readFileSync(join(root, "scripts", `${name}.generated.json`)), policyBytes[name]);
    }
    assert.equal(readFileSync(join(root, "plugin/alpha/SKILL.md"), "utf8"), "# Alpha from authoring source\n");
  });
});

function withFixture(check) {
  const root = mkdtempSync(join(tmpdir(), "openrig-product-control-"));
  const membership = {
    product_public: { clean: ["alpha"], ship_after_fix: [], ship_misses_add: [], sanitize_borderlines_ship: [] },
    vendored_ship_with_provenance: [], not_public: {}, pending_author_public: [],
  };
  const rules = {
    path_prefixes: ["private/"], seat_and_rig_patterns: ["private-seat@"],
    host_patterns: ["private-host"], charged_terms: ["private-term"],
    frontmatter_drop_keys: [], internal_path_globs: ["**/internal/**"],
    section_fence: { begin: "<!-- internal:begin -->", end: "<!-- internal:end -->" },
    allowed_context_substrings: ["do not ship"], allowed_context_lines: ["Exact generic private/ placeholder"],
  };
  const edges = {
    canonical: { path: "canonical", layout: "mirror-of-spec" },
    plugin: { path: "plugin", layout: "flat" }, spec: { path: "spec", layout: "categorized" },
  };
  const layout = { version: 0, edges, skills: { alpha: { edges: ["plugin"], category: null } } };
  const policyBytes = {};
  for (const [i, data] of [membership, rules, layout].entries()) {
    // Deliberately nonstandard formatting must survive a refresh byte for byte.
    policyBytes[NAMES[i]] = Buffer.from(JSON.stringify(data, null, 4) + "\n\n");
    write(join(root, "scripts", `${NAMES[i]}.generated.json`), policyBytes[NAMES[i]]);
  }
  write(join(root, "plugin/alpha/SKILL.md"), "# Original alpha\n");
  const legacy = Object.fromEntries(["membership", "denylist", "layout"].map(name => [name, join(root, `${name}.yaml`)]));
  write(legacy.membership, JSON.stringify({ ...membership, product_public: { ...membership.product_public, clean: [] } }));
  write(legacy.denylist, JSON.stringify({ ...rules, allowed_context_lines: [] }));
  write(legacy.layout, JSON.stringify({ version: 0, edges, extract_from_committed_trees: true, forward_overrides: {} }));
  try { check({ root, legacy, policyBytes }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function run(script, cwd, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}
