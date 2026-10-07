import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveCodexHome } from "./lib/codex-auth.js";

export interface ProviderAuthDeps {
  exec: (cmd: string) => string;
  readFile: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

/** Issue #194 — how the Codex provider selected in `$CODEX_HOME/config.toml`
 *  authenticates. Only an explicit provider entry with
 *  `requires_openai_auth = false` and an `env_key` uses its credential
 *  variable; every unresolved case keeps the OpenAI login check. Other Codex
 *  config layers are not resolved here. The daemon's kernel probe
 *  (`selectCodexProviderAuth` in kernel-boot.ts) carries the same rule. */
export type CodexProviderAuth =
  | { kind: "openai-login"; unresolved?: string }
  | { kind: "env-key"; providerId: string; envKey: string };

export function selectCodexProviderAuth(configToml: string | null): CodexProviderAuth {
  if (configToml === null) return { kind: "openai-login" };
  let config: Record<string, unknown>;
  try {
    config = parseToml(configToml) as Record<string, unknown>;
  } catch {
    return { kind: "openai-login", unresolved: "config.toml could not be parsed" };
  }
  if (Object.hasOwn(config, "profile")) {
    return { kind: "openai-login", unresolved: "config.toml selects a legacy profile, which is not resolved here" };
  }
  const providerId = config["model_provider"];
  const providers = config["model_providers"];
  if (typeof providerId !== "string" || !providers || typeof providers !== "object" || !Object.hasOwn(providers, providerId)) {
    return { kind: "openai-login" };
  }
  const entry = (providers as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== "object") return { kind: "openai-login" };
  const { requires_openai_auth: requiresOpenAiAuth, env_key: envKey } = entry as Record<string, unknown>;
  if (requiresOpenAiAuth !== false || typeof envKey !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    return { kind: "openai-login" };
  }
  return { kind: "env-key", providerId, envKey };
}

export function checkClaudeAuth(deps: ProviderAuthDeps, installed: boolean): ProviderCheck {
  if (installed) {
    try {
      deps.exec("claude auth status");
      return { name: "claude_auth", status: "pass", message: "Claude Code authentication available." };
    } catch (err) {
      return {
        name: "claude_auth",
        status: "fail",
        message: `Claude Code is installed but not ready to launch: ${(err as Error).message}`,
        reason: "Claude Code seats cannot launch until the Claude CLI is logged in and usable.",
        fix: "Run `claude auth login` or open `claude` once to complete authentication, then rerun `rig setup`.",
      };
    }
  } else {
    return {
      name: "claude_auth",
      status: "skipped",
      message: "Skipped: Claude Code is not installed.",
      reason: "Authentication cannot be checked until the Claude Code CLI is installed.",
    };
  }
}

export function checkCodexAuth(deps: ProviderAuthDeps, installed: boolean): ProviderCheck {
  if (installed) {
    const env = deps.env ?? process.env;
    const codexAuth = selectCodexProviderAuth(deps.readFile(path.join(resolveCodexHome(env).codexHome, "config.toml")));
    if (codexAuth.kind === "env-key") {
      if (env[codexAuth.envKey]?.trim()) {
        return {
          name: "codex_auth",
          status: "pass",
          message: `Codex provider "${codexAuth.providerId}" does not use an OpenAI login, and its credential variable ${codexAuth.envKey} is set. This confirms a local credential is available, not that the provider accepts it or that managed seats receive it.`,
        };
      } else {
        return {
          name: "codex_auth",
          status: "fail",
          message: `Codex provider "${codexAuth.providerId}" needs ${codexAuth.envKey}, which is not set in this environment.`,
          reason: "Codex seats using this provider cannot authenticate without that variable.",
          fix: `Export ${codexAuth.envKey} in the environment that runs rig setup and the OpenRig daemon, then rerun \`rig setup\`.`,
        };
      }
    } else {
      try {
        deps.exec("codex login status");
        return { name: "codex_auth", status: "pass", message: "Codex authentication available." };
      } catch (err) {
        const unresolved = codexAuth.unresolved ? ` (${codexAuth.unresolved}, so the OpenAI login was checked)` : "";
        return {
          name: "codex_auth",
          status: "fail",
          message: `Codex is installed but not ready to launch${unresolved}: ${(err as Error).message}`,
          reason: "Codex seats cannot launch until the Codex CLI is logged in and usable.",
          fix: "Run `codex login` and complete authentication, then rerun `rig setup`.",
        };
      }
    }
  } else {
    return {
      name: "codex_auth",
      status: "skipped",
      message: "Skipped: Codex is not installed.",
      reason: "Authentication cannot be checked until the Codex CLI is installed.",
    };
  }
}

/** Read-only checks: neither installs a CLI nor starts a login or agent session. */
export function checkProviderReadiness(deps: ProviderAuthDeps): ProviderCheck[] {
  const checks: ProviderCheck[] = [];
  for (const [command, label, auth] of [
    ["claude", "Claude Code", checkClaudeAuth],
    ["codex", "Codex", checkCodexAuth],
  ] as const) {
    let installed = false;
    try {
      deps.exec(`${command} --version`);
      installed = true;
      checks.push({ name: `${command}_install`, status: "pass", message: `${label} available.` });
    } catch {
      checks.push({
        name: `${command}_install`, status: "fail", message: `${label} not found.`,
        reason: `${label} authentication cannot be checked until its CLI is installed.`,
        fix: "Run `rig setup` to install the runtime, then rerun `rig doctor`.",
      });
    }
    checks.push(auth(deps, installed));
  }
  return checks;
}
