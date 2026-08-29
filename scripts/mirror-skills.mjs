import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  buildInternalLeakMessage,
  scanInternalLeaks,
} from "./internal-leak-scanner.mjs";

// Mirror canonical skills from packages/daemon/specs/agents/shared/skills/
// to <repo-root>/skills/_canonical/. Hand-authored files at <repo-root>/skills/
// (README, CHANGELOG, LICENSE, plugin manifests) live alongside _canonical/
// and are NEVER touched by the mirror — strict-ownership lets us add new
// top-level files without coupling the script to the destination shape.

export const SOURCE_DIR = "packages/daemon/specs/agents/shared/skills/";
export const TARGET_DIR = "skills/_canonical/";

export const EXCLUDES = [
  "feedback.md",
  "evals/",
  ".DS_Store",
  "*.local.md",
];

function rsyncArgs({ dryRun }) {
  // --checksum compares file contents via hash instead of mtime+size.
  // Used in --check (dry-run) mode so the drift-detect is content-stable
  // — a `git checkout` or `cp` updating mtimes does NOT register as drift
  // when the bytes match. In apply mode we keep the default (mtime+size)
  // for speed; rsync's archive flag preserves mtime so subsequent checks
  // stay clean.
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n", "--checksum"] : []),
    ...EXCLUDES.map((p) => `--exclude=${p}`),
    SOURCE_DIR,
    TARGET_DIR,
  ];
}

// Parse rsync --itemize-changes output for content or regular-file mode changes.
// First-column codes per rsync(1):
//   `<` / `>` — file transferred (content change)
//   `c`        — created entry (file/dir/symlink/device)
//   `h`        — hardlink redirected
//   `.`        — item exists with NO update OR metadata-only update; retain
//                only `.f...p.....` permission changes
//   `*`        — message line; we only care about `*deleting `
// In --check mode the script invokes rsync with `--checksum`, so a `.`
// leading line means the bytes match even if mtime drifts (e.g., after
// `git checkout` or `cp`); permission is the one metadata field the public
// mirror must preserve, while mtime-only drift stays ignored.
export function parseChanges(output) {
  const lines = output.split("\n").filter(Boolean);
  return [
    ...new Set(
      lines.filter(
        (line) =>
          /^[<>ch][fdLDS]/.test(line.slice(0, 2)) ||
          (line.startsWith(".f") && line[5] === "p") ||
          line.startsWith("*deleting "),
      ),
    ),
  ];
}

export function buildStaleMessage(changes) {
  return [
    "Skills mirror is stale at skills/_canonical/. Run: npm run mirror-skills",
    "Changes that would land:",
    ...changes.map((c) => `  ${c}`),
  ].join("\n");
}

