// What a host entry's credential POINTER may name.
//
// `hosts.yaml` carries bearer POINTERS only — `bearer_env` (the name of an environment variable) or
// `bearer_file` (a path). The value behind the pointer is sent as `Authorization: Bearer …` to that
// entry's `url` by the read-through middleware and by every other consumer of the same transport.
//
// That makes the pointer a destination decision, not just a lookup: naming this daemon's OWN token
// sends the operator's authority to whatever `url` the entry carries, and naming any other
// credential-shaped variable (a provider key) does the same for that key. The writer has always
// refused secret VALUES (see `SECRET_SHAPED_FIELDS`); this is the same rule for pointers, applied on
// the one seam a caller can reach without an editor: `POST /api/hosts/add`.
//
// Hand-edited `hosts.yaml` is the operator's own trust decision and is not filtered here. The pairing
// flow already writes `$OPENRIG_HOME/secrets/host-<id>.token`, which is exactly the shape this check
// accepts.

import { existsSync, realpathSync } from "node:fs";
import { resolve, isAbsolute, sep } from "node:path";

/**
 * The daemon's own bearer/relay tokens. A host entry may never name one of these as its outbound
 * credential: the credential is meant for the REMOTE daemon, so pointing at a local one turns the
 * entry into a way to hand this machine's authority to a third party.
 */
export const DAEMON_OWN_TOKEN_ENVS: readonly string[] = [
  "OPENRIG_AUTH_BEARER_TOKEN",
  "OPENRIG_TERMINAL_BEARER_TOKEN",
  "OPENRIG_ACTIVITY_HOOK_TOKEN",
  "OPENRIG_RELAY_INBOUND_TOKEN",
  "OPENRIG_RELAY_OUTBOUND_TOKEN",
];

/** An environment variable name as the shell and Node accept it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A credential-shaped name: provider keys and other secrets an operator exports for themselves. The
 * match is deliberately about the NAME, because the daemon cannot know what an arbitrary variable holds.
 */
const CREDENTIAL_SHAPED = /KEY|SECRET|PASSWORD|CREDENTIAL/i;

/** A name the operator chose for a host entry itself. The documented shape for a per-host token. */
export const HOST_OWNED_PREFIX = "OPENRIG_HOST_";

export interface CredentialPointerRefusal {
  code: string;
  message: string;
}

function isInside(parent: string, candidate: string): boolean {
  const caseFold = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const parentFolded = caseFold(parent);
  const candidateFolded = caseFold(candidate);
  if (candidateFolded === parentFolded) return true;
  const withSep = parentFolded.endsWith(sep) ? parentFolded : `${parentFolded}${sep}`;
  return candidateFolded.startsWith(withSep);
}

/** The path with symlinks resolved where it exists; the lexical path when it does not (yet). */
function realOrLexical(value: string): string {
  try {
    return existsSync(value) ? realpathSync(value) : value;
  } catch {
    return value;
  }
}

function envRefusal(name: string): CredentialPointerRefusal | null {
  if (!ENV_NAME.test(name)) {
    return {
      code: "bearer_env_invalid",
      message: `bearer_env '${name}' is not an environment variable name. Use letters, digits and underscores, not starting with a digit (for example OPENRIG_HOST_<ID>_TOKEN). Nothing was written.`,
    };
  }
  const upper = name.toUpperCase();
  const owned = upper.startsWith(HOST_OWNED_PREFIX);
  if (DAEMON_OWN_TOKEN_ENVS.includes(upper)) {
    return {
      code: "bearer_env_names_daemon_secret",
      message: `bearer_env names ${name}, one of this daemon's own tokens. A host entry's credential is the token to send TO the other daemon; naming a local one would hand this machine's authority to whatever url the entry carries. Name the remote daemon's token instead (for example OPENRIG_HOST_<ID>_TOKEN), or point bearer_file at a file under $OPENRIG_HOME. Nothing was written.`,
    };
  }
  if (!owned && CREDENTIAL_SHAPED.test(upper)) {
    return {
      code: "bearer_env_names_credential",
      message: `bearer_env '${name}' names a credential-shaped variable (a provider key or another secret of yours), and its value would be sent to the entry's url as this host entry's bearer token. Name the remote daemon's token instead (for example OPENRIG_HOST_<ID>_TOKEN), or use bearer_file under $OPENRIG_HOME. Nothing was written.`,
    };
  }
  return null;
}

function fileRefusal(file: string, home: string): CredentialPointerRefusal | null {
  // The consumer reads this path with the daemon's working directory as its base, which is not a place
  // OpenRig keeps credentials: an absolute path is the only spelling whose meaning is not ambient.
  if (!isAbsolute(file)) {
    return {
      code: "bearer_file_not_absolute",
      message: `bearer_file '${file}' is not an absolute path. The daemon reads it relative to its own working directory, so a relative pointer names different files in different runs. Name the absolute path of a file under $OPENRIG_HOME. Nothing was written.`,
    };
  }
  const homePath = resolve(home);
  const named = resolve(file);
  if (isInside(homePath, named) && isInside(homePath, realOrLexical(named))) return null;
  return {
    code: "bearer_file_outside_home",
    message: `bearer_file '${file}' is outside $OPENRIG_HOME (${homePath}). A host entry's bearer file is a token this daemon holds for another daemon, so it must live where OpenRig keeps its credentials — the pairing flow writes $OPENRIG_HOME/secrets/host-<id>.token. Nothing was written.`,
  };
}

/**
 * Why this add-body may not become a host entry, or `null` when the pointers are acceptable.
 *
 * Only the two pointer fields are judged here: everything else about an entry is the writer's and the
 * reader's business.
 */
export function credentialPointerRefusal(
  entry: Record<string, unknown>,
  home: string,
): CredentialPointerRefusal | null {
  const env = entry["bearer_env"];
  if (typeof env === "string") {
    const refusal = envRefusal(env.trim());
    if (refusal) return refusal;
  }
  const file = entry["bearer_file"];
  if (typeof file === "string") {
    const refusal = fileRefusal(file.trim(), home);
    if (refusal) return refusal;
  }
  return null;
}