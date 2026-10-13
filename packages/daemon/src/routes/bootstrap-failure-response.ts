import type { BootstrapResult } from "../domain/bootstrap-orchestrator.js";

/** Present the same failed bootstrap outcome consistently on both entry routes.
 * Plan keeps its first-failed-stage response; apply promotes known refusal codes.
 * This does not decide whether bootstrap may proceed.
 */
export function bootstrapFailureResponse(result: BootstrapResult, mode: "plan" | "apply"): {
  body: BootstrapResult & { code?: string; error?: string };
  status: 400 | 409 | 500;
} {
  if (mode === "plan") {
    const failedStage = result.stages.find((s) => s.status === "failed" || s.status === "blocked");
    let httpStatus: 400 | 409 | 500 = 500;
    if (failedStage?.status === "blocked") httpStatus = 409;
    else if (failedStage?.stage === "resolve_spec") {
      const detail = failedStage.detail as { code?: string } | undefined;
      if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error" || detail?.code === "cycle_error" || detail?.code === "invalid_cwd") httpStatus = 400;
    }
    return { body: result, status: httpStatus };
  }

  // Conflict messages may be in stage detail (flat rigs) or errors (pod rigs).
  const hasBlocked = result.stages.some((s) => s.status === "blocked");
  let topLevelCode: string | undefined;
  let conflictError: string | undefined;
  const hasConflict = result.stages.some((s) => {
    if (s.status !== "failed" || s.stage !== "import_rig") return false;
    const detail = s.detail as { code?: string; message?: string } | undefined;
    if (detail?.code !== "rig_name_running" && detail?.code !== "generation_unconfirmed") return false;
    topLevelCode ??= detail.code;
    conflictError ??= detail.message ?? result.errors[0];
    return true;
  });
  const hasBadRequest = result.stages.some((s) => {
    if (s.status !== "failed") return false;
    const detail = s.detail as { code?: string } | undefined;
    const code = detail?.code;
    if (!code) return false;
    const isResolveSpec4xx = s.stage === "resolve_spec" && (code === "file_not_found" || code === "parse_error" || code === "validation_failed" || code === "bundle_error" || code === "target_conflict" || code === "cycle_error" || code === "invalid_cwd");
    const isImportRig4xx = s.stage === "import_rig" && (code === "validation_failed" || code === "preflight_failed" || code === "cycle_error" || code === "service_boot_failed" || code === "compose_project_conflict");
    if (isResolveSpec4xx || isImportRig4xx) {
      topLevelCode ??= code;
      return true;
    }
    return false;
  });
  const failedBody = topLevelCode
    ? { ...result, code: topLevelCode, ...(conflictError ? { error: conflictError } : {}) }
    : result;
  return { body: failedBody, status: hasBlocked || hasConflict ? 409 : hasBadRequest ? 400 : 500 };
}
