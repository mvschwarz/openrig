import { Hono } from "hono";
import { attestationLineage, type AttestationLineage } from "../domain/scope/attestation-lineage.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AuditFinding, classifyScopeItem, type ScopeAuditResult } from "../domain/scope/scope-audit.js";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import { resolveNodeFile } from "../domain/scope/node-file.js";

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
}

function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

// OPR.0.4.4.19 FR-10 (C1 backstop input) — list the slice's proof/ markdown
// artifacts with raw frontmatter. Media files are exempt by construction.
// Undefined when the dir is absent/unreadable so the classifier stays inert.
function listProofArtifactsForAudit(proofDir: string): Array<{ path: string; frontmatterRaw: string | null }> | undefined {
  if (!fs.existsSync(proofDir)) return undefined;
  try {
    return fs.readdirSync(proofDir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => {
        const artifactPath = path.join(proofDir, f);
        return { path: artifactPath, frontmatterRaw: extractFrontmatterRaw(fs.readFileSync(artifactPath, "utf-8")) };
      });
  } catch {
    return undefined;
  }
}


/**
 * Advisory-only: a work node carrying BOTH authored files. The daemon twin of the CLI finding of the
 * same name — same contract, separate code, because the daemon cannot import packages/cli.
 *
 * SPEC.md wins and nothing blocks. The point is that a shadowed README.md is invisible otherwise,
 * and any surface still reading the legacy name is reading the OTHER file.
 */
function shadowedNodeFileFinding(dir: string, level: "mission" | "slice"): AuditFinding | null {
  if (!fs.existsSync(path.join(dir, "SPEC.md")) || !fs.existsSync(path.join(dir, "README.md"))) return null;
  return {
    kind: "shadowed_node_file",
    severity: "low",
    path: dir,
    message: `${level} has BOTH SPEC.md and README.md; SPEC.md is the authored node file and wins, so README.md is shadowed and any surface still reading the legacy name sees different content.`,
    remediation: "Fold anything still needed from README.md into SPEC.md and remove the shadowed file. Advisory only — nothing is blocked.",
  };
}

