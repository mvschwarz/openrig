import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { sha256Hex } from "./files/file-write-service.js";
import type { SkillProvenanceEntry } from "./skill-discovery.js";

export interface SkillAuditEntry {
  id: string;
  path: string;
  sourceKind: string;
  sourceRoot: string;
  shadowed: boolean;
  stage: string | null;
  verified: VerifiedStatus;
  contentHash: string;
  state: "active" | "stale" | "legacy" | "exempt";
  owner: string | null;
  sourceRef: string | null;
  /** The installed plugin this copy is byte-identical to, when it is one of OpenRig's bundled skills. */
  bundledFrom: { plugin: string; version: string } | null;
  findings: AuditFinding[];
}

export type VerifiedStatus =
  | { status: "verified"; date: string; source: string }
  | { status: "bare_verified"; date: string }
  | { status: "missing_verified" }
  | { status: "stale_verified"; date: string; source: string }
  // A bundled copy is verified by the plugin release that shipped it; it has no date to expire.
  | { status: "bundled"; plugin: string; version: string };

/** One installed plugin's skills directory, with the plugin version that the projected copies came from. */
export interface BundledSkillSource {
  plugin: string;
  version: string;
  skillsDir: string;
}

export interface AuditFinding {
  class: "missing_provenance" | "missing_verified" | "bare_verified" | "stale_verified" | "mirror_drift";
  file: string;
  reason: string;
  remediation: string;
}

const FRESHNESS_WINDOW_DAYS = 90;

function isExempt(frontmatter: Record<string, unknown>, body: string): boolean {
  if (frontmatter.status === "historical-reference") return true;
  if (/^\s*>\s*\*?\*?legacy/im.test(body)) return true;
  return false;
}

function isSelfReferential(source: string, skillPath: string): boolean {
  const trimmed = source.trim().replace(/\/+$/, "");
  if (trimmed === "SKILL.md" || trimmed === "./SKILL.md") return true;

  const skillMd = join(skillPath, "SKILL.md");
  const normalizedSkillPath = resolve(skillPath);
  const normalizedSkillMd = resolve(skillMd);

  if (trimmed === normalizedSkillPath || trimmed === normalizedSkillMd) return true;
  if (trimmed === skillPath || trimmed === skillMd) return true;

  try {
    const resolved = resolve(trimmed);
    if (resolved === normalizedSkillPath || resolved === normalizedSkillMd) return true;
  } catch { /* not a valid path */ }

  try {
    const resolvedFromSkill = resolve(skillPath, trimmed);
    if (resolvedFromSkill === normalizedSkillPath || resolvedFromSkill === normalizedSkillMd) return true;
  } catch { /* not a valid path */ }

  try {
    const resolvedFromParent = resolve(dirname(skillPath), trimmed);
    if (resolvedFromParent === normalizedSkillPath || resolvedFromParent === normalizedSkillMd) return true;
  } catch { /* not a valid path */ }

  if (trimmed.endsWith("/SKILL.md") && normalizedSkillMd.endsWith(trimmed)) return true;
  return false;
}

function extractVerified(frontmatter: Record<string, unknown>, skillPath: string): VerifiedStatus {
  const topVerified = frontmatter.verified;
  if (typeof topVerified === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})\s+against\s+(.+)$/i.exec(topVerified.trim());
    if (match && isValidDate(match[1]!) && !isSelfReferential(match[2]!, skillPath)) {
      return checkStaleness(match[1]!, match[2]!.trim());
    }
    if (match) {
      return { status: "bare_verified", date: match[1]! };
    }
  }

  const meta = frontmatter.metadata as Record<string, unknown> | undefined;
  const openrig = meta?.openrig as Record<string, unknown> | undefined;
  const lastVerified = openrig?.last_verified;
  if (!lastVerified) return { status: "missing_verified" };

  const dateStr = String(lastVerified).trim();
  if (!isValidDate(dateStr)) {
    return { status: "bare_verified", date: dateStr };
  }

  const rawSource = openrig?.source_evidence ?? openrig?.sourced_from;
  const realSource = extractRealSource(rawSource, skillPath);
  if (!realSource) {
    return { status: "bare_verified", date: dateStr };
  }

  return checkStaleness(dateStr, realSource);
}

