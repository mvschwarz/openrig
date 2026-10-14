/** Stop restore before launch when saved startup context names a different runtime. */
export function restoreRuntimeCompatibilityError(
  runtime: string | null,
  startupRuntime: string | null | undefined,
): string | null {
  if (!runtime || !startupRuntime || startupRuntime === runtime) return null;
  return "No session was started for this seat. Restore a snapshot whose saved startup runtime matches the seat's current runtime.";
}
