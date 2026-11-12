import { isAbsolute, resolve as resolvePath } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";
import { constantTimeEqual } from "../../middleware/auth-bearer-token.js";
import {
  loadHumanRegistry,
  registeredPeople,
  type HumanFragment,
} from "./human-registry.js";
import {
  nodeSecretFs,
  parseEnvFile,
  type SecretFsOps,
} from "./slack/secrets.js";

export type RelayMode = "push" | "pull";

export const RELAY_ENV_KEYS = {
  mode: "OPENRIG_RELAY_MODE",
  url: "OPENRIG_RELAY_URL",
  outboundToken: "OPENRIG_RELAY_OUTBOUND_TOKEN",
  inboundToken: "OPENRIG_RELAY_INBOUND_TOKEN",
} as const;

export interface RelayCredentials {
  readonly url: string | null;
  readonly outboundToken: string | null;
  readonly inboundToken: string;
}

export interface RelayProfileReadiness {
  readonly connectorRef: string;
  readonly mode: RelayMode;
  readonly state: "ready" | "not-ready";
  readonly configured: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly nextAction: string | null;
  readonly warnings: readonly string[];
}

export interface RelayBoundHuman {
  readonly entityId: string;
  readonly address: string;
  readonly role: "primary" | "secondary";
  readonly secretsRef: string;
  readonly handle?: string;
}

export interface RelayProfile extends RelayProfileReadiness {
  readonly secretsRef: string | null;
  readonly envFile: string | null;
  readonly endpointUrl: string | null;
  readonly readiness: RelayProfileReadiness;
  readonly humans: readonly RelayBoundHuman[];
  /** Private credentials for outbound/inbound transport; null when not ready; non-enumerable and never serialized. */
  readonly credentials: RelayCredentials | null;
}

export interface LoadRelayProfilesOptions {
  readonly entities?: readonly HumanFragment[];
  readonly fsops?: SecretFsOps;
}

export interface LoadRelayProfilesResult {
  readonly ok: boolean;
  readonly registryError: string | null;
  readonly profiles: ReadonlyMap<string, RelayProfile>;
  get(connectorRef: string): RelayProfile | undefined;
}

/** Parse a relay binding's `secretsRef` (`file:<absolute-env-file>`).
 *  Rejects bare paths, relative paths, empty pointers, and `file://` authority URLs. */
export function parseRelaySecretsRef(
  secretsRef: string,
): { ok: true; envFile: string } | { ok: false; reason: string } {
  const trimmed = secretsRef.trim();
  if (!trimmed.startsWith("file:") || trimmed.includes("\0")) {
    return { ok: false, reason: "relay secretsRef must use file:<absolute-path> syntax" };
  }
  const rawPath = trimmed.slice("file:".length);
  if (!rawPath || rawPath.startsWith("//") || !isAbsolute(rawPath)) {
    return { ok: false, reason: "relay secretsRef must point to an absolute file path" };
  }
  return { ok: true, envFile: resolvePath(rawPath) };
}

const IPV4_LOOPBACK_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function extractRawAuthorityHost(rawUrl: string): string | null {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl);
  if (!match) return null;
  const authority = match[1]!;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end === -1 ? null : authority.slice(1, end).toLowerCase();
  }
  const colon = authority.indexOf(":");
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

function isStrictLoopbackHost(hostname: string, rawHost: string): boolean {
  const norm = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (norm === "localhost" && rawHost === "localhost") return true;
  if ((norm === "::1" || norm === "0:0:0:0:0:0:0:1") && (rawHost === "::1" || rawHost === "0:0:0:0:0:0:0:1")) {
    return true;
  }
  return IPV4_LOOPBACK_RE.test(norm) && IPV4_LOOPBACK_RE.test(rawHost);
}

/** Validate `OPENRIG_RELAY_URL`: must be `http:`, loopback host (`127.x.y.z`, `::1`, or `localhost`),
 *  with no embedded credentials and no fragment. Never echoes raw URL or credentials in reasons. */