function extractRealSource(rawSource: unknown, skillPath: string): string | null {
  if (!rawSource) return null;
  const candidates = Array.isArray(rawSource)
    ? rawSource.map((s) => String(s).trim()).filter(Boolean)
    : [String(rawSource).trim()];
  const real = candidates.filter((c) => c.length > 0 && !isSelfReferential(c, skillPath));
  return real.length > 0 ? real.join("; ") : null;
}

function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

function checkStaleness(dateStr: string, source: string): VerifiedStatus {
  const verifiedDate = new Date(dateStr);
  if (isNaN(verifiedDate.getTime())) {
    return { status: "bare_verified", date: dateStr };
  }
  const now = new Date();
  const daysDiff = (now.getTime() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24);
  if (daysDiff > FRESHNESS_WINDOW_DAYS) {
    return { status: "stale_verified", date: dateStr, source };
  }
  return { status: "verified", date: dateStr, source };
}

function hashSkillFolder(skillPath: string): string {
  let entries: string[];
  try { entries = readdirSync(skillPath).sort(); } catch { return ""; }
  const parts: string[] = [];
  for (const entry of entries) {
    const fullPath = join(skillPath, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (!stat.isFile()) continue;
    try {
      const content = readFileSync(fullPath);
      parts.push(`${entry}:${sha256Hex(content)}`);
    } catch { continue; }
  }
  return sha256Hex(parts.join("\n"));
}

const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];

/** The installed plugins under pluginsDir (OPENRIG_HOME/plugins) that ship skills. The daemon projects
 *  bundled skills from these directories, so they are the reference for a projected copy's bytes. */
export function listBundledSkillSources(pluginsDir: string): BundledSkillSource[] {
  let plugins: string[];
  try { plugins = readdirSync(pluginsDir).sort(); } catch { return []; }
  const sources: BundledSkillSource[] = [];
  for (const plugin of plugins) {
    const skillsDir = join(pluginsDir, plugin, "skills");
    if (!existsSync(skillsDir)) continue;
    const version = PLUGIN_MANIFESTS.map((rel) => {
      try {
        const parsed = JSON.parse(readFileSync(join(pluginsDir, plugin, rel), "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : null;
      } catch { return null; }
    }).find((v) => v !== null);
    if (version) sources.push({ plugin, version, skillsDir });
  }
  return sources;
}

/** Every file under dir, relative to it; dir itself may be a symlink. A symlinked directory inside it is
 *  listed as an entry but never walked, so a link cycle (`a -> .`) can't run away, and a copy holding one
 *  can't match a plugin's plain files. */
function listFilesRecursive(dir: string, prefix = ""): string[] {
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory() && !lstatSync(full).isSymbolicLink()) files.push(...listFilesRecursive(full, join(prefix, entry)));
    else if (stat.isDirectory() || stat.isFile()) files.push(join(prefix, entry));
  }
  return files;
}

// The projection writes this marker beside the plugin's files (plugin-vendor-service GLOBAL_VENDOR_VERSION).
const PROJECTION_MARKER = ".openrig-vendor-version";

/** A copy is bundled when the same-named skill in an installed plugin exists, the copy holds exactly the
 *  plugin's files (plus the projection's version marker), and every one has identical bytes. An edited,
 *  added or missing file means the copy is audited like any other skill. */
function matchBundledSource(skillPath: string, sources: BundledSkillSource[]): BundledSkillSource | null {
  for (const source of sources) {
    const pluginSkill = join(source.skillsDir, basename(skillPath));
    const files = listFilesRecursive(pluginSkill);
    if (!files.includes("SKILL.md")) continue;
    if (listFilesRecursive(skillPath).some((rel) => rel !== PROJECTION_MARKER && !files.includes(rel))) continue;
    const identical = files.every((rel) => {
      try { return readFileSync(join(pluginSkill, rel)).equals(readFileSync(join(skillPath, rel))); }
      catch { return false; }
    });
    if (identical) return source;
  }
  return null;
}

export interface MirrorDriftResult {
  stale: boolean;
  changes: string[];
}

export interface SkillAuditResult {
  entries: SkillAuditEntry[];
  mirrorDriftFindings: AuditFinding[];
}

