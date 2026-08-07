// SCOPES VIEW (sealed plan d64d2f5c) — the STORE-DIRECT projection behind the scopes TUI.
//
// THE DATA-PATH RULE (binding): slice cards / proof counts / progress bars derive from
// the SCOPE STORE — README frontmatter LOCKS + the C1 proof drops in proof/ — NEVER from
// PROGRESS.md (the drift machine). PROGRESS.md is a narrative artifact displayed under
// `n`; it is not read here at all. The render never asserts a proven-green the store
// does not enforce: `paired` means exactly "≥1 C1 drop cites this contract item".
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface ScopeFsDeps {
  exists: (p: string) => boolean;
  readFile: (p: string) => string | null;
  listDir: (p: string) => string[];
  isDirectory: (p: string) => boolean;
}

export interface C1Drop {
  file: string;
  artifactType: string | null;
  verdict: string | null;
  candidateSha: string | null;
  /** Contract-item refs the drop covers: 1-based indices (as strings) or item text. */
  evidences: string[];
  media: string[];
}

export interface ProofContractItem {
  index: number; // 1-based
  text: string;
  /** True iff ≥1 C1 drop cites this item — the ONLY meaning of a ✓ (honest render). */
  paired: boolean;
  drops: Array<{ file: string; artifactType: string | null; verdict: string | null; media: string[] }>;
}

export interface ScopeLocks {
  spec: { by: string; at: string } | null;
  delivery: { by: string; at: string } | null;
}

export interface SliceScopeSummary {
  dirName: string;
  id: string | null;
  displayName: string;
  status: string | null;
  stage: string | null;
  locks: ScopeLocks;
  proof: { paired: number; total: number };
}

export interface SliceScopeDetail extends SliceScopeSummary {
  intent: string;
  miniRequirements: string[];
  proofContract: ProofContractItem[];
  /** Path to PROGRESS.md for the `n` narrative DISPLAY (never a data source). */
  progressPath: string | null;
  specShaShort: string | null;
  prdExists: boolean;
}

export interface MissionScopes {
  mission: string;
  slices: SliceScopeSummary[];
}

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
}

function fmValue(fm: string, key: string): string | null {
  const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(fm);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
}

