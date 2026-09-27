#!/usr/bin/env node
// Packaging step (build-package.sh): point the CLI's and TUI's compiled imports of
// `@openrig/daemon/<subpath>` at the daemon copy the CLI package already ships in
// `daemon/dist`, so the published package has no dependency on the unpublished
// `@openrig/daemon` and any package manager can install it (#66).
//
// Files are parsed with the TypeScript compiler the build already uses, and only real
// module specifiers are rewritten: import and export declarations, and `import()` or
// `require()` calls with a literal argument. Comments and strings are left alone.
// Targets come from packages/daemon/package.json `exports`. The step fails on a parse
// error, on a specifier with no exports entry, on a target that was not staged, on a
// non-literal `import()`/`require()` argument naming the package, and on any daemon
// import left afterwards. Running it twice is a no-op. Source imports and development
// resolution are unchanged.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = "@openrig/daemon";
const isDaemonSpecifier = (value) => value === PACKAGE || value.startsWith(`${PACKAGE}/`);

// The daemon module specifiers in one file, from its syntax tree.
function daemonSpecifiers(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`${file}: cannot parse (${source.parseDiagnostics[0].messageText})`);
  }
  const found = [];
  const visit = (node) => {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) literal = argument;
      else if (argument && argument.getText(source).includes(PACKAGE)) {
        throw new Error(`${file}: cannot rewrite non-literal module argument ${argument.getText(source)}`);
      }
    }
    if (literal && ts.isStringLiteralLike(literal) && isDaemonSpecifier(literal.text)) {
      found.push({ value: literal.text, start: literal.getStart(source), end: literal.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function loadSubpathTargets(daemonPackageJsonPath) {
  const exportsMap = JSON.parse(readFileSync(daemonPackageJsonPath, "utf8")).exports ?? {};
  const targets = new Map();
  for (const [key, value] of Object.entries(exportsMap)) {
    const target = typeof value === "string" ? value : value?.import;
    if (typeof target === "string") targets.set(key, target);
  }
  return targets;
}

// Rewrites one file's text. `targetFor(subpath)` returns the absolute target path or throws.
export function rewriteSource(text, file, targetFor) {
  const found = daemonSpecifiers(text, file);
  let output = text;
  // Replace from the end so earlier offsets stay valid; keep each literal's own quotes.
  for (const { value, start, end } of [...found].reverse()) {
    const target = targetFor(value.slice(PACKAGE.length), file);
    let specifier = relative(dirname(file), target).split(sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    output = `${output.slice(0, start + 1)}${specifier}${output.slice(end - 1)}`;
  }
  return { output, count: found.length };
}

export function remainingDaemonImports(text, file = "<input>") {
  return daemonSpecifiers(text, file).map(({ value }) => value);
}

function javascriptFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...javascriptFiles(path));
    else if (path.endsWith(".js")) files.push(path);
  }
  return files;
}

export function rewriteDaemonImports({ cliDir, daemonPackageJsonPath }) {
  const targets = loadSubpathTargets(daemonPackageJsonPath);
  const stagedDaemon = join(cliDir, "daemon");
  const targetFor = (subpath, file) => {
    const target = targets.get(`.${subpath}`);
    if (!target) {
      throw new Error(`${file}: @openrig/daemon${subpath} has no entry in the daemon exports map`);
    }
    const absolute = resolve(stagedDaemon, target);
    if (!existsSync(absolute)) {
      throw new Error(`${file}: @openrig/daemon${subpath} maps to ${target}, which is not staged at ${absolute}`);
    }
    return absolute;
  };

  let rewritten = 0;
  let files = 0;
  const roots = [join(cliDir, "dist"), join(cliDir, "tui", "dist")];
  for (const file of roots.flatMap(javascriptFiles)) {
    const text = readFileSync(file, "utf8");
    const { output, count } = rewriteSource(text, file, targetFor);
    if (count === 0) continue;
    writeFileSync(file, output);
    rewritten += count;
    files += 1;
  }

  const left = roots.flatMap(javascriptFiles).flatMap((file) =>
    remainingDaemonImports(readFileSync(file, "utf8"), file).map((found) => `${file}: ${found}`));
  if (left.length > 0) throw new Error(`daemon imports left after rewrite:\n${left.join("\n")}`);
  return { rewritten, files };
}

// Run only when executed directly. Compare real file paths, not a hand-built URL:
// import.meta.url is percent-encoded (spaces, "#") and names the symlink-resolved file.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false; // argv[1] is not an existing file, so this module was imported, not run
  }
}

if (invokedDirectly()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { rewritten, files } = rewriteDaemonImports({
      cliDir: join(repoRoot, "packages", "cli"),
      daemonPackageJsonPath: join(repoRoot, "packages", "daemon", "package.json"),
    });
    console.log(`Rewrote ${rewritten} @openrig/daemon import(s) in ${files} file(s) to the shipped daemon/dist.`);
  } catch (error) {
    console.error(`rewrite-daemon-imports: ${error.message}`);
    process.exitCode = 1;
  }
}
