import { validateSafePath } from "./path-safety.js";
import type { StartupBlock, StartupFile, StartupAction } from "./types.js";

// -- Constants --

const VALID_DELIVERY_HINTS = new Set(["auto", "guidance_merge", "skill_install", "send_text"]);
const VALID_ACTION_TYPES = new Set(["slash_command", "send_text"]);
const VALID_PHASES = new Set(["after_files", "after_ready"]);
const VALID_APPLIES_ON = new Set(["fresh_start", "restore"]);

// -- Validation --

/**
 * Validate a startup file entry.
 * @param raw - parsed file object
 * @param index - position in files array
 * @param prefix - error message prefix
 * @returns array of error strings
 */
export function validateStartupFile(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  // PL-014 Item 6: kind defaults to "file" for back-compat. When
  // "context_pack", path is synthesized by the resolver, so the safe-
  // path check is skipped and `name` is required instead.
  const kind = (raw["kind"] as string | undefined) ?? "file";
  if (kind !== "file" && kind !== "context_pack") {
    errors.push(`${prefix}files[${index}].kind: must be one of file, context_pack (got "${kind}")`);
  }
  if (kind === "context_pack") {
    if (typeof raw["name"] !== "string" || (raw["name"] as string).length === 0) {
      errors.push(`${prefix}files[${index}].name: required when kind: context_pack`);
    }
    if (raw["version"] !== undefined && typeof raw["version"] !== "string" && typeof raw["version"] !== "number") {
      errors.push(`${prefix}files[${index}].version: must be a string or number when kind: context_pack`);
    }
  } else {
    const pathErr = validateSafePath(raw["path"] as string, `${prefix}files[${index}].path`);
    if (pathErr) errors.push(pathErr);
  }
  if (raw["delivery_hint"] !== undefined && !VALID_DELIVERY_HINTS.has(raw["delivery_hint"] as string)) {
    errors.push(`${prefix}files[${index}].delivery_hint: must be one of ${[...VALID_DELIVERY_HINTS].join(", ")} (got "${raw["delivery_hint"]}")`);
  }
  if (raw["applies_on"] !== undefined) {
    if (!Array.isArray(raw["applies_on"])) {
      errors.push(`${prefix}files[${index}].applies_on: must be an array`);
    } else {
      for (const v of raw["applies_on"]) {
        if (!VALID_APPLIES_ON.has(v as string)) {
          errors.push(`${prefix}files[${index}].applies_on: invalid value "${v}"; must be one of ${[...VALID_APPLIES_ON].join(", ")}`);
        }
      }
    }
  }
  return errors;
}

/**
 * Validate a startup action entry.
 * @param raw - parsed action object
 * @param index - position in actions array
 * @param prefix - error message prefix
 * @returns array of error strings
 */
export function validateStartupAction(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  const type = raw["type"] as string;
  if (type === "shell") {
    errors.push(`${prefix}actions[${index}].type: "shell" startup actions are not supported in v1; use "slash_command" or "send_text"`);
  } else if (!VALID_ACTION_TYPES.has(type)) {
    errors.push(`${prefix}actions[${index}].type: must be one of ${[...VALID_ACTION_TYPES].join(", ")} (got "${type}")`);
  }
  if (!raw["value"] || typeof raw["value"] !== "string") {
    errors.push(`${prefix}actions[${index}].value: must be a non-empty string`);
  }
  if (raw["phase"] !== undefined && !VALID_PHASES.has(raw["phase"] as string)) {
    errors.push(`${prefix}actions[${index}].phase: must be one of ${[...VALID_PHASES].join(", ")} (got "${raw["phase"]}")`);
  }
  if (raw["idempotent"] === undefined || raw["idempotent"] === null) {
    errors.push(`${prefix}actions[${index}].idempotent: required field`);
  } else if (typeof raw["idempotent"] !== "boolean") {
    errors.push(`${prefix}actions[${index}].idempotent: must be a boolean`);
  }
  if (raw["applies_on"] !== undefined) {
    if (!Array.isArray(raw["applies_on"])) {
      errors.push(`${prefix}actions[${index}].applies_on: must be an array`);
    } else {
      for (const v of raw["applies_on"]) {
        if (!VALID_APPLIES_ON.has(v as string)) {
          errors.push(`${prefix}actions[${index}].applies_on: invalid value "${v}"; must be one of ${[...VALID_APPLIES_ON].join(", ")}`);
        }
      }
    }
  }
  // Restore-safety: non-idempotent actions must not apply on restore
  // This covers both explicit idempotent=false AND missing idempotent with default applies_on
  if (raw["idempotent"] === false || raw["idempotent"] === undefined) {
    const appliesOn = Array.isArray(raw["applies_on"]) ? raw["applies_on"] as string[] : ["fresh_start", "restore"];
    if (appliesOn.includes("restore")) {
      errors.push(`${prefix}actions[${index}]: non-idempotent action must not apply on restore`);
    }
  }
  return errors;
}