/** Parse a YAML block list under `key:` — the C1 `evidences:` / `media:` shape. */
function fmList(fm: string, key: string): string[] {
  const lines = fm.split("\n");
  const out: string[] = [];
  let inKey = false;
  for (const line of lines) {
    if (new RegExp(`^${key}\\s*:\\s*$`).test(line)) { inKey = true; continue; }
    if (inKey) {
      const m = /^\s+-\s+(.+)$/.exec(line);
      if (m) { out.push(m[1]!.trim().replace(/^["']|["']$/g, "")); continue; }
      if (/^\S/.test(line)) inKey = false;
    }
  }
  return out;
}

/** Extract a `## <Heading>` section's body (up to the next `## ` or EOF). */
function sectionBody(content: string, heading: string): string {
  const re = new RegExp(`^## ${heading}\\s*$`, "m");
  const m = re.exec(content);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** The proof-contract checkbox lines, in order (1-based indexing = the C1 evidences convention). */
function contractItems(content: string): string[] {
  const body = sectionBody(content, "Proof contract");
  const items: string[] = [];
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^- \[[ xX]\]\s+(.*)$/.exec(line);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[1]!;
    } else if (current !== null && /^\s+\S/.test(line) && !line.trimStart().startsWith("- [")) {
      current += " " + line.trim();
    }
  }
  if (current !== null) items.push(current.trim());
  return items;
}

/** Numbered mini-requirement lines (top-level `N.` items; continuation lines folded in). */
function miniRequirements(content: string): string[] {
  const body = sectionBody(content, "Mini-requirements");
  const items: string[] = [];
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^(\d+)\.\s+(.*)$/.exec(line);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[2]!;
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += " " + line.trim();
    }
  }
  if (current !== null) items.push(current.trim());
  return items;
}

function parseC1Drop(fileName: string, raw: string): C1Drop | null {
  const fm = extractFrontmatterRaw(raw);
  if (!fm) return null;
  return {
    file: fileName,
    artifactType: fmValue(fm, "artifact_type"),
    verdict: fmValue(fm, "verdict"),
    candidateSha: fmValue(fm, "candidate_sha"),
    evidences: fmList(fm, "evidences"),
    media: fmList(fm, "media"),
  };
}

function readLocks(fm: string): ScopeLocks {
  const specBy = fmValue(fm, "approved-spec-by");
  const specAt = fmValue(fm, "approved-spec-at");
  const delBy = fmValue(fm, "approved-by");
  const delAt = fmValue(fm, "approved-at");
  return {
    spec: specBy && specAt ? { by: specBy, at: specAt } : null,
    delivery: delBy && delAt ? { by: delBy, at: delAt } : null,
  };
}

/** Join drops → contract items: a drop's evidence ref matches an item by its 1-based
 *  index (the shipped `--evidences "4,5"` convention) or by exact item text. */
function pairContract(items: string[], drops: C1Drop[]): ProofContractItem[] {
  return items.map((text, i) => {
    const index = i + 1;
    const matching = drops.filter((d) =>
      d.evidences.some((ref) => ref === String(index) || ref.trim() === text.trim()),
    );
    return {
      index,
      text,
      paired: matching.length > 0,
      drops: matching.map((d) => ({ file: d.file, artifactType: d.artifactType, verdict: d.verdict, media: d.media })),
    };
  });
}

function specShaFromLockedArtifacts(fs: ScopeFsDeps, sliceDir: string, fm: string): string | null {
  // locked-artifacts is a nested YAML block list; take the `path:` of the first
  // `kind: spec` entry (the plan-lock convention), falling back to the first path of
  // any kind, else the PRD. Entries are delimited by their `- ` item starts so a
  // non-spec kind listed first cannot steal the hash (39a1c477 review nit).
  let candidate: string | null = null;
  let firstPath: string | null = null;
  let entryPath: string | null = null;
  let entryIsSpec = false;
  const closeEntry = () => {
    if (entryPath && !firstPath) firstPath = entryPath;
    if (entryPath && entryIsSpec && !candidate) candidate = entryPath;
    entryPath = null;
    entryIsSpec = false;
  };
  for (const line of fm.split("\n")) {
    if (/^\s+-\s/.test(line)) closeEntry();
    const p = /^\s+(?:-\s+)?path:\s*(.+)$/.exec(line);
    if (p) entryPath = p[1]!.trim();
    if (/^\s+(?:-\s+)?kind:\s*spec\s*$/.test(line)) entryIsSpec = true;
  }
  closeEntry();
  if (!candidate) candidate = firstPath;
  if (!candidate) candidate = "IMPLEMENTATION-PRD.md";
  const p = path.join(sliceDir, candidate);
  const bytes = fs.exists(p) ? fs.readFile(p) : null;
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

export function projectSliceScope(fs: ScopeFsDeps, sliceDir: string): SliceScopeDetail | null {
  const readmePath = path.join(sliceDir, "README.md");
  if (!fs.exists(readmePath)) return null;
  const content = fs.readFile(readmePath);
  if (!content) return null;
  const fm = extractFrontmatterRaw(content) ?? "";

  const items = contractItems(content);
  const proofDir = path.join(sliceDir, "proof");
  const drops: C1Drop[] = [];
  if (fs.exists(proofDir) && fs.isDirectory(proofDir)) {
    for (const f of fs.listDir(proofDir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      const raw = fs.readFile(path.join(proofDir, f));
      if (!raw) continue;
      const drop = parseC1Drop(f, raw);
      if (drop) drops.push(drop);
    }
  }
  const contract = pairContract(items, drops);
  const paired = contract.filter((c) => c.paired).length;

  const heading = /^# (.+)$/m.exec(content);
  const progressPath = path.join(sliceDir, "PROGRESS.md");
  return {
    dirName: path.basename(sliceDir),
    id: fmValue(fm, "id"),
    displayName: heading ? heading[1]!.trim() : path.basename(sliceDir),
    status: fmValue(fm, "status"),
    stage: fmValue(fm, "stage"),
    locks: readLocks(fm),
    proof: { paired, total: items.length },
    intent: sectionBody(content, "Intent"),
    miniRequirements: miniRequirements(content),
    proofContract: contract,
    progressPath: fs.exists(progressPath) ? progressPath : null,
    // LOOK delta D1 (answered at source): the store carries no sha, but it carries the
    // locked artifact PATH — the hash is computed from the CURRENT bytes at projection
    // time (store-DERIVED, live; never a transcribed value). First spec-kind artifact.
    specShaShort: specShaFromLockedArtifacts(fs, sliceDir, fm),
    prdExists: fs.exists(path.join(sliceDir, "IMPLEMENTATION-PRD.md")) || fm.includes("IMPLEMENTATION-PRD"),
  };
}

export function projectMissionScopes(fs: ScopeFsDeps, missionsRoot: string, mission: string): MissionScopes | null {
  const missionDir = path.join(missionsRoot, mission);
  const slicesDir = path.join(missionDir, "slices");
  if (!fs.exists(missionDir)) return null;
  const slices: SliceScopeSummary[] = [];
  if (fs.exists(slicesDir) && fs.isDirectory(slicesDir)) {
    for (const entry of fs.listDir(slicesDir)) {
      const sliceDir = path.join(slicesDir, entry);
      if (!fs.isDirectory(sliceDir)) continue;
      const detail = projectSliceScope(fs, sliceDir);
      if (!detail) continue;
      const { intent: _i, miniRequirements: _m, proofContract: _p, progressPath: _pp, specShaShort: _s, prdExists: _pe, ...summary } = detail;
      slices.push(summary);
    }
  }
  return { mission, slices };
}