export function validateRelayUrl(
  rawUrl: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, reason: "OPENRIG_RELAY_URL is empty or malformed" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "OPENRIG_RELAY_URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:") {
    return { ok: false, reason: "OPENRIG_RELAY_URL must use http: scheme" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "OPENRIG_RELAY_URL must not contain embedded credentials" };
  }
  if (parsed.hash !== "") {
    return { ok: false, reason: "OPENRIG_RELAY_URL must not contain a URL fragment" };
  }
  const rawHost = extractRawAuthorityHost(trimmed);
  if (!rawHost || !isStrictLoopbackHost(parsed.hostname, rawHost)) {
    return {
      ok: false,
      reason: "OPENRIG_RELAY_URL host must be loopback (numeric 127.0.0.1/8, ::1, or localhost)",
    };
  }
  return { ok: true, url: parsed.toString() };
}

function createPrivateCredentials(
  url: string | null,
  outboundToken: string | null,
  inboundToken: string,
): RelayCredentials {
  const creds = { url, outboundToken, inboundToken };
  Object.defineProperty(creds, "toJSON", { value: () => "[REDACTED]", enumerable: false });
  Object.defineProperty(creds, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => "[RelayCredentials REDACTED]",
    enumerable: false,
  });
  return Object.freeze(creds);
}

/** Check permissions on a relay secret file. Like Slack secret file checks, unsafe group/other
 *  permission bits (`(mode & 0o077) !== 0`) produce a warning rather than making the profile unready.
 *  Owner-only modes such as `0600` or `0400` produce no warning (`null`). */
function checkRelaySecretFilePermissions(
  envFile: string,
  fsops: SecretFsOps,
  connectorRef: string,
): string | null {
  const mode = fsops.statMode(envFile);
  if (mode === null) return null;
  if ((mode & 0o077) !== 0) {
    return `relay secret file for '${connectorRef}' has insecure permissions (mode 0${mode.toString(8).padStart(3, "0")}; group/other access bits are set — restrict so group/other have no access, e.g. 0600 or 0400)`;
  }
  return null;
}

interface CandidateProfile {
  connectorRef: string;
  mode: RelayMode;
  secretsRef: string | null;
  envFile: string | null;
  endpointUrl: string | null;
  humans: RelayBoundHuman[];
  nextAction: string | null;
  warnings: string[];
  unreadyReason?: string;
  url?: string | null;
  outboundToken?: string | null;
  inboundToken?: string;
}

