// OPR.0.3.4.7 — Codex profile-v2 preflight: profile-LOAD proof via Codex's
// own loader. A profile that file-exists-but-won't-load (legacy
// [profiles.<name>] table present) MUST FAIL — not just the missing-file case.
// Shared by rigspec-preflight (pre-launch per Codex node) and
// codex-runtime-adapter (pre-restore/launch for stored Codex nodes).

export interface CodexProfileProbeResult {
  ok: boolean;
  profile: string;
  error?: string;
  migrationHint?: string;
}

const PROFILE_PROBE_TIMEOUT_MS = 10_000;

export async function verifyCodexProfileLoads(
  profile: string,
  exec: (cmd: string) => Promise<string>,
  timeoutMs: number = PROFILE_PROBE_TIMEOUT_MS,
): Promise<CodexProfileProbeResult> {
  const cmd = `codex -p ${shellQuote(profile)} mcp list`;
  try {
    await Promise.race([
      exec(cmd),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Codex profile probe timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { ok: true, profile };
  } catch (err) {
    const stderrField = (err as { stderr?: string | Buffer })?.stderr;
    const stderr = stderrField
      ? (typeof stderrField === "string" ? stderrField : stderrField.toString()).trim()
      : (err instanceof Error ? err.message : String(err));
    const isLegacyTable = /legacy.*profiles?\./i.test(stderr) ||
      /cannot be used while.*contains legacy/i.test(stderr) ||
      /failed to load configuration/i.test(stderr);
    const migrationHint = isLegacyTable
      ? `Move the profile settings into ~/.codex/${profile}.config.toml and remove the legacy [profiles.${profile}] table/selector from config.toml.`
      : `Ensure ~/.codex/${profile}.config.toml exists and is valid TOML. Run 'codex -p ${profile} mcp list' manually to diagnose.`;
    return {
      ok: false,
      profile,
      error: `Codex profile '${profile}' failed to load: ${stderr.split("\n")[0] ?? stderr}`,
      migrationHint,
    };
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
