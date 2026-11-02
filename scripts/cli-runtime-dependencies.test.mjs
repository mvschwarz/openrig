import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

function runtimeImports(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const visit = (node) => {
    let literal;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      const bindings = clause?.namedBindings;
      if (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length && bindings.elements.every((e) => e.isTypeOnly)) return;
      literal = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.every((e) => e.isTypeOnly)) return;
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteralLike(literal)) imports.push(literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

test("runtime import audit includes lazy loads and re-exports, excludes types and prose", () => {
  assert.deepEqual(runtimeImports(`
    import type { A } from "types-only";
    import { type B } from "inline-types-only";
    export type { C } from "exported-types";
    const prose = 'import("not-an-import")';
    import "side-effect";
    export { value } from "re-export";
    const lazy = () => import("lazy");
    const cjs = require("required");
  `, "control.ts"), ["side-effect", "re-export", "lazy", "required"]);
});

test("the CLI entry points declare every reachable external runtime dependency", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8"));
  const pending = ["bin-wrapper.ts", "index.ts"].map((f) => resolve(root, "packages/cli/src", f));
  const visited = new Set();
  const missing = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of runtimeImports(readFileSync(file, "utf8"), file)) {
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
        continue;
      }
      if (isBuiltin(specifier)) continue;
      const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      // build-package rewrites these to the daemon files shipped inside the CLI.
      if (name === "@openrig/daemon") continue;
      if (!Object.hasOwn(manifest.dependencies, name)) missing.add(`${name} (${file.slice(root.length)})`);
    }
  }
  assert.deepEqual([...missing].sort(), [], "Runtime imports must survive a production-only install");
});
