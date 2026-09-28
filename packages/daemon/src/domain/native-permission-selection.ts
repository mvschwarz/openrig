/** Native permission choices are future-launch settings, not work posture. */
export interface NativePermissionSelection {
  runtime: "codex" | "claude-code";
  mode: string;
}

/** Missing managed-launch wiring must never fall back to daemon-local help. */
export async function unresolvedClaudePermissionModes(): Promise<string[] | null> {
  throw new Error("Claude seat launch context is unresolved; native mode support is unavailable. Selection/launch refused without a fallback.");
}

export function validateNativePermissionSelection(
  runtime: string,
  mode: string,
  supportedClaudeModes: readonly string[] | null = null,
): NativePermissionSelection {
  if (runtime !== "codex" && runtime !== "claude-code") {
    throw new Error(`Per-seat permission mode is unsupported for runtime '${runtime}'. Pi resource trust is separate.`);
  }
  if (mode === "floor" || mode === "full_bypass") return { runtime, mode };
  if (runtime === "codex") throw new Error("Codex permission mode must be floor or full_bypass (or inherit to clear the selection).");
  // Only an exact, shell-safe option advertised by the installed harness is accepted.
  if (!supportedClaudeModes) throw new Error("Claude permission options are unavailable; selection was not changed.");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(mode) || !supportedClaudeModes.includes(mode)) {
    throw new Error(`Claude permission mode '${mode}' is not supported by the installed harness.`);
  }
  return { runtime, mode };
}

export function permissionBindingOverride(selection: NativePermissionSelection | null): {
  launchPosture?: "floor" | "full_bypass";
  permissionMode?: string;
} {
  if (!selection) return {};
  if (selection.mode === "floor" || selection.mode === "full_bypass") return { launchPosture: selection.mode };
  if (selection.runtime !== "claude-code") throw new Error("Invalid persisted native permission selection.");
  return { permissionMode: selection.mode };
}
