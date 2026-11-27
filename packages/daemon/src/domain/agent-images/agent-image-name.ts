// What an agent image may be called.
//
// An image name becomes a DIRECTORY NAME: `install()` joins it to the library root and creates it
// (`join(targetRootPath, manifest.name)`). The captured file paths beside it are already checked for
// `..` and for a leading `/`; the directory name was not, so a name like `../../x` chose where the
// daemon created a directory of daemon-authored files.
//
// A name is one path segment, and nothing else: no separator, no `.`/`..`, no drive or stream colon,
// no control character. Anything an operator would type as a name still passes.

import { basename } from "node:path";

/** Long enough for a descriptive name; short enough to stay one filesystem entry everywhere. */
const MAX_NAME_LENGTH = 200;
/** C0/C1 controls, DEL: a name is displayed and typed, never interpreted. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Why this image name may not become a directory name, or `null` when it may.
 *
 * Returned rather than thrown so both the writer (which turns it into an `AgentImageError`) and any
 * caller that wants to refuse earlier can share one rule.
 */
export function agentImageNameRefusal(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return "an agent image needs a name (one path segment, for example 'reviewer-baseline')";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `agent image name is ${name.length} characters; the limit is ${MAX_NAME_LENGTH}`;
  }
  if (name === "." || name === "..") {
    return `agent image name '${name}' would resolve to a directory, not name one`;
  }
  if (name.includes("/") || name.includes("\\")) {
    return `agent image name '${name}' contains a path separator; a name is one segment, and the library decides the directory`;
  }
  if (name.includes(":")) {
    return `agent image name '${name}' contains ':'; on Windows that selects a drive or an alternate stream rather than naming a directory`;
  }
  if (CONTROL.test(name)) {
    return "agent image name contains a control character";
  }
  if (basename(name) !== name) {
    return `agent image name '${name}' is not a single path segment`;
  }
  return null;
}