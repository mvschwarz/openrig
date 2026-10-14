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
/** Whether a models.json provider entry can change how Pi authenticates for that provider (Pi 0.87.1
 *  provider-composer.js): a key, OAuth, headers, an auth header, or a base URL (where the key is sent), on the
 *  entry or on any of its custom models or model overrides. An entry that only adds or adjusts models without
 *  these keeps the inherited credential (for OpenRouter, the environment key). */
export function providerEntryAuth(entry: unknown): "none" | "bearing" | "unknown" {
  if (!object(entry)) return "unknown";
  if (["apiKey", "oauth", "headers", "authHeader", "baseUrl"].some((field) => entry[field] !== undefined)) return "bearing";
  const carries = (model: unknown): "none" | "bearing" | "unknown" =>
    !object(model) ? "unknown" : model.baseUrl !== undefined || model.headers !== undefined ? "bearing" : "none";
  const parts: Array<"none" | "bearing" | "unknown"> = [];
  if (entry.models !== undefined) {
    if (!Array.isArray(entry.models)) return "unknown";
    parts.push(...entry.models.map(carries));
  }
  if (entry.modelOverrides !== undefined) {
    if (!object(entry.modelOverrides)) return "unknown";
    parts.push(...Object.values(entry.modelOverrides).map(carries));
  }
  return parts.includes("bearing") ? "bearing" : parts.includes("unknown") ? "unknown" : "none";
}

/** Pi 0.87.1 parses models.json as JSON.parse(stripJsonComments(stripBom(text))) (model-config.js, utils/json.js):
 *  `//` line comments outside strings and trailing commas are removed. The same here, so a file Pi reads is read. */
