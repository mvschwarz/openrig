import * as YAML from "yaml";
import { isMissionDotId, isSliceDotId } from "./dot-id.js";
import { isScaffoldPlaceholderText, hasAuthoredNumberedItem, isPristineScaffoldSection } from "./scaffold-placeholder.js";

export type RailStatus = "present" | "missing" | "malformed" | "readme-only";
export type FindingSeverity = "high" | "medium" | "low" | "info";
export type FindingKind =
  | "missing_progress"
  | "registration_ghost"
  | "missing_id"
  | "id_convention_violation"
  | "orphan_progress"
  | "missing_mission_brief"
  | "malformed_mission_brief"
  | "missing_mission_notes"
  | "missing_proof"
  // OPR.0.4.4.19 FR-10 — the belt-and-suspenders BACKSTOPS (never the
  // primary enforcement; the primary is the drop path / write path):
  | "proof_artifact_c1_invalid"
  | "missing_impl_prd"
  // OPR.0.4.4.23 — SDLC convention-section advisories (fail-open by
  // construction: low/info severities never flip the audit exit code;
  // conventions SSOT: docs/reference/sdlc-conventions.md):
  | "missing_intent_section"
  | "mini_requirements_missing_or_malformed"
  | "proof_contract_missing_or_malformed"
  | "ui_slice_missing_mockup"
  // SPEC.md compatibility — a node carrying BOTH authored files. Advisory by
  // construction (low severity never flips the exit code): SPEC.md wins, and the
  // shadowed README.md is a state to notice, never a failure to gate on.
  | "shadowed_node_file";

export interface AuditFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  path: string;
  message: string;
  remediation: string;
}

export interface ScopeAuditInput {
  id: string | null;
  path: string;
  readmeFrontmatterRaw: string | null;
  progressFileExists: boolean;
  readmeOnlyMarker: boolean;
  isActiveRelease: boolean;
  level: "mission" | "slice";
  missionBriefExists?: boolean;
  missionBriefPath?: string;
  missionBriefContent?: string | null;
  missionNotesExists?: boolean;
  missionNotesPath?: string;
  proofFileExists?: boolean;
  proofFilePath?: string;
  proofDirExists?: boolean;
  proofDirPath?: string;
  proofDirHasEntries?: boolean;
  hasProofPacket?: boolean;
  sliceStatus?: string | null;
  // OPR.0.4.4.19 FR-10 (C1 backstop) — the slice's proof/ dir markdown
  // artifacts with their raw frontmatter, caller-listed. Undefined = the
  // caller has no proof-dir context; the check is inert (no false findings).
  // Media files (video/screenshot) are exempt by construction — callers list
  // .md artifacts only.
  proofArtifacts?: Array<{ path: string; frontmatterRaw: string | null }>;
  // OPR.0.4.4.19 FR-10 (C7 backstop) — whether IMPLEMENTATION-PRD.md exists
  // at the slice root. Undefined = inert (caller has no fs context).
  implementationPrdExists?: boolean;
  // OPR.0.4.4.23 — convention-section advisory inputs: full file contents,
  // caller-read. Undefined = the caller has no content context and every
  // section check is inert (no false findings). null = the file does not
  // exist (the proof-contract check falls back to the README on a null PRD).
  nodeFileName?: "SPEC.md" | "README.md";
  readmeContent?: string | null;
  implementationPrdContent?: string | null;
}

export interface ScopeAuditResult {
  railStatus: RailStatus;
  findings: AuditFinding[];
  frontmatterError: string | null;
}

export interface MissionDependencyGraph {
  mission: { id: string | null; name: string; dependsOn: string[] };
  nodes: Array<{ id: string; name: string; dependsOn: string[] }>;
  ready: string[];
  waiting: Array<{ id: string; on: string[] }>;
  advisories: Array<{
    id: string;
    dependency?: string;
    kind: "invalid_field" | "invalid_dependency" | "outside_parent" | "missing_sibling" | "missing_id";
    message: string;
  }>;
}

export interface MissionDependencyGraphInput {
  mission: { id: string | null; name: string; dependsOn: unknown };
  slices: Array<{ id: string | null; name: string; dependsOn: unknown; active: boolean }>;
}

/** Pure advisory graph derivation shared by mission graph and both audit surfaces.
 * Unknown, stale, malformed, and cross-parent edges are reported and ignored:
 * dependency data can steer build order but never gate execution. */
