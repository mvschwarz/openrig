import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

function fail(message) {
  throw new Error(`[gate-hermeticity] REFUSED: ${message}`);
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Verify that this worktree owns the dependency root and every lock-derived
 * @openrig workspace link. The check reports only; it never repairs.
 */
export function checkDependencyRoot(repoRoot, { log = console.log } = {}) {
  const root = realpathSync(repoRoot);
  const nodeModules = join(root, "node_modules");
  let nodeModulesStat;
  try {
    nodeModulesStat = lstatSync(nodeModules);
  } catch {
    fail(`node_modules is absent at ${nodeModules}`);
  }
  if (nodeModulesStat.isSymbolicLink()) {
    let actual = "<unresolved>";
    try { actual = realpathSync(nodeModules); } catch { /* reported below */ }
    log(`[gate-hermeticity] node_modules actual=${actual} expected=${nodeModules}`);
    fail(`node_modules is a symlink: ${nodeModules}`);
  }
  if (!nodeModulesStat.isDirectory()) fail(`node_modules is not a directory: ${nodeModules}`);

  let lock;
  try {
    lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  } catch (error) {
    fail(`cannot read package-lock.json: ${error?.message ?? error}`);
  }
  const entries = Object.entries(lock?.packages ?? {})
    .filter(([path]) => path.startsWith("node_modules/@openrig/"))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) fail("zero scoped @openrig links were derived from package-lock.json");

  const packagesRoot = realpathSync(join(root, "packages"));
  const pairs = [];
  const failures = [];
  for (const [linkPath, metadata] of entries) {
    const name = linkPath.slice("node_modules/".length);
    if (metadata?.link !== true || typeof metadata.resolved !== "string" || metadata.resolved.trim() === "") {
      log(`[gate-hermeticity] ${name} actual=<unchecked> expected=<missing lock-derived target>`);
      failures.push(`${name} has no lock-derived workspace target`);
      continue;
    }

    const expectedPath = join(root, metadata.resolved);
    let expected;
    try {
      expected = realpathSync(expectedPath);
    } catch (error) {
      log(`[gate-hermeticity] ${name} actual=<unchecked> expected=<unresolved:${expectedPath}>`);
      failures.push(`${name} expected target cannot be resolved: ${error?.message ?? error}`);
      continue;
    }
    if (!inside(packagesRoot, expected)) {
      log(`[gate-hermeticity] ${name} actual=<unchecked> expected=${expected}`);
      failures.push(`${name} lock-derived target escapes ${packagesRoot}`);
      continue;
    }

    const actualPath = join(root, linkPath);
    let actual;
    try {
      actual = realpathSync(actualPath);
    } catch (error) {
      log(`[gate-hermeticity] ${name} actual=<unresolved:${actualPath}> expected=${expected}`);
      failures.push(`${name} actual target cannot be resolved: ${error?.message ?? error}`);
      continue;
    }
    const line = `[gate-hermeticity] ${name} actual=${actual} expected=${expected}`;
    log(line);
    pairs.push({ name, actual, expected });
    if (actual !== expected) failures.push(`${name} actual target does not equal its lock-derived expected target`);
  }

  if (failures.length > 0) fail(failures.join("; "));
  return { checked: pairs.length, pairs };
}
