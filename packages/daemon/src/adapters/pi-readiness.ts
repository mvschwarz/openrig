import path from "node:path";
import { PI_PROVIDER_ENV_VARS, providerFromModel } from "./pi-runner-protocol.js";

// A tested baseline, not an enforced minimum. See docs/releases/v0.5.15.md.
const TESTED_PI_VERSION = "0.87.1";

/** The daemon and pane may resolve different executables. Never turn a
 * version observation into a new launch refusal or echo arbitrary stdout. */
export function piVersionNotice(output: string): string {
  const match = /^(?:pi\s+)?v?(\d{1,6}\.\d{1,6}\.\d{1,6})(?:[-+][\w.-]{1,40})?$/i.exec(output.trim());
  if (!match) return "Pi version unknown: 'pi --version' did not return a recognized version; launch continues. Check 'pi --version' in the pane's shell.";
  const version = match[1]!;
  const parts = version.split(".").map(Number);
  const baseline = TESTED_PI_VERSION.split(".").map(Number);
  const difference = parts.map((part, i) => part - baseline[i]!).find(value => value !== 0) ?? 0;
  return difference < 0
    ? `Pi version ${version} is older than OpenRig's tested baseline ${TESTED_PI_VERSION}; compatibility is unverified and launch continues. Update with 'npm install -g @earendil-works/pi-coding-agent', then check 'command -v pi' in the pane's shell.`
    : `Pi version ${version} answered on the daemon's PATH; this does not verify the pane's executable or provider access. Credentials are checked for the managed seat before Pi starts.`;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Which credential Pi will resolve for a provider in the EXACT managed child environment and agent directory,
 * in Pi's own order: a stored sign-in or key in auth.json, then a models.json provider key, then the provider's
 * environment key. Metadata only: no global login read, credential command, refresh or API request, and never a
 * credential value. Presence is not a successful authentication claim. Pi's own loader remains authoritative
 * (including extension/custom-provider credentials). Shapes: earendil-works/pi v0.87.1 auth-storage.ts and
 * docs/models.md. */
export type PiCredentialSource =
  | { kind: "stored-sign-in" | "stored-key" | "models-key"; provider: string }
  | { kind: "managed-env"; provider: string; envVar: string }
  | { kind: "none"; provider: string; envVar: string | undefined }
  | { kind: "unknown" };

export function piCredentialSource(opts: {
  model?: string;
  agentDir: string;
  env: Readonly<Record<string, string | undefined>>;
  readFile: (file: string) => string;
}): PiCredentialSource {
  const provider = providerFromModel(opts.model);
  if (!provider || !/^[a-z0-9-]{1,64}$/i.test(provider)) return { kind: "unknown" };
  const readObject = (name: string): JsonObject => {
    let text: string;
    try { text = opts.readFile(path.join(opts.agentDir, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw error;
    }
    if (text.length > 1024 * 1024) throw new Error("Unbounded metadata");
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!object(value)) throw new Error("Unknown metadata");
    return value;
  };
  // Literal keys can be observed without evaluating Pi's $ENV/!command
  // language. Those forms are unknown here, never executed or printed.
  const literalKey = (value: unknown): boolean => typeof value === "string"
    && value.trim().length > 0 && !value.startsWith("!") && !value.includes("$");
  try {
    const auth = readObject("auth.json")[provider];
    if (auth !== undefined) {
      if (!object(auth)) return { kind: "unknown" };
      if (auth.type === "oauth" && typeof auth.access === "string" && auth.access.length > 0
        && typeof auth.refresh === "string" && auth.refresh.length > 0 && typeof auth.expires === "number") {
        return { kind: "stored-sign-in", provider };
      }
      if (auth.type === "api_key" && literalKey(auth.key)) return { kind: "stored-key", provider };
      return { kind: "unknown" };
    }
    const models = readObject("models.json");
    if (models.providers !== undefined && !object(models.providers)) return { kind: "unknown" };
    const custom = object(models.providers) ? models.providers[provider] : undefined;
    if (custom !== undefined) {
      if (!object(custom) || !literalKey(custom.apiKey)) return { kind: "unknown" };
      return { kind: "models-key", provider };
    }
    const key = Object.hasOwn(PI_PROVIDER_ENV_VARS, provider) ? PI_PROVIDER_ENV_VARS[provider] : undefined;
    if (key && opts.env[key]?.trim()) return { kind: "managed-env", provider, envVar: key };
    return { kind: "none", provider, envVar: key };
  } catch {
    // Parse/read errors may include secrets. Do not report their message.
    return { kind: "unknown" };
  }
}

/** Advisory launch notice from {@link piCredentialSource}. */
export function piCredentialNotice(opts: {
  model?: string;
  agentDir: string;
  env: Readonly<Record<string, string | undefined>>;
  readFile: (file: string) => string;
}): string {
  const unknown = "Pi credential status unknown; launch continues. The managed seat may use saved model settings, dynamic credentials or a provider extension. Default Pi logins are not automatically shared.";
  const source = piCredentialSource(opts);
  switch (source.kind) {
    case "unknown": return unknown;
    case "stored-sign-in": return `Pi stored sign-in present for ${source.provider}; validity and refresh are unverified. Launch continues.`;
    case "stored-key": return `Pi stored provider key present for ${source.provider}; validity is unverified. Launch continues.`;
    case "models-key": return `Pi model configuration has a provider key for ${source.provider}; validity is unverified. Launch continues.`;
    case "managed-env": return `Pi provider key present in the managed environment for ${source.provider}; validity is unverified. Launch continues.`;
    case "none": {
      const fix = source.envVar
        ? `Set ${source.envVar} in the daemon environment and add its name to recovery.provider_auth_env_allowlist, then restart the daemon and relaunch the seat, or sign in using this seat's PI_CODING_AGENT_DIR.`
        : "Configure this provider in the seat's PI_CODING_AGENT_DIR (auth.json or models.json), or sign in to Pi using that directory.";
      return `No stored sign-in or provider key was found for Pi provider ${source.provider} in this managed seat. ${fix} Pi may resolve another credential source; launch continues. Default Pi logins are not automatically shared.`;
    }
  }
}
