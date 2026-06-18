import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyScopeItem, type ScopeAuditResult } from "../domain/scope/scope-audit.js";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
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

    const missionReadme = path.join(missionDir, "README.md");
    const missionProgress = path.join(missionDir, "PROGRESS.md");
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
          message: "PROGRESS.md exists but no README.md (orphan progress rail, no backing scope item)",
          remediation: "Add a README.md with frontmatter id, or remove the orphan PROGRESS.md",
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
      });
    }

    const slicesDir = path.join(missionDir, "slices");
    const sliceResults: Array<{ name: string; result: ScopeAuditResult }> = [];

    if (fs.existsSync(slicesDir)) {
      for (const entry of fs.readdirSync(slicesDir)) {
        const sliceDir = path.join(slicesDir, entry);
        if (!fs.statSync(sliceDir).isDirectory()) continue;
        const sliceReadme = path.join(sliceDir, "README.md");
        const sliceProgress = path.join(sliceDir, "PROGRESS.md");

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
                  message: "PROGRESS.md exists but no README.md (orphan progress rail, no backing scope item)",
                  remediation: "Add a README.md with frontmatter id, or remove the orphan PROGRESS.md",
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

        const sliceFm = extractFrontmatterRaw(fs.readFileSync(sliceReadme, "utf-8"));
        const readmeOnlyMarker = sliceFm !== null && /^progress_rail\s*:\s*readme-only/m.test(sliceFm);

        const sliceResult = classifyScopeItem({
          id: null,
          path: sliceDir,
          readmeFrontmatterRaw: sliceFm,
          progressFileExists: fs.existsSync(sliceProgress),
          readmeOnlyMarker,
          isActiveRelease: true,
          level: "slice",
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

        sliceResults.push({ name: entry, result: sliceResult });
      }
    }

    const allFindings = [
      ...missionResult.findings,
      ...sliceResults.flatMap((s) => s.result.findings),
    ];

    return c.json({
      ok: allFindings.length === 0,
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
      })),
      totalFindings: allFindings.length,
    });
  });

  return app;
}