function runRsync({ dryRun }, exec = execFileSync) {
  return exec("rsync", rsyncArgs({ dryRun }), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function ensureTargetExists() {
  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }
}

export function checkMode(exec = execFileSync) {
  ensureTargetExists();
  const output = runRsync({ dryRun: true }, exec);
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

export function checkModeAbsolute(sourceDir, targetDir, exec = execFileSync) {
  const output = exec(
    "rsync",
    rsyncAbsoluteArgs({ sourceDir, targetDir, dryRun: true }),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

// The product_public categories the mirror's ship set CONSUMES. Exported so the refs→membership
// chain gate (leg 2) can prove every oracle category is consumed — a category present in the oracle
// but absent here is silently accepted-and-dropped (the 0.4.8/864cea6b stranding: the PM's
// `restored_role_pm_selected` re-add landed in the oracle but this list never read it, so the 10
// pod/pm skills were never re-shipped despite being membership-selected).
export const SHIP_CATEGORIES = [
  "clean",
  "ship_after_fix",
  "ship_misses_add",
  "sanitize_borderlines_ship",
  "restored_role_pm_selected",
];

export function shipSetFromMembership(membership) {
  const productPublic = membership?.product_public ?? {};
  const excluded = new Set([
    ...Object.values(membership?.not_public ?? {}).flat(),
    ...(membership?.pending_author_public ?? []),
  ]);
  return [
    ...SHIP_CATEGORIES.flatMap((category) => productPublic[category] ?? []),
    ...(membership?.vendored_ship_with_provenance ?? []),
  ]
    .filter((skill) => !excluded.has(skill))
    .filter((skill, index, all) => all.indexOf(skill) === index)
    .sort();
}

export async function stagePublicSkills({
  canonRoot,
  stagingRoot,
  membership,
  rules,
}) {
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  for (const skill of shipSetFromMembership(membership)) {
    const sourceRoot = join(canonRoot, skill);
    if (!existsSync(sourceRoot) || isInternalPath(skill, rules)) continue;

    for (const sourcePath of walkFiles(sourceRoot)) {
      const skillRelative = relative(sourceRoot, sourcePath).replaceAll("\\", "/");
      const publicPath = `${skill}/${skillRelative}`;
      if (isExcludedPath(skillRelative)) continue;
      if (isInternalPath(publicPath, rules)) continue;

      let bytes = readFileSync(sourcePath);
      if (basename(sourcePath) === "SKILL.md") {
        const transformed = stripPublicSkill(
          bytes.toString("utf8"),
          publicPath,
          rules,
        );
        bytes = Buffer.from(transformed);
      } else if (/\.mdx?$/i.test(sourcePath)) {
        bytes = Buffer.from(
          stripInternalFences(
            bytes.toString("utf8"),
            publicPath,
            rules.section_fence,
          ),
        );
      }

      const findings = scanInternalLeaks({ path: publicPath, bytes, rules });
      if (findings.length > 0) {
        throw new Error(buildInternalLeakMessage(findings));
      }

      const targetPath = join(stagingRoot, skillRelative === "." ? skill : publicPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes, {
        mode: lstatSync(sourcePath).mode & 0o777,
      });
    }
  }
}

// External-canon-pending skills: authored in the external skill canon and listed in the layout
// ship set, but not yet mirrored into THIS repo (their SKILL.md isn't in git; the canon mirror-apply
// on the cut checklist — run with the explicit canon-root path — lands them). Their layout-missing is
// tolerated here — but ONLY these named few,
// and ONLY while genuinely absent from disk. Any OTHER layout-demanded file missing from disk stays
// LOUD (a future accidental deletion is never silently blessed), and a name that reappears on disk is
// flagged `external-canon-allowlist-stale` so this list self-destructs. Same self-policing shape as the
// P6(A) chain gate. Layout = authority, disk = reality; the digest regen touches only reality.
// (Currently empty: oversight-team and retiring-and-inheriting-a-seat landed via the 2026-08-24
// mirror-apply, so their exemptions self-destructed.)
const EXTERNAL_CANON_PENDING = new Set([]);

export async function checkGeneratedEdges({
  repoRoot = process.cwd(),
  layout,
  digests,
  externalCanonPending = EXTERNAL_CANON_PENDING,
}) {
  validateGeneratedControls(layout, digests);
  const changes = [];
  const onDiskSkills = new Set();

  for (const [edge, edgeConfig] of Object.entries(layout.edges).sort()) {
    const edgeRoot = join(repoRoot, edgeConfig.path);
    const expected = digests?.edges?.[edge] ?? {};
    const edgeFiles = walkFiles(edgeRoot);
    const actual = Object.fromEntries(
      edgeFiles.map((path) => [
        relative(edgeRoot, path).replaceAll("\\", "/"),
        sha256(readFileSync(path)),
      ]),
    );

    for (const path of Object.keys(expected).sort()) {
      if (!(path in actual)) {
        changes.push({ edge, path, reason: "missing" });
      } else if (actual[path] !== expected[path]) {
        changes.push({ edge, path, reason: "digest" });
      }
    }
    for (const path of Object.keys(actual).sort()) {
      if (!(path in expected)) {
        changes.push({ edge, path, reason: "unexpected" });
      }
    }

    const actualSkills = new Map(
      edgeFiles
        .filter((path) => basename(path) === "SKILL.md")
        .map((path) => {
          const rel = relative(edgeRoot, path).replaceAll("\\", "/");
          const parts = rel.split("/");
          const flat = edgeConfig.layout === "flat";
          return [
            flat ? parts[0] : parts.at(-2),
            { path: rel, category: flat ? null : parts[0] },
          ];
        }),
    );
    for (const [skill, actualEntry] of actualSkills) {
      const expectedEntry = layout.skills?.[skill];
      if (!expectedEntry?.edges?.includes(edge)) {
        changes.push({
          edge,
          path: actualEntry.path,
          reason: "layout-unexpected",
        });
      } else if (
        actualEntry.category !== null &&
        expectedEntry.category !== actualEntry.category
      ) {
        changes.push({
          edge,
          path: actualEntry.path,
          reason: "layout-category",
        });
      }
    }
    for (const skill of actualSkills.keys()) onDiskSkills.add(skill);
    for (const [skill, expectedEntry] of Object.entries(
      layout.skills ?? {},
    ).sort()) {
      if (expectedEntry.edges.includes(edge) && !actualSkills.has(skill)) {
        // Tolerate ONLY the named external-canon-pending skills; every other layout-demanded file
        // missing from disk stays loud.
        if (externalCanonPending.has(skill)) continue;
        changes.push({
          edge,
          path: skill,
          reason: "layout-missing",
        });
      }
    }
  }

  // Self-destruct guard: a name reappearing on disk must leave the allowlist. If an external-canon-pending
  // skill is now present, its exemption is stale — flag it LOUD so the list can never silently outlive
  // the gap it covered.
  for (const skill of externalCanonPending) {
    if (onDiskSkills.has(skill)) {
      changes.push({ edge: "-", path: skill, reason: "external-canon-allowlist-stale" });
    }
  }

  return { stale: changes.length > 0, changes };
}

export async function regeneratePublicSkills({
  canonRoot,
  repoRoot,
  membership,
  rules,
  layout,
  exec = execFileSync,
}) {
  validateAuthoringLayout(layout);
  const shipping = shipSetFromMembership(membership);
  for (const skill of shipping) {
    if (!existsSync(join(canonRoot, skill))) {
      throw new Error(`Missing shipping skill in canon: ${skill}`);
    }
    if (!layout.skills[skill]?.edges?.length) {
      throw new Error(`Missing shipping skill in edge layout: ${skill}`);
    }
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "openrig-public-skills-"));
  try {
    const stagingRoot = join(temporaryRoot, "staging");
    await stagePublicSkills({
      canonRoot,
      stagingRoot,
      membership,
      rules,
    });

    const changes = [];
    for (const [edge, edgeConfig] of Object.entries(layout.edges).sort()) {
      const projectedRoot = join(temporaryRoot, `edge-${edge}`);
      mkdirSync(projectedRoot, { recursive: true });

      for (const skill of shipping) {
        const skillLayout = layout.skills[skill];
        if (!skillLayout.edges.includes(edge)) continue;
        const category =
          edgeConfig.layout === "flat" ? null : skillLayout.category;
        if (edgeConfig.layout !== "flat" && !category) {
          throw new Error(`Missing category for shipping skill ${skill} on ${edge}`);
        }
        const destination = category
          ? join(projectedRoot, category, skill)
          : join(projectedRoot, skill);
        copyTree(join(stagingRoot, skill), destination);
      }

      const edgeRoot = join(repoRoot, edgeConfig.path);
      mkdirSync(edgeRoot, { recursive: true });
      const output = runRsyncAbsolute(projectedRoot, edgeRoot, exec);
      for (const line of parseChanges(output)) {
        changes.push({
          edge,
          path: rsyncChangePath(line),
          reason: line.startsWith("*deleting ")
            ? "delete"
            : line.startsWith(".f") && line[5] === "p"
              ? "mode"
              : "write",
        });
      }
    }
    return { changes };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function authoringApplyMode({
  generateControlPlaneJson = defaultGenerateControlPlaneJson,
  readAuthoringInputs = defaultReadAuthoringInputs,
  regeneratePublicSkills: regenerate = regeneratePublicSkills,
} = {}) {
  await generateControlPlaneJson();
  const inputs = readAuthoringInputs();
  const result = await regenerate(inputs);
  if (result.changes.length > 0) {
    await generateControlPlaneJson();
  }
  return result;
}

export function applyMode(exec = execFileSync) {
  ensureTargetExists();
  return runRsync({ dryRun: false }, exec);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const isCheck = argv.includes("--check");

  if (isCheck) {
    const verify = dependencies.checkGeneratedEdges ?? checkGeneratedEdges;
    const inputs =
      dependencies.checkInputs ??
      (dependencies.checkGeneratedEdges ? {} : readGeneratedCheckInputs());
    const { stale, changes } = await verify(inputs);
    if (stale) {
      console.error(buildGeneratedStaleMessage(changes));
      process.exitCode = 1;
    }
    return;
  }

  const apply = dependencies.authoringApplyMode ?? authoringApplyMode;
  const log = dependencies.log ?? console.log;
  const { changes } = await apply();
  if (changes.length === 0) {
    log("Public skill edges already in sync; no changes.");
  } else {
    log(`Public skill edge regeneration measured ${changes.length} change(s):`);
    for (const { edge, path, reason } of changes) {
      log(`  ${edge}: ${path} (${reason})`);
    }
  }
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  await main();
}

function readGeneratedCheckInputs() {
  const repoRoot = process.cwd();
  return {
    repoRoot,
    layout: readJson(join(repoRoot, "scripts/skill-edge-layout.generated.json")),
    digests: readJson(join(repoRoot, "scripts/skill-edge-digests.generated.json")),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultGenerateControlPlaneJson() {
  const repoRoot = process.cwd();
  const required = {
    membership: process.env.OPENRIG_PRODUCT_PUBLIC_SKILLS_YAML,
    denylist: process.env.OPENRIG_INTERNAL_TOKENS_YAML,
    layout: process.env.OPENRIG_SKILL_EDGE_LAYOUT_YAML,
  };
  for (const [name, path] of Object.entries(required)) {
    if (!path) {
      throw new Error(
        `Authoring apply requires the ${name} authority path environment variable`,
      );
    }
  }
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "packages/daemon/scripts/gen-control-plane-json.mjs"),
      "--repo-root",
      repoRoot,
      "--membership",
      required.membership,
      "--denylist",
      required.denylist,
      "--layout",
      required.layout,
      "--output",
      join(repoRoot, "scripts"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

function defaultReadAuthoringInputs() {
  const repoRoot = process.cwd();
  const canonRoot = process.env.OPENRIG_SKILL_CANON_ROOT;
  if (!canonRoot) {
    throw new Error(
      "The mirror apply requires OPENRIG_SKILL_CANON_ROOT — set it to the skill-canon root to run the real apply. This is an explicit-path authoring guard (the apply reads the canon from that path), not an authorization gate.",
    );
  }
  return {
    repoRoot,
    canonRoot: resolve(canonRoot),
    membership: readJson(
      join(repoRoot, "scripts/product-public-skills.generated.json"),
    ),
    rules: readJson(join(repoRoot, "scripts/internal-tokens.generated.json")),
    layout: readJson(
      join(repoRoot, "scripts/skill-edge-layout.generated.json"),
    ),
  };
}

function buildGeneratedStaleMessage(changes) {
  return [
    "Generated skill edges are stale. Regenerate the control-plane manifests.",
    ...changes.map(
      ({ edge, path, reason }) => `  ${edge}: ${path} (${reason})`,
    ),
  ].join("\n");
}

function stripPublicSkill(content, path, rules) {
  const withoutFences = stripInternalFences(content, path, rules.section_fence);
  const lines = withoutFences.split("\n");
  if (lines[0] !== "---") return withoutFences;

  const end = lines.indexOf("---", 1);
  if (end === -1) return withoutFences;

  const frontmatter = lines.slice(1, end);
  const kept = sanitizeFrontmatterEntries(frontmatter, 0, rules);

  return ["---", ...kept, "---", ...lines.slice(end + 1)].join("\n");
}

function sanitizeFrontmatterEntries(lines, indent, rules) {
  const kept = [];
  for (let index = 0; index < lines.length; ) {
    const match = frontmatterEntry(lines[index]);
    if (!match || match.indent !== indent) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }

    let next = index + 1;
    while (next < lines.length) {
      const candidate = frontmatterEntry(lines[next]);
      if (candidate && candidate.indent <= indent) break;
      next += 1;
    }
    const children = lines.slice(index + 1, next);
    const configured =
      match.key === "distribution_scope" ||
      (rules.frontmatter_drop_keys ?? []).includes(match.key);
    if (configured) {
      index = next;
      continue;
    }

    const childIndent = firstEntryIndent(children);
    if (match.value === "" && childIndent !== null) {
      const sanitized = sanitizeFrontmatterEntries(children, childIndent, rules);
      if (sanitized.some((line) => line.trim() !== "")) {
        kept.push(lines[index], ...sanitized);
      }
    } else {
      const entry = [lines[index], ...children];
      if (!containsInternalValue(entry.join("\n"), rules)) kept.push(...entry);
    }
    index = next;
  }
  return kept;
}

function frontmatterEntry(line) {
  const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
  return match
    ? { indent: match[1].length, key: match[2], value: match[3] ?? "" }
    : null;
}

function firstEntryIndent(lines) {
  for (const line of lines) {
    const entry = frontmatterEntry(line);
    if (entry) return entry.indent;
  }
  return null;
}

function stripInternalFences(content, path, fence) {
  if (!fence?.begin || !fence?.end) return content;

  const lines = content.split("\n");
  const kept = [];
  let openedAt = null;
  for (const [index, line] of lines.entries()) {
    if (line.includes(fence.begin)) {
      if (openedAt !== null) {
        throw new Error(`${path}: unmatched internal fence at line ${index + 1}`);
      }
      openedAt = index + 1;
      continue;
    }
    if (line.includes(fence.end)) {
      if (openedAt === null) {
        throw new Error(`${path}: unmatched internal fence at line ${index + 1}`);
      }
      openedAt = null;
      continue;
    }
    if (openedAt === null) kept.push(line);
  }
  if (openedAt !== null) {
    throw new Error(`${path}: unmatched internal fence at line ${openedAt}`);
  }
  return kept.join("\n");
}

function containsInternalValue(value, rules) {
  const lower = value.toLowerCase();
  return [
    ...(rules.path_prefixes ?? []),
    ...(rules.seat_and_rig_patterns ?? []),
    ...(rules.host_patterns ?? []),
    ...(rules.charged_terms ?? []),
  ].some((token) => lower.includes(token.toLowerCase()));
}

function isInternalPath(path, rules) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return (rules.internal_path_globs ?? []).some((glob) => {
    if (glob === "*.internal.*") {
      return parts.some((part) => part.includes(".internal."));
    }
    if (glob === "**/internal/**") {
      return parts.includes("internal");
    }
    if (glob === "*-internal/**") {
      return parts.some((part) => part.endsWith("-internal"));
    }
    return false;
  });
}

function isExcludedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const file = parts.at(-1);
  return EXCLUDES.some((pattern) => {
    if (pattern === "feedback.md") return file === pattern;
    if (pattern === "evals/") return parts.includes("evals");
    if (pattern === ".DS_Store") return file === pattern;
    if (pattern === "*.local.md") return file.endsWith(".local.md");
    return false;
  });
}

function walkFiles(root) {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) {
    throw new Error(`${root}: symlink entries are not allowed`);
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) {
    throw new Error(`${root}: unsupported filesystem entry`);
  }
  return readdirSync(root)
    .sort()
    .flatMap((entry) => walkFiles(join(root, entry)));
}

function copyTree(sourceRoot, targetRoot) {
  for (const sourcePath of walkFiles(sourceRoot)) {
    const targetPath = join(targetRoot, relative(sourceRoot, sourcePath));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function runRsyncAbsolute(sourceRoot, targetRoot, exec) {
  return exec(
    "rsync",
    rsyncAbsoluteArgs({
      sourceDir: sourceRoot,
      targetDir: targetRoot,
      dryRun: false,
    }),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

function rsyncAbsoluteArgs({ sourceDir, targetDir, dryRun }) {
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n"] : []),
    "--checksum",
    ...EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    sourceDir.endsWith("/") ? sourceDir : sourceDir + "/",
    targetDir.endsWith("/") ? targetDir : targetDir + "/",
  ];
}

function rsyncChangePath(line) {
  if (line.startsWith("*deleting ")) return line.slice("*deleting ".length);
  const separator = line.indexOf(" ");
  return separator === -1 ? line : line.slice(separator + 1).trim();
}

function validateGeneratedControls(layout, digests) {
  validateAuthoringLayout(layout);
  if (!isRecord(digests?.edges) || Object.keys(digests.edges).length === 0) {
    throw new Error("Digest control must contain edge inventories");
  }
  for (const edge of Object.keys(layout.edges)) {
    if (!isRecord(digests.edges[edge])) {
      throw new Error(`Digest control is missing edge ${edge}`);
    }
  }
}

function validateAuthoringLayout(layout) {
  if (!isRecord(layout?.edges) || Object.keys(layout.edges).length === 0) {
    throw new Error("Layout control must contain edges");
  }
  const edgeNames = Object.keys(layout.edges).sort();
  const requiredEdges = ["canonical", "plugin", "spec"];
  if (
    edgeNames.length !== requiredEdges.length ||
    edgeNames.some((edge, index) => edge !== requiredEdges[index])
  ) {
    throw new Error(
      "Layout control must contain exactly canonical, plugin, and spec edges",
    );
  }
  if (!isRecord(layout.skills) || Object.keys(layout.skills).length === 0) {
    throw new Error("Layout control must contain skills");
  }
  for (const [edge, config] of Object.entries(layout.edges)) {
    if (
      !isRecord(config) ||
      typeof config.path !== "string" ||
      config.path.length === 0 ||
      !["categorized", "mirror-of-spec", "flat"].includes(config.layout)
    ) {
      throw new Error(`Layout control has invalid edge ${edge}`);
    }
  }
  for (const [skill, config] of Object.entries(layout.skills)) {
    if (
      !isRecord(config) ||
      !Array.isArray(config.edges) ||
      config.edges.length === 0 ||
      config.edges.some((edge) => !Object.hasOwn(layout.edges, edge))
    ) {
      throw new Error(`Layout control has invalid skill ${skill}`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