function evaluateRelayCandidate(
  connectorRef: string,
  humans: RelayBoundHuman[],
  fsops: SecretFsOps,
): CandidateProfile {
  const firstHuman = humans[0]!;
  const defaultNextAction = `rig gateway human show ${firstHuman.entityId} --json`;
  const warnings: string[] = [];
  const fail = (
    unreadyReason: string,
    secretsRef: string | null = firstHuman.secretsRef,
    envFile: string | null = null,
    nextAction: string = defaultNextAction,
    relayMode: RelayMode = "push",
  ): CandidateProfile => ({
    connectorRef,
    mode: relayMode,
    secretsRef,
    envFile,
    endpointUrl: null,
    humans,
    nextAction,
    warnings,
    unreadyReason,
  });

  const envFiles = new Set<string>();
  for (const h of humans) {
    const parsed = parseRelaySecretsRef(h.secretsRef);
    if (!parsed.ok) {
      return fail(
        `relay profile '${connectorRef}' has invalid secretsRef: ${parsed.reason}`,
        h.secretsRef,
        null,
        `rig gateway human show ${h.entityId} --json`,
      );
    }
    envFiles.add(parsed.envFile);
  }
  if (envFiles.size > 1) {
    return fail(
      `relay profile '${connectorRef}' has inconsistent provisioning across human bindings (conflicting secretsRef file paths)`,
      null,
      null,
      "rig gateway human list --json",
    );
  }

  const [envFile] = envFiles as Set<string> & [string];
  const secretsRef = firstHuman.secretsRef;
  const mode = fsops.statMode(envFile!);
  if (mode === null) {
    return fail(`relay secret file for '${connectorRef}' is missing or unreadable`, secretsRef, envFile!);
  }
  const permWarning = checkRelaySecretFilePermissions(envFile!, fsops, connectorRef);
  if (permWarning) {
    warnings.push(permWarning);
  }

  let rawText: string;
  try {
    rawText = fsops.readFileSync(envFile!);
  } catch {
    return fail(`relay secret file for '${connectorRef}' is missing or unreadable`, secretsRef, envFile!);
  }

  const parsedEnv = parseEnvFile(rawText);
  const rawMode = (parsedEnv[RELAY_ENV_KEYS.mode] ?? "").trim();
  if (rawMode !== "" && rawMode !== "push" && rawMode !== "pull") {
    return fail(
      `relay profile '${connectorRef}' has invalid ${RELAY_ENV_KEYS.mode} (must be 'push' or 'pull')`,
      secretsRef,
      envFile!,
    );
  }
  const relayMode: RelayMode = rawMode === "pull" ? "pull" : "push";

  const rawUrl = (parsedEnv[RELAY_ENV_KEYS.url] ?? "").trim();
  const outboundToken = (parsedEnv[RELAY_ENV_KEYS.outboundToken] ?? "").trim();
  const inboundToken = (parsedEnv[RELAY_ENV_KEYS.inboundToken] ?? "").trim();

  if (relayMode === "pull") {
    if (!inboundToken || /[\r\n\0]/.test(inboundToken)) {
      return fail(
        `relay profile '${connectorRef}' is missing ${RELAY_ENV_KEYS.inboundToken}`,
        secretsRef,
        envFile!,
        defaultNextAction,
        "pull",
      );
    }
    return {
      connectorRef,
      mode: "pull",
      secretsRef,
      envFile: envFile!,
      endpointUrl: null,
      humans,
      nextAction: defaultNextAction,
      warnings,
      url: null,
      outboundToken: null,
      inboundToken,
    };
  }

  if (!rawUrl) {
    return fail(`relay profile '${connectorRef}' is missing ${RELAY_ENV_KEYS.url}`, secretsRef, envFile!);
  }
  if (!outboundToken || /[\r\n\0]/.test(outboundToken)) {
    return fail(`relay profile '${connectorRef}' is missing ${RELAY_ENV_KEYS.outboundToken}`, secretsRef, envFile!);
  }
  if (!inboundToken || /[\r\n\0]/.test(inboundToken)) {
    return fail(`relay profile '${connectorRef}' is missing ${RELAY_ENV_KEYS.inboundToken}`, secretsRef, envFile!);
  }
  if (constantTimeEqual(outboundToken, inboundToken)) {
    warnings.push(
      `relay profile '${connectorRef}' uses the same token for ${RELAY_ENV_KEYS.outboundToken} and ${RELAY_ENV_KEYS.inboundToken}; separate tokens are recommended so outbound bridge capture cannot authenticate inbound replies`,
    );
  }

  const urlVerdict = validateRelayUrl(rawUrl);
  if (!urlVerdict.ok) {
    return fail(
      `relay profile '${connectorRef}' has invalid ${RELAY_ENV_KEYS.url}: ${urlVerdict.reason}`,
      secretsRef,
      envFile!,
    );
  }

  return {
    connectorRef,
    mode: "push",
    secretsRef,
    envFile: envFile!,
    endpointUrl: urlVerdict.url,
    humans,
    nextAction: defaultNextAction,
    warnings,
    url: urlVerdict.url,
    outboundToken,
    inboundToken,
  };
}

