// Controlled stub invocation of the shipped hook. This does not model native hook scheduling or agent reading.
import { spawnSync } from "node:child_process";
export interface StubRefocusResult { rawOutput: string; additionalContext: string }
export function fireRefocus(hookPath: string, cwd: string, env: NodeJS.ProcessEnv, sessionId: string): StubRefocusResult {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd, env: { ...env, OPENRIG_REFOCUS_NOW: "1" }, encoding: "utf8", timeout: 60_000,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Refocus now", session_id: sessionId, cwd }), maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`stub refocus failed: ${result.error?.message ?? result.stderr}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`stub refocus emitted no/invalid JSON: ${result.stderr}`); }
  const context: unknown = parsed?.hookSpecificOutput?.additionalContext;
  if (typeof context !== "string" || !context) throw new Error("stub refocus hook emitted no additionalContext");
  return { rawOutput: result.stdout, additionalContext: context };
}
