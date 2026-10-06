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
  codexHome: string = process.env.CODEX_HOME || "~/.codex",
): Promise<CodexProfileProbeResult> {
  const cmd = `codex -p ${shellQuote(profile)} mcp list`;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exec(cmd),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Codex profile probe timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, profile };
  } catch (err) {
    const stderrField = (err as { stderr?: string | Buffer })?.stderr;
    const stderr = stderrField
      ? (typeof stderrField === "string" ? stderrField : stderrField.toString()).trim()
      : (err instanceof Error ? err.message : String(err));
    const isLegacyTable = /legacy.*profiles?\./i.test(stderr) ||
      /cannot be used while.*contains legacy/i.test(stderr) ||
      /\[profiles\./i.test(stderr) ||
      /legacy profile selector/i.test(stderr);
    const stderrLines = stderr.split("\n").filter((l) => l.trim());
    const reason = stderrLines.slice(0, 3).join("; ");
    const migrationHint = isLegacyTable
      ? `Move the profile settings into ${codexHome}/${profile}.config.toml and remove the legacy [profiles.${profile}] table/selector from config.toml.`
      : `Check ${codexHome}/${profile}.config.toml is valid TOML (an absent file is OK — Codex default-layers it). Run 'codex -p ${profile} mcp list' ${codexHome === "~/.codex" ? "manually" : "with the same CODEX_HOME"} to diagnose.`;
    return {
      ok: false,
      profile,
      error: `Codex profile '${profile}' failed to load: ${reason}`,
      migrationHint,
    };
  } finally {
    clearTimeout(deadline);
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
