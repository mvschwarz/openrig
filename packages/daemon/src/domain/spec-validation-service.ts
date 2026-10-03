import { parseAgentSpec, validateAgentSpec } from "./agent-manifest.js";
import { RigSpecCodec } from "./rigspec-codec.js";
import { LegacyRigSpecSchema, RigSpecSchema } from "./rigspec-schema.js";
import type { ValidationResult } from "./types.js";

/** Only parser failures are client input errors; validator exceptions remain internal failures. */
export class RigSpecParseError extends Error {}

/** Shared CLI/import validation with a distinct parser-error boundary. */
export function validateRigSpecImport(yaml: string): ValidationResult {
  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(yaml);
  } catch (err) {
    throw new RigSpecParseError(err instanceof Error ? err.message : String(err), { cause: err });
  }
  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  return isPodAware ? RigSpecSchema.validate(raw) : LegacyRigSpecSchema.validate(raw);
}

/**
 * Validate an AgentSpec from raw YAML text.
 * No filesystem access, no side effects.
 * @param yaml - raw agent.yaml content
 * @returns validation result
 */
export function validateAgentSpecFromYaml(yaml: string): { valid: boolean; errors: string[] } {
  try {
    const raw = parseAgentSpec(yaml);
    return validateAgentSpec(raw);
  } catch (err) {
    return { valid: false, errors: [`Parse error: ${(err as Error).message}`] };
  }
}

/**
 * Validate a pod-aware RigSpec from raw YAML text.
 * No filesystem access, no side effects.
 * @param yaml - raw rig.yaml content
 * @returns validation result
 */
export function validateRigSpecFromYaml(yaml: string): { valid: boolean; errors: string[] } {
  try {
    const raw = RigSpecCodec.parse(yaml);
    return RigSpecSchema.validate(raw);
  } catch (err) {
    return { valid: false, errors: [`Parse error: ${(err as Error).message}`] };
  }
}