/**
 * Validate a startup block (files + actions).
 * @param raw - parsed startup object
 * @param prefix - error message prefix
 * @returns array of error strings
 */
export function validateStartupBlock(raw: unknown, prefix: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object") return [`${prefix}: must be an object`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (obj["files"] !== undefined) {
    if (!Array.isArray(obj["files"])) {
      errors.push(`${prefix}.files: must be an array`);
    } else {
      for (let i = 0; i < (obj["files"] as unknown[]).length; i++) {
        errors.push(...validateStartupFile((obj["files"] as Record<string, unknown>[])[i]!, i, `${prefix}.`));
      }
    }
  }
  if (obj["actions"] !== undefined) {
    if (!Array.isArray(obj["actions"])) {
      errors.push(`${prefix}.actions: must be an array`);
    } else {
      for (let i = 0; i < (obj["actions"] as unknown[]).length; i++) {
        errors.push(...validateStartupAction((obj["actions"] as Record<string, unknown>[])[i]!, i, `${prefix}.`));
      }
    }
  }
  return errors;
}

// -- Normalization --

/**
 * Normalize a startup block into the canonical typed shape with defaults.
 * @param raw - parsed startup object
 * @returns normalized StartupBlock
 */
export function normalizeStartupBlock(raw: unknown): StartupBlock {
  if (!raw || typeof raw !== "object") return { files: [], actions: [] };
  const obj = raw as Record<string, unknown>;

  const files: StartupFile[] = Array.isArray(obj["files"])
    ? (obj["files"] as Record<string, unknown>[]).map((f) => {
        // PL-014 Item 6: kind defaults to "file" for back-compat;
        // "context_pack" entries reference a pack by name + version.
        const kind = (f["kind"] as string | undefined) ?? "file";
        if (kind === "context_pack") {
          const name = f["name"] as string | undefined;
          const version = f["version"] !== undefined ? String(f["version"]) : "1";
          // Synthesize a stable path so downstream consumers that
          // identify files by `path` (e.g., logs, error messages)
          // get a meaningful identifier. The instantiator's resolver
          // overwrites this with the actual on-disk bundle path.
          const synthPath = `.openrig/resolved-context-packs/${name ?? "(missing-name)"}-${version}.md`;
          return {
            kind: "context_pack" as const,
            path: synthPath,
            contextPackName: name,
            contextPackVersion: version,
            // Send-text by default: pack lands as one paste in the live
            // seat. Operator can override via delivery_hint if they want
            // pre-launch filesystem delivery instead.
            deliveryHint: (f["delivery_hint"] as StartupFile["deliveryHint"]) ?? "send_text",
            required: f["required"] !== false,
            appliesOn: Array.isArray(f["applies_on"])
              ? (f["applies_on"] as StartupFile["appliesOn"])
              : ["fresh_start", "restore"],
          };
        }
        return {
          kind: "file" as const,
          path: f["path"] as string,
          deliveryHint: (f["delivery_hint"] as StartupFile["deliveryHint"]) ?? "auto",
          required: f["required"] !== false,
          appliesOn: Array.isArray(f["applies_on"])
            ? (f["applies_on"] as StartupFile["appliesOn"])
            : ["fresh_start", "restore"],
        };
      })
    : [];

  const actions: StartupAction[] = Array.isArray(obj["actions"])
    ? (obj["actions"] as Record<string, unknown>[]).map((a) => ({
        type: a["type"] as StartupAction["type"],
        value: a["value"] as string,
        phase: (a["phase"] as StartupAction["phase"]) ?? "after_files",
        appliesOn: Array.isArray(a["applies_on"])
          ? (a["applies_on"] as StartupAction["appliesOn"])
          : ["fresh_start", "restore"],
        idempotent: a["idempotent"] as boolean,
      }))
    : [];

  return { files, actions };
}
