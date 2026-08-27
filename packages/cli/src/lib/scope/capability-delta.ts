import fs from "node:fs";
import path from "node:path";

import type { AuditFinding } from "./scope-audit.js";
import { splitFrontmatter } from "./scope-fs.js";

const CAPABILITY_DELTA_FILE = /^CAPABILITY-DELTA-v.+\.md$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function documentHeader(content: string): string {
  const firstSection = content.search(/^##\s+/m);
  return firstSection === -1 ? content : content.slice(0, firstSection);
}

/**
 * Derive expiry advisories for versioned capability deltas at a mission root.
 * The event is deliberately conjunctive: canon must name the exact delta in its
 * header AND a distinct successor file must exist. Missing or unreadable inputs
 * remain unknown/live and never turn the advisory into a gate.
 */
export function capabilityDeltaExpiryFindings(missionDir: string): AuditFinding[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(missionDir)
      .filter((filename) => CAPABILITY_DELTA_FILE.test(filename))
      .sort();
  } catch {
    return [];
  }

  const findings: AuditFinding[] = [];
  for (const filename of filenames) {
    const deltaPath = path.join(missionDir, filename);
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = splitFrontmatter(fs.readFileSync(deltaPath, "utf8")).frontmatter;
    } catch {
      continue;
    }

    const identity = typeof frontmatter.capability_delta === "string"
      ? frontmatter.capability_delta.trim()
      : "";
    const expiry = asRecord(frontmatter.expiry);
    const canonRef = typeof expiry?.canon_path === "string" ? expiry.canon_path.trim() : "";
    const successorRef = typeof expiry?.successor_path === "string" ? expiry.successor_path.trim() : "";
    if (!identity || !canonRef || !successorRef) continue;

    const canonPath = path.resolve(path.dirname(deltaPath), canonRef);
    const successorPath = path.resolve(path.dirname(deltaPath), successorRef);
    if (successorPath === deltaPath || !fs.existsSync(canonPath) || !fs.existsSync(successorPath)) continue;

    let canonNamesDelta = false;
    try {
      canonNamesDelta = documentHeader(fs.readFileSync(canonPath, "utf8"))
        .split(/[^A-Za-z0-9._-]+/)
        .includes(identity);
    } catch {
      continue;
    }
    if (!canonNamesDelta) continue;

    findings.push({
      kind: "expired_capability_delta",
      severity: "medium",
      path: deltaPath,
      message: `Capability delta ${identity} reached its expiry event: canon header ${canonRef} names it and successor ${successorRef} exists; it is citable no more.`,
      remediation: `Stop citing ${filename}; use the successor delta and archive this release-specific artifact when the release procedure calls for it.`,
    });
  }
  return findings;
}
