#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message, next) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, next }, null, 2)}\n`);
  process.exit(1);
}

function inventory(root) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;

  function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.set(relative, {
          kind: "file",
          hash: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
          mode: fs.statSync(absolute).mode & 0o777,
        });
      } else {
        files.set(relative, { kind: "unsupported" });
      }
    }
  }

  walk(root);
  return files;
}

function same(left, right) {
  return left?.kind === "file" && right?.kind === "file" && left.hash === right.hash;
}

function classify(ancestor, target, live) {
  if ([ancestor, target, live].some((item) => item?.kind === "unsupported")) return "preserve-unsupported-type";
  if (target && live && same(target, live)) return "current";
  if (ancestor && target && live && same(ancestor, live)) return "refresh-safe";
  if (!ancestor && target && !live) return "add-safe";
  if (ancestor && target && live) return "preserve-local-modification";
  if (ancestor && target && !live) return "preserve-local-deletion";
  if (!ancestor && !target && live) return "preserve-live-only";
  if (ancestor && !target && live) return "preserve-target-removal";
  if (!ancestor && target && live) return "preserve-unproven-existing";
  return "preserve-unclassified";
}

function atomicCopy(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.openrig-refresh-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const ancestorArg = argument("--ancestor");
const targetArg = argument("--target");
const liveArg = argument("--live");
const applySafe = process.argv.includes("--apply-safe");
if (!ancestorArg || !targetArg || !liveArg) {
  fail("--ancestor, --target, and --live are required", "derive all three plugin roots before classifying any managed file");
}

const roots = {
  ancestor: path.resolve(ancestorArg),
  target: path.resolve(targetArg),
  live: path.resolve(liveArg),
};
for (const name of ["ancestor", "target"]) {
  if (!fs.existsSync(roots[name]) || !fs.statSync(roots[name]).isDirectory()) {
    fail(`${name} is not a directory: ${roots[name]}`, `derive the ${name} packaged plugin root before retrying`);
  }
}
if (fs.existsSync(roots.live) && !fs.statSync(roots.live).isDirectory()) {
  fail(`live is not a directory: ${roots.live}`, "do not replace a non-directory live path automatically");
}

const inventories = {
  ancestor: inventory(roots.ancestor),
  target: inventory(roots.target),
  live: inventory(roots.live),
};
const paths = [...new Set([
  ...inventories.ancestor.keys(),
  ...inventories.target.keys(),
  ...inventories.live.keys(),
])].sort();
const actions = paths.map((relative) => ({
  path: relative,
  decision: classify(
    inventories.ancestor.get(relative),
    inventories.target.get(relative),
    inventories.live.get(relative),
  ),
}));

const written = [];
if (applySafe) {
  for (const action of actions) {
    if (action.decision !== "refresh-safe" && action.decision !== "add-safe") continue;
    const target = inventories.target.get(action.path);
    atomicCopy(path.join(roots.target, action.path), path.join(roots.live, action.path), target.mode);
    written.push(action.path);
  }
}

const preserved = actions.filter((action) => action.decision.startsWith("preserve-"));
process.stdout.write(`${JSON.stringify({
  schema: "openrig-managed-plugin-refresh/v1",
  roots,
  applied: applySafe,
  complete: preserved.length === 0,
  written,
  actions,
  next: preserved.length === 0
    ? "re-run the plan after the surrounding upgrade step and verify the live tree"
    : "resolve preserved paths individually; this helper will not delete or overwrite them",
}, null, 2)}\n`);
