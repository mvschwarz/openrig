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

/** How the seat registry read went: absent (ENOENT), read, or unreadable (the error code only, never contents). */
export interface CodexSeatRegistryRead {
  status: "absent" | "read" | "unreadable";
  code?: string;
  /** Rows skipped because they don't have the six columns. */
  malformedRows: number;
}

export interface CodexAuthMetadata {
  /** Profile NAMES (opaque, non-secret refs) — never file contents. */
  profiles: string[];
  seats: CodexSeatRow[];
  /** Additive: lets a caller tell a supported absence from an unreadable or malformed registry. */
  registry?: CodexSeatRegistryRead;
  /** Additive: how the profile folder read went (absent, read, or unreadable with the error code only). */
  profilesRead?: { status: "absent" | "read" | "unreadable"; code?: string };
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

// Profile NAMES only — the *.json file contents (token-class) are never opened. Mirrors readSeats: a missing
// folder means none saved; any other error is unreadable (the code only), with `profiles` still [].
function listProfiles(profileDir: string): { profiles: string[]; profilesRead: NonNullable<CodexAuthMetadata["profilesRead"]> } {
  try {
    const profiles = fs
      .readdirSync(profileDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort();
    return { profiles, profilesRead: { status: "read" } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { profiles: [], profilesRead: { status: "absent" } }
      : { profiles: [], profilesRead: { status: "unreadable", code: code ?? "unknown" } };
  }
}

function readSeats(registryPath: string): { seats: CodexSeatRow[]; registry: CodexSeatRegistryRead } {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { seats: [], registry: { status: "absent", malformedRows: 0 } }
      : { seats: [], registry: { status: "unreadable", code: code ?? "unknown", malformedRows: 0 } };
  }
  const rows: CodexSeatRow[] = [];
  let malformedRows = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const cols = line.split("\t");
    if (cols.length !== SEAT_COLUMN_COUNT) { // skip malformed rows — never fabricate fields
      malformedRows += 1;
      continue;
    }
    // Length is exactly 6 above, so the tuple destructure is total (satisfies noUncheckedIndexedAccess).
    const [seat, rig, runtime, cwd, authProfile, updatedTs] = cols as [string, string, string, string, string, string];
    if (seat === "seat") continue; // the header row
    rows.push({ seat, rig, runtime, cwd, authProfile, updatedTs });
  }
  return { seats: rows, registry: { status: "read", malformedRows } };
}

/** Read the codex-auth on-disk METADATA (profile names + seat registry). Never throws; never
 *  surfaces token-class content. Absent home/files yield empty arrays. */
export function readCodexAuthMetadata(env: NodeJS.ProcessEnv = process.env): CodexAuthMetadata {
  const { profileDir, registryPath } = resolveCodexHome(env);
  const { seats, registry } = readSeats(registryPath);
  const { profiles, profilesRead } = listProfiles(profileDir);
  return {
    profiles,
    seats,
    registry,
    profilesRead,
  };
}
