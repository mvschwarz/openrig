#!/usr/bin/env node
// Packaging step (build-package.sh): point the CLI's and TUI's compiled imports of
// `@openrig/daemon/<subpath>` at the daemon copy the CLI package already ships in
// `daemon/dist`, so the published package has no dependency on the unpublished
// `@openrig/daemon` and any package manager can install it (#66).
//
// Only module specifiers in import positions are rewritten: `from "…"`,
// `import "…"` and `import("…")`. Targets come from packages/daemon/package.json
// `exports`. The step fails on a specifier with no exports entry, on a target file
// that was not staged, and on any daemon import left afterwards. Running it twice
// is a no-op. Source imports and development resolution are unchanged.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])@openrig\/daemon(\/[^"']*)?\2/g;

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
  let count = 0;
  const output = text.replace(SPECIFIER, (_match, lead, quote, subpath) => {
    const target = targetFor(subpath ?? "", file);
    let specifier = relative(dirname(file), target).split(sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    count += 1;
    return `${lead}${quote}${specifier}${quote}`;
  });
  return { output, count };
}

export function remainingDaemonImports(text) {
  return [...text.matchAll(SPECIFIER)].map((match) => match[0]);
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
    remainingDaemonImports(readFileSync(file, "utf8")).map((found) => `${file}: ${found}`));
  if (left.length > 0) throw new Error(`daemon imports left after rewrite:\n${left.join("\n")}`);
  return { rewritten, files };
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
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