export function deriveMissionDependencyGraph(input: MissionDependencyGraphInput): MissionDependencyGraph {
  const active = input.slices.filter((slice) => slice.active);
  const allIds = new Set(input.slices.flatMap((slice) => slice.id ? [slice.id] : []));
  const activeIds = new Set(active.flatMap((slice) => slice.id ? [slice.id] : []));
  const advisories: MissionDependencyGraph["advisories"] = [];
  const nodes: MissionDependencyGraph["nodes"] = [];
  const ready: string[] = [];
  const waiting: MissionDependencyGraph["waiting"] = [];

  for (const slice of active) {
    if (!slice.id) {
      advisories.push({ id: slice.name, kind: "missing_id", message: "Slice has no dot-ID; it cannot participate in the dependency graph." });
      continue;
    }
    const dependencies: string[] = [];
    if (slice.dependsOn !== undefined && !Array.isArray(slice.dependsOn)) {
      advisories.push({ id: slice.id, kind: "invalid_field", message: "depends_on must be a list of sibling dot-IDs; the value was ignored." });
    }
    for (const value of Array.isArray(slice.dependsOn) ? slice.dependsOn : []) {
      if (typeof value !== "string" || !isSliceDotId(value)) {
        advisories.push({ id: slice.id, dependency: String(value), kind: "invalid_dependency", message: "Dependency is not a slice dot-ID and was ignored." });
        continue;
      }
      if (input.mission.id && !value.startsWith(`${input.mission.id}.`)) {
        advisories.push({ id: slice.id, dependency: value, kind: "outside_parent", message: "Dependency is outside this mission and was ignored." });
        continue;
      }
      if (!allIds.has(value)) {
        advisories.push({ id: slice.id, dependency: value, kind: "missing_sibling", message: "Dependency does not resolve to a sibling and was ignored." });
        continue;
      }
      dependencies.push(value);
    }
    nodes.push({ id: slice.id, name: slice.name, dependsOn: dependencies });
    const unmet = dependencies.filter((dependency) => activeIds.has(dependency));
    if (unmet.length === 0) ready.push(slice.id);
    else waiting.push({ id: slice.id, on: unmet });
  }

  const missionDependsOn = Array.isArray(input.mission.dependsOn)
    ? input.mission.dependsOn.filter((value): value is string => typeof value === "string")
    : [];
  return {
    mission: { id: input.mission.id, name: input.mission.name, dependsOn: missionDependsOn },
    nodes,
    ready,
    waiting,
    advisories,
  };
}

// OPR.0.4.4.20 FR-8: exported so the review brief-spine writer conforms to
// the SAME pinned exact-order schema this audit enforces (parity by
// construction — the generated output can never trip malformed_mission_brief
// without this file changing too).
export const MISSION_BRIEF_HEADERS = ["What & why", "Building", "Progress", "Proven", "Needs you", "Pointers"];

function childPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

function parseStatusFromFrontmatter(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const status = (parsed as Record<string, unknown>).status;
      return typeof status === "string" ? status : null;
    }
  } catch {
    return null;
  }
  return null;
}

function statusRequiresProof(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().trim();
  return normalized.includes("done")
    || normalized.includes("ship")
    || normalized.includes("close")
    || normalized.includes("proven")
    || normalized.includes("promoted");
}

// OPR.0.4.4.19 FR-10 (C1) — the ratified closed sets (BR-4; source of truth
// for the drop path lives in the CLI proof command; this mirrored file
// carries its own copy because both scope-audit copies must stay
// self-contained + byte-identical. Extending the sets is a pm-lead
// convention change, made in BOTH places).
const C1_REQUIRED_FIELDS = ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"] as const;
const C1_ARTIFACT_TYPES = ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const;
const C1_VERDICTS = ["CLEAR", "BLOCKING", "CONCERNING", "PASS", "NOT-CLEAR"] as const;

/** Validate one proof artifact's raw frontmatter against the C1 contract.
 *  Returns null when valid; else the human-readable problem list. */
function c1ArtifactProblems(frontmatterRaw: string | null): string[] | null {
  if (frontmatterRaw === null) {
    return [`no frontmatter header at all (required C1 fields: ${C1_REQUIRED_FIELDS.join(", ")})`];
  }
  let parsed: unknown = null;
  try {
    parsed = YAML.parse(frontmatterRaw);
  } catch (err) {
    return [`frontmatter fails to parse: ${err instanceof Error ? err.message : String(err)}`];
  }
  const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const problems: string[] = [];
  const missing = C1_REQUIRED_FIELDS.filter((f) => typeof fm[f] !== "string" || (fm[f] as string).trim().length === 0);
  if (missing.length > 0) problems.push(`missing field(s): ${missing.join(", ")}`);
  if (typeof fm.artifact_type === "string" && !(C1_ARTIFACT_TYPES as readonly string[]).includes(fm.artifact_type)) {
    problems.push(`artifact_type '${fm.artifact_type}' not in closed set (${C1_ARTIFACT_TYPES.join(" | ")})`);
  }
  if (typeof fm.verdict === "string" && !(C1_VERDICTS as readonly string[]).includes(fm.verdict)) {
    problems.push(`verdict '${fm.verdict}' not in closed set (${C1_VERDICTS.join(" | ")})`);
  }
  return problems.length > 0 ? problems : null;
}

