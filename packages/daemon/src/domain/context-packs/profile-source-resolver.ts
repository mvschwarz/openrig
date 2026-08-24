// OPR.0.5.3.5 Atom 4a — the two pre-`#` resolvers behind ONE grammar.
//
// Q2-Amendment 1 (locked), the desk's grammar ruling verbatim: non-library sources
// are addressable with the SAME `#H2-slug/H3-slug` grammar; only the pre-`#`
// resolver differs — a library ref resolves through the library (here: the pack's
// own directory), a tree path resolves from CONFIGURED roots — and both resolve
// FAIL-LOUD. One grammar held in memory, two resolvers behind it, no second
// addressing convention. The kind prefix is the entire pre-`#` dialect:
//
//   walk.md#welcome              -> library (the pack's declared files)
//   seat:RECAP.md#decisions      -> the seat tree (recap + lore live beside LEARNED)
//   mission:NOTES.md#watch-items -> the mission tree
//
// Roots arrive from CONFIG through the caller (CE-v2 03-tree-addressability: an
// addressing verb resolves tree paths from config, never literals — this module
// holds no path literal and refuses to guess a missing root). Composability comes
// from ADDRESSING, not homing: nothing must be copied into the library to compose
// (a profile that copies seat or mission content into the library is a defect —
// Q2-Amendment 1(c)).

import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { SourceKind } from "./profile-composer.js";
import { parseAddress } from "../markdown-address.js";

export class SourceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceResolutionError";
  }
}

const TREE_KINDS = ["seat", "mission"] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

export interface ParsedSourceRef {
  kind: SourceKind;
  /** Relative path under the pack dir (library) or the kind's configured root. */
  rel: string;
}

/** Split a pre-`#` ref into its resolver kind + relative path. Fail-loud on an
 *  unknown prefix or a traversal-shaped path — a clean refusal, never an escape
 *  (the r2-B3 precedent from the trace verb). */
export function parseSourceRef(ref: string): ParsedSourceRef {
  const colon = ref.indexOf(":");
  let kind: SourceKind = "library";
  let rel = ref;
  if (colon >= 0) {
    const prefix = ref.slice(0, colon);
    if (!(TREE_KINDS as readonly string[]).includes(prefix)) {
      throw new SourceResolutionError(
        `source ref '${ref}' has unknown kind prefix '${prefix}' — the pre-'#' dialect is bare (library), ${TREE_KINDS.map((k) => `'${k}:'`).join(" or ")}.`,
      );
    }
    kind = prefix as TreeKind;
    rel = ref.slice(colon + 1);
  }
  if (rel.length === 0) {
    throw new SourceResolutionError(`source ref '${ref}' has an empty path after its kind prefix.`);
  }
  const unsafe =
    isAbsolute(rel) ||
    rel.split(/[\\/]/).some((segment) => segment === ".." || segment === "");
  if (unsafe) {
    throw new SourceResolutionError(
      `source ref '${ref}' is traversal-shaped (absolute path, '..' or empty segment) — refs stay inside their source root.`,
    );
  }
  return { kind, rel };
}

export interface ProfileSourceRoots {
  /** The seat's tree directory (recap + lore beside LEARNED) — from config. */
  seat?: string;
  /** The mission's tree directory — from config. */
  mission?: string;
}

/** Build the composer's fail-loud readFile over the pack dir + configured tree
 *  roots. Every failure names the source kind and what was being resolved —
 *  a missing root is a MISSING CONFIG error, never a silent empty. */
export function makeProfileReadFile(opts: { packDir: string; roots: ProfileSourceRoots }): (ref: string) => string {
  return (ref: string): string => {
    const { kind, rel } = parseSourceRef(ref);
    let base: string;
    if (kind === "library") {
      base = opts.packDir;
    } else {
      const configured = opts.roots[kind];
      if (!configured) {
        throw new SourceResolutionError(
          `source ref '${ref}' needs the ${kind} tree root, which is not configured for this compose — ` +
            `tree paths resolve from config, never literals; supply the ${kind} root or drop the ${kind}-homed atom.`,
        );
      }
      base = configured;
    }
    const abs = normalize(join(base, rel));
    try {
      return readFileSync(abs, "utf-8");
    } catch (err) {
      throw new SourceResolutionError(
        `source ref '${ref}' (${kind}) did not resolve: ${abs} is unreadable — ${(err as Error).message}`,
      );
    }
  };
}

/** The composer's per-piece source label (Q2-Amendment 1: every assembled piece
 *  is labeled with its source), derived from the atom's full address. */
export function sourceKindForAddress(address: string): SourceKind {
  return parseSourceRef(parseAddress(address).ref).kind;
}
