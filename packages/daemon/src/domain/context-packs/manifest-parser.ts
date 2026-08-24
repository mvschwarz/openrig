// Rig Context / Composable Context Injection v0 (PL-014) — manifest
// parser.
//
// Parses ~/.openrig/context-packs/<name>/manifest.yaml into a typed
// shape with structured-error rejects on malformed input. Pure
// (no fs touches in the parser itself; caller hands in raw YAML).

import { parse as parseYaml } from "yaml";
import {
  ATOM_PRIORITIES,
  ATOM_PURPOSES,
  ATOM_REGIONS,
  ATOM_RUNTIMES,
  ATOM_SITUATIONS,
  ATOM_TAXONOMIES,
  ContextPackError,
  type ContextPackAtom,
  type ContextPackManifest,
  type ContextPackManifestFile,
} from "./context-pack-types.js";
import { isSafePackVersion } from "./ref-safety.js";
import { AddressResolutionError, parseAddress } from "../markdown-address.js";

// Served as UTF-8 bundle text. `.sh`/`.ts` (OPR.0.5.3.7 R2) carry canonical skill
// helper assets the served prose references (e.g. find-polluter.sh,
// condition-based-waiting-example.ts) — text content, never executed. An unlisted
// suffix still rejects loud, so a genuinely new pack file type fails at ingest
// rather than serving a silently-incomplete bundle.
const ALLOWED_FILE_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts"];

