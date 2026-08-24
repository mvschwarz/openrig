#!/usr/bin/env node
// OPR.0.5.3.7 R2 — content ships WITH the CLI (the staleness kill).
//
// Projects canonical skill content (packages/daemon/specs/agents/shared/skills/)
// into context-pack entries under packages/daemon/context-packs/. The daemon
// already registers that directory as a `builtin` discovery root resolved
// RELATIVE TO THE BINARY (startup.ts: `import.meta.dirname/../context-packs`),
// and `rig context get` already serves any builtin-root pack — so once this
// projection is generated and shipped, served bytes match `rig --version` by
// construction and cannot drift from a forked plugin copy.
//
// RULED SHAPE (dev-planner entry-shape ruling 2026-08-23, generated-manifest-
// at-package-time): the projection is DERIVED AT PACKAGE TIME, never edited in
// place. The output dir is gitignored and regenerated on every build, so there
// is no committed projection to drift; the only hazard window is the build
// step, and this script makes a malformed projection FAIL THE BUILD by
// validating every generated manifest through the DAEMON's own parser — the
// single authority, never a second parser.
//
// Usage:
//   node scripts/generate-context-packs.mjs            # clean + write + validate
//   node scripts/generate-context-packs.mjs --check    # validate only, write nothing (build/CI gate)
//   node scripts/generate-context-packs.mjs --version=0.5.3
// Overridable for tests: OPENRIG_SKILLS_SOURCE, OPENRIG_PACKS_OUT, OPENRIG_PACKAGE_VERSION.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const SOURCE = process.env.OPENRIG_SKILLS_SOURCE
  ? path.resolve(process.env.OPENRIG_SKILLS_SOURCE)
  : path.join(REPO, "packages/daemon/specs/agents/shared/skills");
const OUT = process.env.OPENRIG_PACKS_OUT
  ? path.resolve(process.env.OPENRIG_PACKS_OUT)
  : path.join(REPO, "packages/daemon/context-packs");

// Reuse the DAEMON's manifest parser (the single authority; the entry-shape
// ruling forbids a second parser). It lives in compiled dist, which the package
// build produces before this script runs. Resolved relative to this script so
// it works from any cwd.
const PARSER_URL = pathToFileURL(
  path.join(REPO, "packages/daemon/dist/domain/context-packs/manifest-parser.js"),
).href;

// Content suffixes the daemon manifest parser accepts. Anything else (a skill's
// helper .sh/.ts) is code, not servable content, and is excluded from the pack.
const ALLOWED_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt"];
const EXCLUDE_NAMES = new Set(["feedback.md", ".DS_Store"]);
const EXCLUDE_DIRS = new Set(["evals"]);
const isLocal = (name) => name.endsWith(".local.md");
const isAllowed = (name) =>
  ALLOWED_SUFFIXES.some((s) => name.endsWith(s)) && !EXCLUDE_NAMES.has(name) && !isLocal(name);

function resolveVersion() {
  const arg = process.argv.find((a) => a.startsWith("--version="));
  const raw = arg ? arg.slice("--version=".length) : process.env.OPENRIG_PACKAGE_VERSION;
  const fromPkg = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(REPO, "packages/cli/package.json"), "utf8")).version;
    } catch {
      return "0.0.0-dev";
    }
  };
  return sanitizeVersion(raw || fromPkg());
}

// isSafePackVersion in the daemon: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.
function sanitizeVersion(v) {
  let s = String(v).replace(/[^A-Za-z0-9._+-]/g, "-").slice(0, 32);
  if (!/^[A-Za-z0-9]/.test(s)) s = ("v" + s).slice(0, 32);
  return s;
}

// Discover skill packs: a pack is a directory containing SKILL.md. Packs are
// leaves — we do not descend below one (mirrors the library's discoverPackDirs).
function findSkillDirs(dir, rel = "") {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || EXCLUDE_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (fs.existsSync(path.join(abs, "SKILL.md"))) {
      found.push({ abs, rel: childRel });
    } else {
      found.push(...findSkillDirs(abs, childRel));
    }
  }
  return found;
}

