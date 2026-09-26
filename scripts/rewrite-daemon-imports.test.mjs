import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rewriteDaemonImports } from "./rewrite-daemon-imports.mjs";

// A miniature staged CLI package: daemon exports map, staged daemon/dist and compiled CLI/TUI JS.
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "rewrite-daemon-imports-"));
  const daemonPackageJsonPath = join(root, "daemon-src", "package.json");
  const cliDir = join(root, "cli");
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(daemonPackageJsonPath, JSON.stringify({
    name: "@openrig/daemon",
    exports: {
      "./attention": { types: "./dist/attention-surface.d.ts", import: "./dist/attention-surface.js" },
      "./crash-cart": { types: "./dist/crash-cart-surface.js", import: "./dist/crash-cart-surface.js" },
      "./missing-file": { import: "./dist/not-staged.js" },
    },
  }));
  write(join(cliDir, "daemon", "dist", "attention-surface.js"), "export const a = 1;\n");
  write(join(cliDir, "daemon", "dist", "crash-cart-surface.js"), "export const c = 1;\n");
  for (const [path, text] of Object.entries(files)) write(join(cliDir, path), text);
  const read = (path) => readFileSync(join(cliDir, path), "utf8");
  return { root, cliDir, daemonPackageJsonPath, read };
}

test("rewrites static, side-effect, re-export and dynamic imports in nested CLI and TUI paths", () => {
  const f = fixture({
    "dist/commands/attention.js": [
      'import { a } from "@openrig/daemon/attention";',
      "import '@openrig/daemon/crash-cart';",
      'export { a as b } from "@openrig/daemon/attention";',
      'const m = await import("@openrig/daemon/crash-cart");',
      "",
    ].join("\n"),
    "dist/bin-wrapper.js": 'const c = await import( "@openrig/daemon/crash-cart" );\n',
    "tui/dist/views/health.js": 'import { a } from "@openrig/daemon/attention";\n',
  });
  try {
    const result = rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath });
    assert.deepEqual(result, { rewritten: 6, files: 3 });
    assert.equal(f.read("dist/commands/attention.js"), [
      'import { a } from "../../daemon/dist/attention-surface.js";',
      "import '../../daemon/dist/crash-cart-surface.js';",
      'export { a as b } from "../../daemon/dist/attention-surface.js";',
      'const m = await import("../../daemon/dist/crash-cart-surface.js");',
      "",
    ].join("\n"));
    assert.equal(f.read("dist/bin-wrapper.js"), 'const c = await import( "../daemon/dist/crash-cart-surface.js" );\n');
    assert.equal(f.read("tui/dist/views/health.js"), 'import { a } from "../../../daemon/dist/attention-surface.js";\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("leaves prose, comments and non-import strings unchanged", () => {
  const text = [
    "// LAZY-imports the narrow @openrig/daemon/crash-cart surface.",
    "/** the bytes live in `@openrig/daemon`. */",
    'const label = "@openrig/daemon/attention";',
    "",
  ].join("\n");
  const f = fixture({ "dist/prose.js": text });
  try {
    assert.deepEqual(rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }), { rewritten: 0, files: 0 });
    assert.equal(f.read("dist/prose.js"), text);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails on a subpath with no exports entry, including the bare package name", () => {
  for (const specifier of ["@openrig/daemon/not-exported", "@openrig/daemon"]) {
    const f = fixture({ "dist/x.js": `import { x } from "${specifier}";\n` });
    try {
      assert.throws(
        () => rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }),
        /has no entry in the daemon exports map/,
      );
      assert.equal(f.read("dist/x.js"), `import { x } from "${specifier}";\n`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("fails when the mapped target was not staged", () => {
  const f = fixture({ "dist/x.js": 'import { x } from "@openrig/daemon/missing-file";\n' });
  try {
    assert.throws(
      () => rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }),
      /which is not staged/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a second run is a no-op", () => {
  const f = fixture({ "dist/x.js": 'import { a } from "@openrig/daemon/attention";\n' });
  try {
    rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath });
    const once = f.read("dist/x.js");
    assert.deepEqual(rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }), { rewritten: 0, files: 0 });
    assert.equal(f.read("dist/x.js"), once);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("leaves import-shaped text in comments, strings and templates unchanged", () => {
  const text = [
    '// import x from "@openrig/daemon/attention";',
    "const example = 'import x from \"@openrig/daemon/attention\"';",
    'const other = `import x from "@openrig/daemon/attention"`;',
    "export {};",
    "",
  ].join("\n");
  const f = fixture({ "dist/prose-imports.js": text });
  try {
    assert.deepEqual(rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }), { rewritten: 0, files: 0 });
    assert.equal(f.read("dist/prose-imports.js"), text);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rewrites real imports that carry comments or use a template literal", () => {
  const f = fixture({
    "dist/x.js": [
      'const a = import /* kept */ ("@openrig/daemon/attention");',
      'import b from /* kept */ "@openrig/daemon/attention";',
      "const c = import(`@openrig/daemon/crash-cart`);",
      "",
    ].join("\n"),
  });
  try {
    assert.deepEqual(rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }), { rewritten: 3, files: 1 });
    assert.equal(f.read("dist/x.js"), [
      'const a = import /* kept */ ("../daemon/dist/attention-surface.js");',
      'import b from /* kept */ "../daemon/dist/attention-surface.js";',
      "const c = import(`../daemon/dist/crash-cart-surface.js`);",
      "",
    ].join("\n"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails on an unmapped subpath hidden behind a comment", () => {
  const f = fixture({ "dist/x.js": 'const x = import /* kept */ ("@openrig/daemon/unknown");\n' });
  try {
    assert.throws(
      () => rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }),
      /has no entry in the daemon exports map/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails on a non-literal module argument naming the package, and on unparseable files", () => {
  const cases = [
    ['const x = import("@openrig/daemon/" + name);\n', /non-literal module argument/],
    ["const x = import(`@openrig/daemon/${name}`);\n", /non-literal module argument/],
    ['const x = require("@openrig/daemon/" + name);\n', /non-literal module argument/],
    ['import { from "@openrig/daemon/attention";\n', /cannot parse/],
  ];
  for (const [text, expected] of cases) {
    const f = fixture({ "dist/x.js": text });
    try {
      assert.throws(() => rewriteDaemonImports({ cliDir: f.cliDir, daemonPackageJsonPath: f.daemonPackageJsonPath }), expected);
      assert.equal(f.read("dist/x.js"), text);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
