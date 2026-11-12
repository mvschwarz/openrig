import type Database from "better-sqlite3";
import { isCommunityHarnessRuntime } from "./built-in-runtimes.js";

export const LAUNCH_WRAPPER_RUNTIMES: ReadonlySet<string> = new Set(["pi", "codex", "claude-code"]);

export function isLaunchWrapperRuntime(runtime: unknown): runtime is string {
  return typeof runtime === "string" && (LAUNCH_WRAPPER_RUNTIMES.has(runtime) || (isCommunityHarnessRuntime(runtime) && runtime !== "openshell-claude"));
}

export function unsupportedCommunityRunnerLaunchWrapperMessage(runtime: string): string {
  return `launch_wrapper unsupported: the community preset "${runtime}" runs a runner without launch_wrapper: true; no agent started. Add launch_wrapper: true to the preset if its runner applies OPENRIG_LAUNCH_WRAPPER, or remove launch_wrapper from this member.`;
}

function isValidWrapperExecutable(executable: string): boolean {
  if (executable.trim().length === 0) return false;
  return executable.startsWith("/") || !executable.includes("/");
}

/**
 * Validate an authored `launch_wrapper` array.
 * `[]` is valid and represents explicit clear/none.
 * Non-empty arrays must start with a non-empty bare executable name or absolute path,
 * and every element must be a string without NUL, CR, or LF characters.
 */
export function validateLaunchWrapper(value: unknown, label = "launch_wrapper"): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: must be an array of argument strings`);
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string") {
      throw new Error(`${label}[${i}]: must be a string`);
    }
    if (/[\0\r\n]/.test(item)) {
      throw new Error(`${label}[${i}]: must not contain NUL, CR, or LF characters`);
    }
    if (i === 0) {
      if (item.trim().length === 0) {
        throw new Error(`${label}[0]: executable must be a non-empty string`);
      }
      if (!isValidWrapperExecutable(item)) {
        throw new Error(
          `${label}[0]: executable must be an absolute path or a bare command name on the daemon PATH (got ${JSON.stringify(item)})`,
        );
      }
    }
    result.push(item);
  }
  return result;
}

/**
 * Parse a persisted `nodes.launch_wrapper` value.
 * Canonical DB "none" is SQL NULL (`undefined` / `null` -> `undefined`).
 * Non-empty JSON arrays validate and return `string[]`.
 * Stored `[]`, malformed JSON, or invalid elements throw (fail closed).
 */
export function parseStoredLaunchWrapper(raw: unknown, label = "launch_wrapper"): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`${label}: stored value must be a JSON string or null`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label}: stored value is not valid JSON`);
  }
  const validated = validateLaunchWrapper(parsed, label);
  if (validated.length === 0) {
    throw new Error(`${label}: stored value must not be an empty array`);
  }
  return validated;
}

/**
 * Read the seat's persisted `launch_wrapper` on launch, resume, restore, or switch.
 * Legacy databases without the `launch_wrapper` column return `undefined`.
 * Invalid or non-canonical stored data throws so a selected wrapper never silently unwraps.
 */
export function readSeatLaunchWrapper(db: Database.Database, nodeId: string): string[] | undefined {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as
    | { launch_wrapper?: unknown; runtime?: unknown }
    | undefined;
  const parsed = parseStoredLaunchWrapper(row?.launch_wrapper, `Seat ${nodeId} launch_wrapper`);
  if (parsed && row?.runtime !== undefined && row?.runtime !== null && !isLaunchWrapperRuntime(row.runtime)) {
    throw new Error(`Seat ${nodeId} launch_wrapper: only valid when runtime is "pi", "codex", "claude-code" or a supported community harness`);
  }
  return parsed;
}

/**
 * Compare two `launch_wrapper` selections where `undefined`, `null`, and `[]` all represent "none".
 */
export function sameLaunchWrapper(
  a?: readonly string[] | null,
  b?: readonly string[] | null,
): boolean {
  const normA = a && a.length > 0 ? a : undefined;
  const normB = b && b.length > 0 ? b : undefined;
  if (!normA && !normB) return true;
  if (!normA || !normB) return false;
  if (normA.length !== normB.length) return false;
  return normA.every((item, idx) => item === normB[idx]);
}
