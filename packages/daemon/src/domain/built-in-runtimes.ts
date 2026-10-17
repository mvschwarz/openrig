/** The runtimes OpenRig ships. Any other runtime name names a community agent app (`agent-app-presets.ts`), and a
 *  preset can't take one of these names. */
export const BUILT_IN_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "pi", "omp", "terminal", "stub"]);

/** A runtime name that isn't built in names a community agent app. */
export function isAgentAppRuntime(runtime: string | null | undefined): runtime is string {
  return !!runtime && !BUILT_IN_RUNTIMES.has(runtime);
}