// Collect servable content files inside a skill dir, as posix relative paths.
function collectContentFiles(skillDir, rel = "") {
  const files = [];
  for (const e of fs.readdirSync(skillDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      files.push(...collectContentFiles(path.join(skillDir, e.name), rel ? `${rel}/${e.name}` : e.name));
    } else if (e.isFile() && isAllowed(e.name)) {
      files.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return files;
}

function readFrontmatter(skillDir) {
  try {
    const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = parseYaml(m[1]);
    return fm && typeof fm === "object" ? fm : {};
  } catch {
    return {};
  }
}

function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

// Deterministic YAML emission — JSON-encoded scalars are valid YAML flow
// scalars, so key order and escaping are fully controlled (no serializer
// dependence). SKILL.md is the pack's instruction; siblings are references.
function renderManifest({ name, version, purpose, files }) {
  const lines = [
    "# GENERATED by scripts/generate-context-packs.mjs — DO NOT EDIT.",
    "# Package-time projection of a canonical skill; regenerated every build.",
    `name: ${JSON.stringify(name)}`,
    `version: ${JSON.stringify(version)}`,
  ];
  if (purpose) lines.push(`purpose: ${JSON.stringify(purpose)}`);
  lines.push("files:");
  for (const f of files) {
    const role = f === "SKILL.md" ? "instruction" : "reference";
    lines.push(`  - path: ${JSON.stringify(f)}`);
    lines.push(`    role: ${JSON.stringify(role)}`);
    if (f === "SKILL.md" && purpose) lines.push(`    summary: ${JSON.stringify(purpose)}`);
  }
  return lines.join("\n") + "\n";
}

function buildPack(skill, version) {
  const files = collectContentFiles(skill.abs);
  if (!files.includes("SKILL.md")) {
    throw new Error(`skill at ${skill.rel} has no servable SKILL.md`);
  }
  // SKILL.md first, then the rest (deterministic, instruction leads).
  const ordered = ["SKILL.md", ...files.filter((f) => f !== "SKILL.md")];
  const fm = readFrontmatter(skill.abs);
  const name = typeof fm.name === "string" && fm.name.length ? fm.name : skill.rel.split("/").pop();
  const purpose = typeof fm.description === "string" && fm.description.length
    ? oneLine(fm.description).slice(0, 500)
    : undefined;
  const manifestYaml = renderManifest({ name, version, purpose, files: ordered });
  return { ref: `skills/${skill.rel}`, files: ordered, manifestYaml };
}

async function main() {
  const check = process.argv.includes("--check");
  const version = resolveVersion();

  let parseManifest;
  try {
    ({ parseManifest } = await import(PARSER_URL));
  } catch (err) {
    console.error(
      `[generate-context-packs] cannot load the daemon manifest parser at\n  ${PARSER_URL}\n` +
      `Build the daemon first (npm --prefix packages/daemon run build). Cause: ${err.message}`,
    );
    process.exit(2);
  }

  const skills = findSkillDirs(SOURCE);
  if (skills.length === 0) {
    console.error(`[generate-context-packs] no skills found under ${SOURCE}`);
    process.exit(2);
  }

  const packs = [];
  const errors = [];
  for (const skill of skills) {
    let pack;
    try {
      pack = buildPack(skill, version);
    } catch (err) {
      errors.push(`${skill.rel}: ${err.message}`);
      continue;
    }
    // Package-time validation THROUGH the daemon's own parser — a malformed
    // projection fails the build here, never at serve time.
    try {
      parseManifest(pack.manifestYaml, `${pack.ref}/manifest.yaml`);
    } catch (err) {
      errors.push(`${pack.ref}: manifest invalid — ${err.message}`);
      continue;
    }
    packs.push(pack);
  }

  if (errors.length > 0) {
    console.error(`[generate-context-packs] ${errors.length} invalid pack(s) — FAILING THE BUILD:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (check) {
    console.log(`[generate-context-packs] --check OK: ${packs.length} pack(s) project + validate clean (version ${version}).`);
    return;
  }

  // Write mode: clean the output root and regenerate from scratch (the
  // projection is never edited in place; a stale entry cannot survive).
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const pack of packs) {
    const packDir = path.join(OUT, pack.ref);
    fs.mkdirSync(packDir, { recursive: true });
    for (const rel of pack.files) {
      const srcAbs = path.join(SOURCE, pack.ref.replace(/^skills\//, ""), rel);
      const dstAbs = path.join(packDir, rel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.copyFileSync(srcAbs, dstAbs);
    }
    fs.writeFileSync(path.join(packDir, "manifest.yaml"), pack.manifestYaml);
  }
  console.log(`[generate-context-packs] wrote ${packs.length} pack(s) to ${OUT} (version ${version}).`);
}

main().catch((err) => {
  console.error(`[generate-context-packs] unexpected failure: ${err.stack || err.message}`);
  process.exit(2);
});