export function auditSkills(
  entries: SkillProvenanceEntry[],
  opts?: { mirrorDrift?: MirrorDriftResult; bundledSources?: BundledSkillSource[] },
): SkillAuditResult {
  const mirrorDriftFindings: AuditFinding[] = [];
  if (opts?.mirrorDrift?.stale) {
    for (const change of opts.mirrorDrift.changes) {
      mirrorDriftFindings.push({
        class: "mirror_drift",
        file: change,
        reason: "Product source differs from canonical mirror",
        remediation: "Run scripts/mirror-skills.mjs to sync the canonical mirror",
      });
    }
  }
  const results = entries.map((entry) => {
    const fm = entry.frontmatter as Record<string, unknown>;
    const meta = fm.metadata as Record<string, unknown> | undefined;
    const openrig = meta?.openrig as Record<string, unknown> | undefined;

    const stage = openrig?.stage ? String(openrig.stage) : null;
    const bundled = matchBundledSource(entry.path, opts?.bundledSources ?? []);
    const bundledFrom = bundled ? { plugin: bundled.plugin, version: bundled.version } : null;
    // A bundled copy's provenance is the plugin that shipped it; frontmatter values still win where present.
    const owner = openrig?.owner ? String(openrig.owner) : bundled ? bundled.plugin : null;
    const sourceRef = openrig?.source_ref ?? openrig?.version
      ? String(openrig.source_ref ?? openrig?.version)
      : bundled ? `${bundled.plugin}@${bundled.version}` : null;
    const verified: VerifiedStatus = bundled
      ? { status: "bundled", plugin: bundled.plugin, version: bundled.version }
      : extractVerified(fm, entry.path);
    const contentHash = hashSkillFolder(entry.path);
    const exempt = isExempt(fm, entry.body);

    const findings: AuditFinding[] = [];

    if (!exempt && !entry.shadowed) {
      if (!sourceRef) {
        findings.push({
          class: "missing_provenance",
          file: join(entry.path, "SKILL.md"),
          reason: "No source_ref or version in frontmatter metadata",
          remediation: "Add metadata.openrig.source_ref or metadata.openrig.version to SKILL.md frontmatter",
        });
      }
      if (!owner) {
        findings.push({
          class: "missing_provenance",
          file: join(entry.path, "SKILL.md"),
          reason: "No owner in frontmatter metadata",
          remediation: "Add metadata.openrig.owner to SKILL.md frontmatter",
        });
      }

      if (verified.status === "missing_verified") {
        findings.push({
          class: "missing_verified",
          file: join(entry.path, "SKILL.md"),
          reason: "No verified date in frontmatter",
          remediation: "Add metadata.openrig.last_verified with date and metadata.openrig.source_evidence with the verification source",
        });
      } else if (verified.status === "bare_verified") {
        findings.push({
          class: "bare_verified",
          file: join(entry.path, "SKILL.md"),
          reason: `Verified date ${verified.date} has no evidence source -- a bare date cannot prove freshness`,
          remediation: "Add metadata.openrig.source_evidence naming the real verification source (not the SKILL.md filepath)",
        });
      } else if (verified.status === "stale_verified") {
        findings.push({
          class: "stale_verified",
          file: join(entry.path, "SKILL.md"),
          reason: `Verified date ${verified.date} is past the ${FRESHNESS_WINDOW_DAYS}-day freshness window`,
          remediation: `Re-verify against ${verified.source} and update metadata.openrig.last_verified`,
        });
      }
    }

    const state: SkillAuditEntry["state"] = exempt
      ? "exempt"
      : fm.status === "legacy" || fm.status === "historical-reference"
        ? "legacy"
        : findings.some((f) => f.class === "stale_verified" || f.class === "bare_verified")
          ? "stale"
          : "active";

    return {
      id: entry.id,
      path: entry.path,
      sourceKind: entry.sourceKind,
      sourceRoot: entry.sourceRoot,
      shadowed: entry.shadowed,
      stage,
      verified,
      contentHash,
      state,
      owner,
      sourceRef,
      bundledFrom,
      findings,
    };
  });

  return { entries: results, mirrorDriftFindings };
}
