import { SettingsStore } from "./user-settings/settings-store.js";

const DEFAULT_READINESS_TIMEOUT_SECONDS = 30;

/** Resolve at launch time so a config change applies to the next seat, while
 * preserving explicit millisecond overrides used by callers and tests. A
 * settings read that throws (e.g. config.json edited into invalid JSON while
 * the daemon runs) costs a warning and the 30-second default, never a launch. */
export function resolveReadinessTimeoutMs(
  explicitMs: number | undefined,
  settings: Pick<SettingsStore, "resolveOne"> = new SettingsStore(),
): number {
  if (explicitMs !== undefined) return explicitMs;
  try {
    return (settings.resolveOne("runtime.readiness_timeout_seconds").value as number) * 1000;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[openrig-settings] read of runtime.readiness_timeout_seconds failed: ${reason}; falling back to ${DEFAULT_READINESS_TIMEOUT_SECONDS}s default\n`,
    );
    return DEFAULT_READINESS_TIMEOUT_SECONDS * 1000;
  }
}