export function scopeAuditRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!indexer) {
      return c.json({ error: "slices_indexer_unavailable" }, 503);
    }
    if (!indexer.isReady()) {
      return c.json({ error: "slices_root_not_configured" }, 503);
    }

    const missionName = c.req.query("mission");
    if (!missionName) {
      return c.json({ error: "missing_mission_param", hint: "Pass ?mission=<name>" }, 400);
    }

    const missionsRoot = indexer.slicesRoot;
    const missionDir = path.join(missionsRoot, missionName);
    if (!fs.existsSync(missionDir)) {
      return c.json({ error: "mission_not_found", mission: missionName }, 404);
    }

    // qitem-43d69e17 — ONE audit request is ONE composite operation: the
    // per-slice indexer.get() walk below shares ONE membership batch
    // (pre-scope: each uncached get built its own 2-scan batch — 2N total
    // queue scans, 80 at 40 slices). Handler body is fully synchronous.
    return indexer.withMembershipBatch(() => {
      const missionReadme = resolveNodeFile(missionDir) ?? path.join(missionDir, "SPEC.md");
      const missionProgress = path.join(missionDir, "PROGRESS.md");
      const missionNotesCurrent = path.join(missionDir, "NOTES.md");
      const missionNotesLegacy = path.join(missionDir, "MISSION_NOTES.md");
      const missionNotesExists = fs.existsSync(missionNotesCurrent) || fs.existsSync(missionNotesLegacy);
      const missionReadmeExists = fs.existsSync(missionReadme);
      const missionProgressExists = fs.existsSync(missionProgress);

      let missionResult: ScopeAuditResult;
      if (!missionReadmeExists && missionProgressExists) {
        missionResult = {
          railStatus: "malformed",
          findings: [{
            kind: "orphan_progress",
            severity: "high",
            path: missionDir,
            message: "PROGRESS.md exists but no SPEC.md or legacy README.md (orphan progress rail, no backing scope item)",
            remediation: "Add SPEC.md with frontmatter id, or remove the orphan PROGRESS.md",
          }],
          frontmatterError: null,
        };
      } else {
        const missionFm = missionReadmeExists
          ? extractFrontmatterRaw(fs.readFileSync(missionReadme, "utf-8"))
          : null;
        missionResult = classifyScopeItem({
          id: null,
          path: missionDir,
          readmeFrontmatterRaw: missionFm,
            progressFileExists: missionProgressExists,
            readmeOnlyMarker: false,
            isActiveRelease: true,
            level: "mission",
            missionNotesExists,
            missionNotesPath: missionNotesCurrent,
          });
      }

      const slicesDir = path.join(missionDir, "slices");
      const missionShadow = shadowedNodeFileFinding(missionDir, "mission");
      if (missionShadow) missionResult.findings.push(missionShadow);

      const sliceResults: Array<{ name: string; result: ScopeAuditResult; attestations?: AttestationLineage }> = [];

      if (fs.existsSync(slicesDir)) {
        for (const entry of fs.readdirSync(slicesDir)) {
          const sliceDir = path.join(slicesDir, entry);
          if (!fs.statSync(sliceDir).isDirectory()) continue;
          const sliceReadme = resolveNodeFile(sliceDir) ?? path.join(sliceDir, "SPEC.md");
          const sliceProgress = path.join(sliceDir, "PROGRESS.md");
          const proofFile = path.join(sliceDir, "PROOF.md");
          const proofDir = path.join(sliceDir, "proof");

          if (!fs.existsSync(sliceReadme)) {
            if (fs.existsSync(sliceProgress)) {
              sliceResults.push({
                name: entry,
                result: {
                  railStatus: "malformed",
                  findings: [{
                    kind: "orphan_progress",
                    severity: "high",
                    path: sliceDir,
                    message: "PROGRESS.md exists but no SPEC.md or legacy README.md (orphan progress rail, no backing scope item)",
                    remediation: "Add SPEC.md with frontmatter id, or remove the orphan PROGRESS.md",
                  }],
                  frontmatterError: null,
                },
              });
            } else {
              const noReadmeResult = classifyScopeItem({
                id: null,
                path: sliceDir,
                readmeFrontmatterRaw: null,
                progressFileExists: false,
                readmeOnlyMarker: false,
                isActiveRelease: true,
                level: "slice",
              });
              sliceResults.push({ name: entry, result: noReadmeResult });
            }
            continue;
          }

          const sliceReadmeContent = fs.readFileSync(sliceReadme, "utf-8");
          const sliceFm = extractFrontmatterRaw(sliceReadmeContent);
          const readmeOnlyMarker = sliceFm !== null && /^progress_rail\s*:\s*readme-only/m.test(sliceFm);
          const indexedSlice = indexer.get(entry);

          const sliceResult = classifyScopeItem({
            id: null,
            path: sliceDir,
            readmeFrontmatterRaw: sliceFm,
            progressFileExists: fs.existsSync(sliceProgress),
            readmeOnlyMarker,
            isActiveRelease: true,
            level: "slice",
            proofFileExists: fs.existsSync(proofFile),
            proofFilePath: proofFile,
            proofDirExists: fs.existsSync(proofDir),
            proofDirPath: proofDir,
            proofDirHasEntries: directoryHasEntries(proofDir),
            hasProofPacket: indexedSlice?.proofPacket !== null && indexedSlice?.proofPacket !== undefined,
            sliceStatus: indexedSlice?.rawStatus ?? null,
            // OPR.0.4.4.19 FR-10 backstop inputs (parity with the CLI builder).
            proofArtifacts: listProofArtifactsForAudit(proofDir),
            implementationPrdExists: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md")),
            // OPR.0.4.4.23 convention-section advisory inputs (parity with the CLI builder).
            nodeFileName: path.basename(sliceReadme) as "SPEC.md" | "README.md",
            readmeContent: sliceReadmeContent,
            implementationPrdContent: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"))
              ? fs.readFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "utf-8")
              : null,
          });

          if (!/^\d{2}-/.test(entry)) {
            sliceResult.findings.push({
              kind: "id_convention_violation",
              severity: "high",
              path: sliceDir,
              message: `Directory "${entry}" does not match the NN-slug slice naming convention (e.g. 01-my-slice)`,
              remediation: "Rename to NN-slug format or move out of slices/",
            });
          }

          sliceResults.push({ name: entry, result: sliceResult, attestations: attestationLineage(sliceFm) });
        }
      }

      for (const sr of sliceResults) {
        const shadow = shadowedNodeFileFinding(path.join(slicesDir, sr.name), "slice");
        if (shadow) sr.result.findings.push(shadow);
      }

      const allFindings = [
        ...missionResult.findings,
        ...sliceResults.flatMap((s) => s.result.findings),
      ];
      const hardFindings = allFindings.filter((f) => f.severity === "high");

      return c.json({
        ok: hardFindings.length === 0,
        mission: {
          name: missionName,
          railStatus: missionResult.railStatus,
          frontmatterError: missionResult.frontmatterError,
          findings: missionResult.findings,
        },
        slices: sliceResults.map((s) => ({
          name: s.name,
          railStatus: s.result.railStatus,
          frontmatterError: s.result.frontmatterError,
          findings: s.result.findings,
          // OPR.0.5.0.18 — amendment lineage (present only when re-stamped).
          ...(s.attestations ? { attestations: s.attestations } : {}),
        })),
        totalFindings: allFindings.length,
      });
    });
  });

  return app;
}