function buildRelayProfile(c: CandidateProfile): RelayProfile {
  const ready = !c.unreadyReason;
  const frozenWarnings = Object.freeze([...c.warnings]);
  const baseVerifiedReason =
    c.mode === "pull"
      ? "relay profile verified (pull outbox mode and inbound token configured)"
      : "relay profile verified (loopback HTTP endpoint and directional tokens configured)";
  const readyReason =
    frozenWarnings.length > 0
      ? `${baseVerifiedReason}; warning: ${frozenWarnings.join("; ")}`
      : baseVerifiedReason;
  const readiness: RelayProfileReadiness = Object.freeze({
    connectorRef: c.connectorRef,
    mode: c.mode,
    state: ready ? "ready" : "not-ready",
    configured: ready,
    ready,
    reason: c.unreadyReason ?? readyReason,
    nextAction: ready ? null : c.nextAction,
    warnings: frozenWarnings,
  });
  const credentials = ready
    ? createPrivateCredentials(c.url ?? null, c.outboundToken ?? null, c.inboundToken!)
    : null;
  const profile = {
    ...readiness,
    secretsRef: c.secretsRef,
    envFile: c.envFile,
    endpointUrl: c.endpointUrl,
    readiness,
    humans: Object.freeze([...c.humans]),
  } as unknown as RelayProfile;

  Object.defineProperty(profile, "credentials", {
    value: credentials,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(profile);
}

/** Load and validate all relay profiles referenced by registered humans' `kind: "relay"` bindings.
 *  Performs zero network I/O and never reads from `process.env`. */
export function loadRelayProfiles(
  home: string = getOpenRigHome(),
  opts: LoadRelayProfilesOptions = {},
): LoadRelayProfilesResult {
  const fsops = opts.fsops ?? nodeSecretFs;
  let entities: readonly HumanFragment[] = [];
  let registryError: string | null = null;
  let ok = true;

  if (opts.entities !== undefined) {
    entities = opts.entities;
  } else {
    const loaded = loadHumanRegistry(home, { readOnly: true });
    const people = registeredPeople(loaded);
    if (people === null) {
      ok = false;
      registryError = loaded.ok ? null : loaded.error;
    } else {
      entities = people;
    }
  }

  const grouped = new Map<string, RelayBoundHuman[]>();
  for (const entity of entities) {
    for (const binding of entity.connectorBindings) {
      if (binding.kind !== "relay") continue;
      const list = grouped.get(binding.connectorRef) ?? [];
      list.push({
        entityId: entity.entityId,
        address: entity.address,
        role: binding.role,
        secretsRef: binding.secretsRef,
        ...(binding.handle !== undefined ? { handle: binding.handle } : {}),
      });
      grouped.set(binding.connectorRef, list);
    }
  }

  const candidates = [...grouped.keys()]
    .sort()
    .map((connectorRef) => evaluateRelayCandidate(connectorRef, grouped.get(connectorRef)!, fsops));

  const validCandidates = candidates.filter((c) => !c.unreadyReason && c.inboundToken !== undefined);
  for (const current of validCandidates) {
    const collidingRefs = validCandidates
      .filter((other) => other.connectorRef !== current.connectorRef && constantTimeEqual(current.inboundToken!, other.inboundToken!))
      .map((other) => other.connectorRef);
    if (collidingRefs.length > 0) {
      current.unreadyReason =
        `relay profile '${current.connectorRef}' reuses an ambiguous ${RELAY_ENV_KEYS.inboundToken} shared with relay profile(s): ${collidingRefs.join(", ")}`;
    }
  }

  const profiles = new Map<string, RelayProfile>();
  for (const c of candidates) {
    profiles.set(c.connectorRef, buildRelayProfile(c));
  }

  return Object.freeze({
    ok,
    registryError,
    profiles,
    get(connectorRef: string): RelayProfile | undefined {
      return profiles.get(connectorRef);
    },
  });
}

export type RelayInboundAuthResult =
  | { ok: true; connectorRef: string; profile: RelayProfile }
  | { ok: false; reason: string };

/** Derive authenticated relay identity from a bearer token by comparing against all ready
 *  profiles' `inboundToken` using `constantTimeEqual` without short-circuiting. */
export function authenticateRelayInboundToken(
  loaded: LoadRelayProfilesResult,
  bearerToken: string | null | undefined,
): RelayInboundAuthResult {
  if (typeof bearerToken !== "string" || bearerToken.length === 0) {
    return { ok: false, reason: "missing relay bearer token" };
  }
  const matches: RelayProfile[] = [];
  for (const profile of loaded.profiles.values()) {
    if (profile.ready && profile.credentials && constantTimeEqual(bearerToken, profile.credentials.inboundToken)) {
      matches.push(profile);
    }
  }
  if (matches.length === 1) {
    return { ok: true, connectorRef: matches[0]!.connectorRef, profile: matches[0]! };
  }
  return {
    ok: false,
    reason: matches.length > 1 ? "ambiguous relay bearer token across profiles" : "invalid relay bearer token",
  };
}
