// Slice-04 (OPR.0.5.0.4) seam C1 — a DAEMON-LOCAL, secret-safe reader of the codex-auth on-disk
// contract. The daemon cannot import packages/cli (no @openrig/cli dep); this re-reads the same
// documented format: $CODEX_HOME||~/.codex with auth-profiles/*.json (profile NAMES) and
// auth-seat-registry.tsv (6 tab columns: seat/rig/runtime/cwd/auth_profile/updated_ts — NO token
// column). It reads profile NAMES and the TSV ONLY — never the profile *.json contents, which hold
// token-class material (BR-6: no secret ever surfaces).

import fs from "node:fs";
import path from "node:path";

export interface CodexSeatRow {
  seat: string;
  rig: string;
  runtime: string;
  cwd: string;
  /** The codex-auth profile name this seat is registered against (opaque, non-secret). */
  authProfile: string;
  updatedTs: string;
}

export interface CodexAuthMetadata {
  /** Profile NAMES (opaque, non-secret refs) — never file contents. */
  profiles: string[];
  seats: CodexSeatRow[];
}

const SEAT_COLUMN_COUNT = 6;

function resolveCodexHome(env: NodeJS.ProcessEnv): { profileDir: string; registryPath: string } {
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0
      ? env.CODEX_HOME
      : path.join(env.HOME ?? "", ".codex");
  return {
    profileDir: path.join(codexHome, "auth-profiles"),
    registryPath: path.join(codexHome, "auth-seat-registry.tsv"),
  };
}

// Profile NAMES only — the *.json file contents (token-class) are never opened.
function listProfiles(profileDir: string): string[] {
  try {
    return fs
      .readdirSync(profileDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

function readSeats(registryPath: string): CodexSeatRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch {
    return [];
  }
  const rows: CodexSeatRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const cols = line.split("\t");
    if (cols.length !== SEAT_COLUMN_COUNT) continue; // skip malformed rows — never fabricate fields
    // Length is exactly 6 above, so the tuple destructure is total (satisfies noUncheckedIndexedAccess).
    const [seat, rig, runtime, cwd, authProfile, updatedTs] = cols as [string, string, string, string, string, string];
    if (seat === "seat") continue; // the header row
    rows.push({ seat, rig, runtime, cwd, authProfile, updatedTs });
  }
  return rows;
}

/** Read the codex-auth on-disk METADATA (profile names + seat registry). Never throws; never
 *  surfaces token-class content. Absent home/files yield empty arrays. */
export function readCodexAuthMetadata(env: NodeJS.ProcessEnv = process.env): CodexAuthMetadata {
  const { profileDir, registryPath } = resolveCodexHome(env);
  return {
    profiles: listProfiles(profileDir),
    seats: readSeats(registryPath),
  };
}