// OPR.0.4.4.23 — markdown H2-section helpers for the convention-section
// advisories. Headings are literals owned by this file ("Intent",
// "Proof contract", "Intent visual") — no user input reaches the regex.
function hasH2(content: string, heading: string): boolean {
  return new RegExp(`^##\\s+${heading}\\s*$`, "m").test(content);
}

function h2Body(content: string, heading: string): string | null {
  const match = new RegExp(`^##\\s+${heading}\\s*$`, "m").exec(content);
  if (!match) return null;
  const rest = content.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

// A mission is ACTIVE unless its status names a terminal / archived state.
// The SOP wants missing_mission_notes to fire for an ACTIVE mission only — a
// shipped/archived mission no longer needs a live continuity file. No status
// => treat as active (still flag), which preserves the pre-tighten behavior for
// the common status-less mission.
function missionIsActive(status: string | null | undefined): boolean {
  if (!status) return true;
  const normalized = status.toLowerCase();
  const terminal = ["archiv", "complete", "done", "shipped", "closed", "historical", "superseded", "abandoned"];
  return !terminal.some((token) => normalized.includes(token));
}

export function classifyScopeItem(input: ScopeAuditInput): ScopeAuditResult {
  const findings: AuditFinding[] = [];
  let frontmatterError: string | null = null;
  let parsedFrontmatter: Record<string, unknown> = {};
  let railStatus: RailStatus;

  // Rail status
  if (input.readmeOnlyMarker) {
    railStatus = "readme-only";
  } else if (input.progressFileExists) {
    railStatus = "present";
  } else {
    railStatus = "missing";
    findings.push({
      kind: "missing_progress",
      severity: input.isActiveRelease ? "high" : "low",
      path: input.path,
      message: `${input.level} has no PROGRESS.md and no readme-only marker`,
      remediation: `Run: rig scope ${input.level} create (scaffolds PROGRESS.md) or add progress_rail: readme-only to README frontmatter`,
    });
  }

  // Frontmatter classification (strict parse, NOT parseYamlSafely)
  if (input.readmeFrontmatterRaw === null) {
    findings.push({
      kind: "missing_id",
      severity: input.isActiveRelease ? "high" : "low",
      path: input.path,
      message: `README has no frontmatter (no id can be extracted)`,
      remediation: "Add YAML frontmatter with an id: field to the README",
    });
  } else {
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = YAML.parse(input.readmeFrontmatterRaw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    const hasIdLine = /^id\s*:/m.test(input.readmeFrontmatterRaw);

    if (parseError) {
      frontmatterError = parseError;
      railStatus = "malformed";
      if (hasIdLine) {
        findings.push({
          kind: "registration_ghost",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README has an id: line but frontmatter fails to parse (registration ghost): ${parseError}`,
          remediation: "Fix the YAML frontmatter syntax error so the id can be read",
        });
      } else {
        findings.push({
          kind: "registration_ghost",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README frontmatter fails to parse: ${parseError}`,
          remediation: "Fix the YAML frontmatter syntax error",
        });
      }
    } else {
      const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      parsedFrontmatter = fm;
      const id = typeof fm.id === "string" ? fm.id : null;

      if (!id) {
        findings.push({
          kind: "missing_id",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README frontmatter has no id field`,
          remediation: "Add an id: field to the README frontmatter matching the scope dot-ID convention",
        });
      } else {
        const validator = input.level === "mission" ? isMissionDotId : isSliceDotId;
        if (!validator(id)) {
          findings.push({
            kind: "id_convention_violation",
            severity: input.isActiveRelease ? "high" : "info",
            path: input.path,
            message: `id "${id}" does not match the ${input.level} dot-ID convention`,
            remediation: `Use a valid ${input.level} dot-ID format`,
          });
        }
      }
    }
  }

  if (input.level === "mission") {
    if (
      input.missionNotesExists === false
      && missionIsActive(parseStatusFromFrontmatter(input.readmeFrontmatterRaw))
    ) {
      const notesPath = input.missionNotesPath ?? childPath(input.path, "NOTES.md");
      findings.push({
        kind: "missing_mission_notes",
        severity: "low",
        path: notesPath,
        message: "Mission has no NOTES.md context file.",
        remediation: "Add NOTES.md at the mission root. Existing MISSION_NOTES.md remains a readable legacy fallback.",
      });
    }
  }

  if (input.level === "slice") {
    const status = input.sliceStatus ?? parseStatusFromFrontmatter(input.readmeFrontmatterRaw);
    const hasProofPacket = input.hasProofPacket === true;
    const hasRootProof = input.proofFileExists === true
      && input.proofDirExists === true
      && input.proofDirHasEntries === true;
    const isProven = statusRequiresProof(status) || hasProofPacket;
    if (isProven && !hasRootProof) {
      const proofPath = input.proofFilePath ?? childPath(input.path, "PROOF.md");
      findings.push({
        kind: "missing_proof",
        severity: "medium",
        path: proofPath,
        message: "Slice is done/proven but does not have complete root PROOF.md plus populated proof/ artifacts.",
        remediation: "Add PROOF.md at the slice root and put verification artifacts under proof/ per the slice-closeout SOP.",
      });
    }

    // OPR.0.4.4.19 FR-10 (C1 backstop) — flag proof/ artifacts missing the
    // C1 header or carrying out-of-set values. The backstop catches what
    // bypassed the drop path (raw file writes are never gated at write
    // time; this is where they surface).
    for (const artifact of input.proofArtifacts ?? []) {
      const problems = c1ArtifactProblems(artifact.frontmatterRaw);
      if (problems) {
        findings.push({
          kind: "proof_artifact_c1_invalid",
          severity: "medium",
          path: artifact.path,
          message: `Proof artifact violates the C1 header contract: ${problems.join("; ")}.`,
          remediation: `Re-drop via: rig proof add <slice> --artifact-type <${C1_ARTIFACT_TYPES.join("|")}> --verdict <${C1_VERDICTS.join("|")}> --candidate-sha <sha> --money-evidence "<line>" — or add the missing frontmatter fields in place.`,
        });
      }
    }

    // OPR.0.4.4.23 — SDLC convention-section advisories (SSOT:
    // docs/reference/sdlc-conventions.md). Structurally fail-open: the
    // audit command flips its exit code on HIGH findings only, and these
    // are low/info by construction — they record and advise, never gate.
    // Inert when the caller provided no content context (undefined inputs).
    const frontmatterIntent = typeof parsedFrontmatter.intent === "string"
      && parsedFrontmatter.intent.trim().length > 0;
    const currentSpec = input.nodeFileName === "SPEC.md"
      || (input.nodeFileName === undefined && frontmatterIntent);
    const nodeFileName = currentSpec ? "SPEC.md" : "README.md";
    if (typeof input.readmeContent === "string" && !frontmatterIntent && !hasH2(input.readmeContent, "Intent")) {
      findings.push({
        kind: "missing_intent_section",
        severity: "low",
        path: childPath(input.path, nodeFileName),
        message: `${nodeFileName} has no frontmatter \`intent:\` or legacy \`## Intent\` section.`,
        remediation: currentSpec
          ? "Add a non-empty `intent:` to SPEC.md frontmatter."
          : "Add a non-empty `intent:` or retain a legacy `## Intent` section in README.md.",
      });
    }

    // PM dogfood #1 (qitem-20260720015700-630eef64) — per-SECTION source
    // selection, decided independently for `## Mini-requirements` and
    // `## Proof contract`: an authored PRD section is canonical, but a
    // PRESENT-and-PRISTINE scaffold-only PRD section yields to an authored
    // (non-pristine) README section. Missing / prose-malformed / mixed-
    // authored PRD sections stay PRD-canonical and visible. Status-blind by
    // construction (lifecycle status is never read here). PRD absent keeps
    // the file-level README fallback byte-identically.
    const prdContentStr = typeof input.implementationPrdContent === "string" ? input.implementationPrdContent : null;
    const readmeContentStr = typeof input.readmeContent === "string" ? input.readmeContent : null;
    const pickSectionSource = (heading: string): { body: string | null; path: string } | null => {
      if (currentSpec && readmeContentStr !== null) {
        return { body: h2Body(readmeContentStr, heading), path: childPath(input.path, nodeFileName) };
      }
      if (prdContentStr !== null) {
        const prdBody = h2Body(prdContentStr, heading);
        if (isPristineScaffoldSection(prdBody) && readmeContentStr !== null) {
          const readmeBody = h2Body(readmeContentStr, heading);
          if (readmeBody !== null && !isPristineScaffoldSection(readmeBody)) {
            return { body: readmeBody, path: childPath(input.path, "README.md") };
          }
        }
        return { body: prdBody, path: childPath(input.path, "IMPLEMENTATION-PRD.md") };
      }
      if (readmeContentStr !== null) {
        return { body: h2Body(readmeContentStr, heading), path: childPath(input.path, "README.md") };
      }
      return null;
    };
    const miniSource = pickSectionSource("Mini-requirements");
    const contractSource = pickSectionSource("Proof contract");
    if (miniSource) {
      // OPR.0.4.4.23 rev1-r2 B1 (PRD L34 guard F-3): well-formed
      // `## Mini-requirements` — the PLAN leg of the Living Notes
      // projection, checked on this section's SELECTED source. Well-formed =
      // the heading plus at least one numbered list item; a heading over
      // prose-only is malformed (no usable requirements projection).
      const miniBody = miniSource.body;
      // release-0.4.7 micro-bundle A: an AUTHORED numbered item — the twin
      // module's ONE authored-numbered-item grammar, shared with review
      // compose (heals the dot/paren grammar split AND the placeholder
      // blindness in one predicate; the finding message below already reads
      // honestly for both and stays unchanged).
      const hasNumberedItem = hasAuthoredNumberedItem(miniBody);
      if (!hasNumberedItem) {
        findings.push({
          kind: "mini_requirements_missing_or_malformed",
          severity: "low",
          path: miniSource.path,
          message: miniBody === null
            ? "No `## Mini-requirements` section — the scope plan has no concise requirements tier."
            : "`## Mini-requirements` carries no numbered items (`1. …`) — the one-glance requirement tier is where approval starts.",
          remediation: `Add \`## Mini-requirements\` to ${nodeFileName} with a numbered list of observable outcomes (for a small slice this may be the whole specification).`,
        });
      }
    }

    if (contractSource) {
      const contractBody = contractSource.body;
      // release-0.4.7 intent-stage: an AUTHORED checkbox item — a scaffold
      // placeholder row is not a contract (shared grammar:
      // ./scaffold-placeholder.js — the same helper review compose and the
      // slice-detail projector consume; the R3 pin). A text-less checkbox row
      // still counts, exactly as before. Checked on this section's SELECTED
      // source (independent of the mini-reqs decision).
      const hasAuthoredCheckboxItem =
        contractBody !== null &&
        [...contractBody.matchAll(/^\s*-\s*\[[ xX]\]\s*(.*)$/gm)].some(
          (m) => !isScaffoldPlaceholderText((m[1] ?? "").trim()),
        );
      if (!hasAuthoredCheckboxItem) {
        findings.push({
          kind: "proof_contract_missing_or_malformed",
          severity: "low",
          path: contractSource.path,
          message: contractBody === null
            ? "No `## Proof contract` section — proof has no promised-deliverables source to pair against."
            : "`## Proof contract` carries no checkbox deliverables (`- [ ] …`) for proof to pair against.",
          remediation: `Add \`## Proof contract\` to ${nodeFileName} with one checkbox line per promised deliverable, written as an observable outcome (conventions SSOT: docs/reference/sdlc-conventions.md (installed: $OPENRIG_HOME/reference/sdlc-conventions.md)).`,
        });
      }

      if (typeof input.readmeContent === "string") {
        const visualBody = h2Body(input.readmeContent, "Intent visual");
        const isUiSlice = visualBody !== null && !/\bN\/A\b/i.test(visualBody);
        // rev1-r2 B2: a mockup is PRESENT only via a real markdown
        // image/media ref in `## Intent visual` or an explicit plannedRef
        // token in the proof contract. Generic prose containing the word
        // "mockup" (the scaffold placeholder says "name their planned
        // mockup") is NOT a reference and must not suppress the advisory.
        const hasMockupRef = /!\[/.test(visualBody ?? "")
          || /plannedRef/i.test(contractBody ?? "")
          || /!\[/.test(contractBody ?? "");
        if (isUiSlice && !hasMockupRef) {
          findings.push({
            kind: "ui_slice_missing_mockup",
            severity: "info",
            path: childPath(input.path, nodeFileName),
            message: "Slice declares an Intent visual (UI slice) but no mockup reference is present — a UI slice with no mockup in its locked set is an incomplete plan.",
            remediation: "Attach the planned mockup: an image ref in `## Intent visual` or a plannedRef on the proof-contract deliverable (conventions SSOT: docs/reference/sdlc-conventions.md §3 (installed: $OPENRIG_HOME/reference/sdlc-conventions.md §3)).",
          });
        }
      }
    }

  }

  return { railStatus, findings, frontmatterError };
}