export function parseManifest(rawYaml: string, sourcePath: string): ContextPackManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new ContextPackError(
      "manifest_parse_error",
      `manifest at ${sourcePath} is not valid YAML: ${(err as Error).message}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} must be a YAML object at the root`,
      { sourcePath },
    );
  }
  const obj = parsed as Record<string, unknown>;

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'name' (string)`,
      { sourcePath },
    );
  }

  // Version may be a number or string in YAML; normalize to string for
  // round-tripping with library ids and `<name>:<version>` formatting.
  const versionRaw = obj["version"];
  if (versionRaw === undefined || versionRaw === null) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'version'`,
      { sourcePath },
    );
  }
  const version = String(versionRaw);
  // Slice-03 lineage repair (R2 HIGH-2): enforce the bounded, delimiter-free
  // version predicate at the ingestion chokepoint — a colon-bearing version
  // forges a `<name>:<version>` store id and an overlong one breaches the OS
  // filename bound. Rejecting here covers every scan/install path that flows
  // through the parser.
  if (!isSafePackVersion(version)) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} has an invalid version '${version}' — a version must be a single bounded token ` +
        `[A-Za-z0-9][A-Za-z0-9._+-]{0,31} (no ':' or other separator, no whitespace, ≤32 chars) so it cannot ` +
        `forge a '<name>:<version>' store id or breach the OS filename bound.`,
      { sourcePath },
    );
  }

  const purpose = typeof obj["purpose"] === "string" ? (obj["purpose"] as string) : undefined;

  const filesRaw = obj["files"];
  if (!Array.isArray(filesRaw)) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} must declare 'files: [...]' (got: ${typeof filesRaw})`,
      { sourcePath },
    );
  }
  const files: ContextPackManifestFile[] = [];
  for (let i = 0; i < filesRaw.length; i++) {
    const f = filesRaw[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} has malformed entry at files[${i}] (must be an object with 'path' + 'role')`,
        { sourcePath, index: i },
      );
    }
    const fr = f as Record<string, unknown>;
    const path = fr["path"];
    if (typeof path !== "string" || path.length === 0) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}] missing 'path' (string)`,
        { sourcePath, index: i },
      );
    }
    if (path.includes("..") || path.startsWith("/")) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}].path '${path}' must be a relative path inside the pack (no '..' segments, no leading '/')`,
        { sourcePath, index: i, path },
      );
    }
    const role = fr["role"];
    if (typeof role !== "string" || role.length === 0) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}] missing 'role' (string)`,
        { sourcePath, index: i, path },
      );
    }
    if (!ALLOWED_FILE_SUFFIXES.some((s) => path.endsWith(s))) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}].path '${path}' has an unsupported suffix; allowed: ${ALLOWED_FILE_SUFFIXES.join(", ")}`,
        { sourcePath, index: i, path },
      );
    }
    const summary = typeof fr["summary"] === "string" ? (fr["summary"] as string) : undefined;
    files.push(summary === undefined ? { path, role } : { path, role, summary });
  }

  const estimatedTokensRaw = obj["estimated_tokens"] ?? obj["estimatedTokens"];
  const estimatedTokens = typeof estimatedTokensRaw === "number" && Number.isFinite(estimatedTokensRaw)
    ? Math.max(0, Math.floor(estimatedTokensRaw))
    : undefined;

  const atoms = obj["atoms"] !== undefined ? parseAtoms(obj["atoms"], files, sourcePath) : undefined;

  return {
    name,
    version,
    ...(purpose !== undefined ? { purpose } : {}),
    files,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(atoms !== undefined ? { atoms } : {}),
  };
}

// ---------------------------------------------------------------------------
// OPR.0.5.3.5 mini-req 1 — install atoms. An atom is an ADDRESS plus
// composition metadata, never a new file: fresh/handover/post-compaction all
// compose addresses into the same bytes (mini-req 5 by construction). Every
// rule here fails LOUD with the atom's index and id — a malformed atom must
// stop ingest, never thin a later compose.

const MARKDOWN_SUFFIXES = [".md", ".markdown"];
const ATOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function atomError(sourcePath: string, index: number, detail: string): ContextPackError {
  return new ContextPackError("manifest_invalid", `manifest at ${sourcePath} atoms[${index}]: ${detail}`, { sourcePath, index });
}

function enumField<T extends string>(
  value: unknown, allowed: readonly T[], field: string, sourcePath: string, index: number,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw atomError(sourcePath, index, `'${field}' must be one of ${allowed.join(" | ")} (got: ${JSON.stringify(value)})`);
  }
  return value as T;
}

function parseAtoms(raw: unknown, files: ContextPackManifestFile[], sourcePath: string): ContextPackAtom[] {
  if (!Array.isArray(raw)) {
    throw new ContextPackError("manifest_invalid", `manifest at ${sourcePath} 'atoms' must be an array`, { sourcePath });
  }
  const declaredFiles = new Set(files.map((f) => f.path));
  const atoms: ContextPackAtom[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw atomError(sourcePath, i, "must be an object");
    }
    const a = entry as Record<string, unknown>;

    const id = a["id"];
    if (typeof id !== "string" || !ATOM_ID.test(id)) {
      throw atomError(sourcePath, i, `'id' must be a stable slug matching [a-z0-9][a-z0-9-]{0,63} (got: ${JSON.stringify(id)})`);
    }
    if (seenIds.has(id)) throw atomError(sourcePath, i, `duplicate atom id '${id}' — ids are the join key for order/requires/probes`);
    seenIds.add(id);

    const addressRaw = a["address"];
    if (typeof addressRaw !== "string" || addressRaw.length === 0) {
      throw atomError(sourcePath, i, "'address' is required: file or file#H2-slug/H3-slug");
    }
    let parsedAddr;
    try {
      parsedAddr = parseAddress(addressRaw);
    } catch (err) {
      if (err instanceof AddressResolutionError) throw atomError(sourcePath, i, `'address' is malformed — ${err.message}`);
      throw err;
    }
    if (!declaredFiles.has(parsedAddr.ref)) {
      throw atomError(sourcePath, i, `'address' references '${parsedAddr.ref}', which is not a declared pack file — an atom addresses INTO the pack's own files`);
    }
    if (parsedAddr.headerPath.length > 0 && !MARKDOWN_SUFFIXES.some((s) => parsedAddr.ref.endsWith(s))) {
      throw atomError(sourcePath, i, `'address' uses a header path on '${parsedAddr.ref}' — header addressing only applies to markdown files (${MARKDOWN_SUFFIXES.join(", ")})`);
    }

    const taxonomy = enumField(a["taxonomy"], ATOM_TAXONOMIES, "taxonomy", sourcePath, i);
    const purpose = enumField(a["purpose"], ATOM_PURPOSES, "purpose", sourcePath, i);
    const priority = enumField(a["priority"], ATOM_PRIORITIES, "priority", sourcePath, i);
    const runtime = a["runtime"] === undefined ? "any" : enumField(a["runtime"], ATOM_RUNTIMES, "runtime", sourcePath, i);

    const situationsRaw = a["situations"];
    if (!Array.isArray(situationsRaw) || situationsRaw.length === 0) {
      throw atomError(sourcePath, i, `'situations' must be a non-empty array of ${ATOM_SITUATIONS.join(" | ")} — it is the composition algebra's selector`);
    }
    const situations = situationsRaw.map((s) => enumField(s, ATOM_SITUATIONS, "situations", sourcePath, i));

    let regions: ContextPackAtom["regions"];
    if (a["regions"] !== undefined) {
      const regionsRaw = a["regions"];
      if (!Array.isArray(regionsRaw)) throw atomError(sourcePath, i, "'regions' must be an array when present");
      regions = regionsRaw.map((r) => enumField(r, ATOM_REGIONS, "regions", sourcePath, i));
    }

    const order = a["order"];
    if (typeof order !== "number" || !Number.isInteger(order)) {
      throw atomError(sourcePath, i, `'order' must be an integer — walks are ordered and absorption depends on sequence (got: ${JSON.stringify(order)})`);
    }

    let requires: string[] | undefined;
    if (a["requires"] !== undefined) {
      const requiresRaw = a["requires"];
      if (!Array.isArray(requiresRaw) || requiresRaw.some((r) => typeof r !== "string")) {
        throw atomError(sourcePath, i, "'requires' must be an array of atom ids when present");
      }
      requires = requiresRaw as string[];
      if (requires.includes(id)) throw atomError(sourcePath, i, `atom '${id}' requires itself`);
    }

    let probe: ContextPackAtom["probe"];
    if (a["probe"] !== undefined) {
      const p = a["probe"];
      if (!p || typeof p !== "object" || Array.isArray(p)) throw atomError(sourcePath, i, "'probe' must be an object { prompt, expect }");
      const pr = p as Record<string, unknown>;
      if (typeof pr["prompt"] !== "string" || pr["prompt"].length === 0 || typeof pr["expect"] !== "string" || pr["expect"].length === 0) {
        throw atomError(sourcePath, i, "'probe' needs BOTH a natural 'prompt' and the 'expect'ed observable behavior — acceptance is changed behavior, never files delivered");
      }
      probe = { prompt: pr["prompt"], expect: pr["expect"] };
    }

    atoms.push({
      id,
      address: addressRaw,
      taxonomy,
      ...(regions !== undefined ? { regions } : {}),
      situations,
      purpose,
      runtime,
      order,
      ...(requires !== undefined ? { requires } : {}),
      priority,
      ...(probe !== undefined ? { probe } : {}),
    });
  }

  // Cross-atom edges, after all ids are known.
  for (let i = 0; i < atoms.length; i++) {
    for (const req of atoms[i]!.requires ?? []) {
      if (!seenIds.has(req)) {
        throw atomError(sourcePath, i, `atom '${atoms[i]!.id}' requires '${req}', which no atom declares`);
      }
    }
  }
  // A requires CYCLE can never be closed over by any subset profile — reject at
  // ingest with the cycle spelled out.
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const visit = (atomId: string, trail: string[]): void => {
    const s = state.get(atomId);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(atomId)), atomId].join(" -> ");
      throw new ContextPackError("manifest_invalid", `manifest at ${sourcePath} atoms: requires cycle ${cycle} — no subset profile could ever close over it`, { sourcePath });
    }
    state.set(atomId, "visiting");
    for (const req of byId.get(atomId)!.requires ?? []) visit(req, [...trail, atomId]);
    state.set(atomId, "done");
  };
  for (const atom of atoms) visit(atom.id, []);

  return atoms;
}