export function parsePiModelsJson(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail: string | undefined) => tail ?? (m[0] === '"' ? m : ""));
  return JSON.parse(stripped);
}

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
    const value: unknown = name === "models.json" ? parsePiModelsJson(text) : JSON.parse(text.replace(/^\uFEFF/, ""));
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
    // An entry that can't change authentication keeps the inherited credential: fall through to it.
    if (custom !== undefined && providerEntryAuth(custom) !== "none") {
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

/** OPR.0.7.0.2 K4: what metadata shows about Pi's OpenRouter credential at one moment. Pi records no
 *  per-request credential, so a request's credential is established by two of these, taken before and after
 *  it (see judgeChargeProvenance). Metadata only: credential files are classified, never used; settings are
 *  read only for extension entries; extension directories are listed, never loaded. */
export type PiCredentialEvidence = {
  at: number;
  source: PiCredentialSource;
  /** Whether a Pi extension could load (and so register a provider or a runtime key): Pi 0.87.1 discovers
   *  <agentDir>/extensions, <cwd>/.pi/extensions, and `packages`/`extensions` entries in either settings.json.
   *  OpenRig passes no -e flags. */
  extensions: "none" | "present" | "unknown";
  /** Whether models.json has an OpenRouter provider entry that can change authentication (providerEntryAuth),
   *  whichever credential wins and whether or not its key is literal: Pi's provider composer holds it from load
   *  until a reload. A credential-free entry (models only) is "none". */
  modelsOpenRouterEntry: "none" | "present" | "unknown";
  /** Identity of every file and directory above, so a change between two observations is visible. */
  fingerprint: string;
};

export function piCredentialEvidence(opts: {
  agentDir: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  /** "absent", or a stable identity for a file (e.g. ino:size:mtime). */
  statId: (file: string) => string;
  /** Entry names of a directory; [] when it doesn't exist. Throws when it can't be read. */
  listDir: (dir: string) => string[];
  readFile: (file: string) => string;
}): PiCredentialEvidence {
  const at = opts.now();
  const files = ["auth.json", "models.json", "settings.json"].map((name) => path.join(opts.agentDir, name))
    .concat(path.join(opts.cwd, ".pi", "settings.json"));
  const dirs = [path.join(opts.agentDir, "extensions"), path.join(opts.cwd, ".pi", "extensions")];
  let extensions: PiCredentialEvidence["extensions"] = "none";
  let modelsOpenRouterEntry: PiCredentialEvidence["modelsOpenRouterEntry"] = "none";
  try {
    const text = opts.readFile(path.join(opts.agentDir, "models.json"));
    if (text.length > 1024 * 1024) throw new Error("Unbounded metadata");
    const models: unknown = parsePiModelsJson(text);
    if (!object(models)) throw new Error("Unknown metadata");
    if (models.providers !== undefined) {
      if (!object(models.providers)) throw new Error("Unknown metadata");
      if (Object.hasOwn(models.providers, "openrouter")) {
        const auth = providerEntryAuth(models.providers["openrouter"]);
        modelsOpenRouterEntry = auth === "bearing" ? "present" : auth === "unknown" ? "unknown" : "none";
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") modelsOpenRouterEntry = "unknown";
  }
  const parts: string[] = [];
  try {
    for (const file of files) parts.push(`${file}=${opts.statId(file)}`);
    for (const dir of dirs) {
      const names = opts.listDir(dir).sort();
      parts.push(`${dir}/=${names.join("|")}`);
      if (names.length > 0) extensions = "present";
    }
    for (const file of files.slice(2)) {
      let text: string;
      try { text = opts.readFile(file); } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw error;
      }
      if (text.length > 1024 * 1024) throw new Error("Unbounded metadata");
      const settings: unknown = JSON.parse(text.replace(/^﻿/, ""));
      if (!object(settings)) throw new Error("Unknown metadata");
      for (const key of ["packages", "extensions"]) {
        const value = settings[key];
        if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
        extensions = "present";
      }
    }
  } catch {
    extensions = "unknown";
  }
  return {
    at,
    source: piCredentialSource({ model: "openrouter/charge-lookup", agentDir: opts.agentDir, env: opts.env, readFile: opts.readFile }),
    extensions,
    modelsOpenRouterEntry,
    fingerprint: parts.join("\n"),
  };
}

/** What, seen in any observation of this runner process, Pi may still hold until it restarts: an extension
 *  (Pi 0.87.1 loads extensions at start and again only on an explicit /reload) or a models.json OpenRouter key
 *  (Pi loads models.json at start and again only on an explicit refresh). Clean files later don't change what
 *  the running Pi loaded, so once seen, this is sticky for the process. */
export function credentialTaint(e: PiCredentialEvidence): { sticky: string } | null {
  const when = new Date(e.at).toISOString();
  const kept = "and Pi keeps what it loaded until it restarts or reloads";
  if (e.extensions === "present") return { sticky: `a Pi extension was configured when observed at ${when}, ${kept}` };
  if (e.modelsOpenRouterEntry === "present" || e.source.kind === "models-key") {
    return { sticky: `models.json had a credential-bearing OpenRouter provider entry when observed at ${when}, ${kept}` };
  }
  // Unreadable is sticky too: one failed read can't establish what the running Pi loaded, and later clean reads
  // don't say what it holds. Only a new runner process (and so a new Pi) starts clear.
  if (e.extensions === "unknown") return { sticky: `Pi's extension configuration couldn't be checked when observed at ${when}, ${kept}` };
  if (e.modelsOpenRouterEntry === "unknown") return { sticky: `models.json couldn't be checked for an OpenRouter entry when observed at ${when}, ${kept}` };
  if (e.source.kind === "unknown") return { sticky: `Pi's OpenRouter credential source couldn't be classified when observed at ${when}, ${kept}` };
  return null;
}

/** Whether a request's credential is established as the key OpenRig forwarded: it was persisted after `before`
 *  and observed by `after`, both show Pi's OpenRouter credential as that key with no extension able to replace
 *  it, and nothing changed in between. Otherwise the reason it isn't. */
export function judgeChargeProvenance(before: PiCredentialEvidence | null, after: PiCredentialEvidence, entryTimestamp: string):
  { ok: true; credentialSource: string } | { ok: false; reason: string } {
  const t = Date.parse(entryTimestamp);
  if (!before || Number.isNaN(t) || t <= before.at) {
    return { ok: false, reason: "made before this runner observed Pi's credential; the credential it used is unknown" };
  }
  for (const e of [before, after]) {
    if (e.source.kind !== "managed-env" || e.source.provider !== "openrouter") {
      return { ok: false, reason: `Pi's OpenRouter credential around the request was ${e.source.kind}, not the key OpenRig forwarded` };
    }
    if (e.extensions !== "none") {
      return { ok: false, reason: e.extensions === "present"
        ? "a Pi extension is configured and could have supplied the credential"
        : "Pi's extension configuration couldn't be checked" };
    }
    if (e.modelsOpenRouterEntry !== "none") {
      return { ok: false, reason: e.modelsOpenRouterEntry === "present"
        ? "models.json has a credential-bearing OpenRouter entry"
        : "models.json couldn't be checked for an OpenRouter entry" };
    }
  }
  if (before.fingerprint !== after.fingerprint) return { ok: false, reason: "Pi's credential or extension files changed around the request" };
  const envVar = before.source.kind === "managed-env" ? before.source.envVar : "OPENROUTER_API_KEY";
  return { ok: true, credentialSource: `${envVar} (forwarded by OpenRig; Pi's credential observed before and after the request)` };
}
