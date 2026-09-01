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
  TAXONOMY_TEACHING,
  ContextPackError,
  type ContextPackAtom,
  type ContextPackManifest,
  type ContextPackManifestFile,
} from "./context-pack-types.js";
import { isSafePackVersion } from "./ref-safety.js";
import { AddressResolutionError, parseAddress } from "../markdown-address.js";
import { parseSourceRef, SourceResolutionError } from "./profile-source-resolver.js";

// Served as UTF-8 bundle text. Script suffixes carry skill helper assets the
// served prose references — inert text content, never executed. An unlisted
// suffix still rejects loud, so a genuinely new pack file type fails at ingest
// rather than serving a silently-incomplete bundle.
const ALLOWED_FILE_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts", ".mjs", ".py"];

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

  // OPR.0.5.6.10 mini-req 2 — the pack-level classification is REQUIRED and
  // fails LOUD with the migration instruction in the error. No grandfather
  // clause: an unstamped pack cannot ship, and the refusal teaches the fix.
  const taxonomyRaw = obj["taxonomy"];
  if (taxonomyRaw === undefined || taxonomyRaw === null) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'taxonomy' — every context pack declares what kind of context it is. ${TAXONOMY_TEACHING}`,
      { sourcePath },
    );
  }
  if (typeof taxonomyRaw !== "string" || !(ATOM_TAXONOMIES as readonly string[]).includes(taxonomyRaw)) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} has invalid taxonomy ${JSON.stringify(taxonomyRaw)}. ${TAXONOMY_TEACHING}`,
      { sourcePath },
    );
  }
  const taxonomy = taxonomyRaw as (typeof ATOM_TAXONOMIES)[number];

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
    taxonomy,
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

const ALLOWED_ATOM_KEYS = new Set([
  "id", "address", "taxonomy", "regions", "situations", "purpose", "runtime", "order", "requires", "priority", "probe",
]);
// The typos worth a kindness (r1 F2): singular/plural slips on the fields whose
// silent loss is sharpest.
const ALLOWED_PROBE_KEYS = new Set(["prompt", "expect", "expectedPatterns", "rubric"]);
const NEAR_MISS_ATOM_KEYS: Record<string, string> = {
  require: "requires", region: "regions", situation: "situations", probes: "probe",
};

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

    // r1 F2: ingest knows the complete legal key set — an unknown key rejects
    // LOUD. A `require:` typo silently dropping a dependency edge is the exact
    // failure the field exists to prevent; every REQUIRED field failing loud
    // while a typo'd OPTIONAL one fails silent would break the module contract.
    for (const key of Object.keys(a)) {
      if (!ALLOWED_ATOM_KEYS.has(key)) {
        const hint = NEAR_MISS_ATOM_KEYS[key];
        throw atomError(sourcePath, i, `unknown field '${key}'${hint ? ` — did you mean '${hint}'?` : ""} (allowed: ${[...ALLOWED_ATOM_KEYS].join(", ")})`);
      }
    }

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
    // Atom 4a — the pre-'#' ref carries its resolver kind (Q2-Amendment 1's
    // one-grammar-two-resolvers ruling): a bare LIBRARY ref must be a declared
    // pack file; a project:/seat:/mission: TREE ref lives outside the pack by design
    // (nothing must be library-homed to be composable), so it validates
    // structurally here (unknown prefix / traversal reject loud) and resolves
    // from configured roots at compose.
    let sourceRef;
    try {
      sourceRef = parseSourceRef(parsedAddr.ref);
    } catch (err) {
      if (err instanceof SourceResolutionError) throw atomError(sourcePath, i, `'address' — ${err.message}`);
      throw err;
    }
    if (sourceRef.kind === "library" && !declaredFiles.has(parsedAddr.ref)) {
      throw atomError(sourcePath, i, `'address' references '${parsedAddr.ref}', which is not a declared pack file — a library atom addresses INTO the pack's own files (tree sources use the project:/seat:/mission: prefix)`);
    }
    if (parsedAddr.headerPath.length > 0 && !MARKDOWN_SUFFIXES.some((s) => sourceRef.rel.endsWith(s))) {
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
      if (!p || typeof p !== "object" || Array.isArray(p)) throw atomError(sourcePath, i, "'probe' must be an object { prompt, expect, expectedPatterns?, rubric? }");
      const pr = p as Record<string, unknown>;
      // Q3 bridge: the key gate extends INSIDE probe (the dispositioned Atom-2
      // note landing at its recorded spot), and the shape reconciles with the
      // harness's EvalCase — expectedPatterns/rubric are LEGAL here, so the
      // natural mistake r1 predicted becomes the schema instead of silent loss.
      for (const key of Object.keys(pr)) {
        if (!ALLOWED_PROBE_KEYS.has(key)) {
          throw atomError(sourcePath, i, `'probe' has unknown field '${key}'${key === "rubrics" ? " — did you mean 'rubric'?" : ""} (allowed: ${[...ALLOWED_PROBE_KEYS].join(", ")})`);
        }
      }
      if (typeof pr["prompt"] !== "string" || pr["prompt"].length === 0 || typeof pr["expect"] !== "string" || pr["expect"].length === 0) {
        throw atomError(sourcePath, i, "'probe' needs BOTH a natural 'prompt' and the 'expect'ed observable behavior — acceptance is changed behavior, never files delivered");
      }
      let expectedPatterns: string[] | undefined;
      if (pr["expectedPatterns"] !== undefined) {
        const eps = pr["expectedPatterns"];
        if (!Array.isArray(eps) || eps.some((e) => typeof e !== "string")) {
          throw atomError(sourcePath, i, "'probe.expectedPatterns' must be an array of regex source strings when present");
        }
        for (const src of eps as string[]) {
          try {
            new RegExp(src);
          } catch {
            throw atomError(sourcePath, i, `'probe.expectedPatterns' entry '${src}' is not a compilable regex source`);
          }
        }
        expectedPatterns = eps as string[];
      }
      if (pr["rubric"] !== undefined && typeof pr["rubric"] !== "string") {
        throw atomError(sourcePath, i, "'probe.rubric' must be a string when present");
      }
      probe = {
        prompt: pr["prompt"],
        expect: pr["expect"],
        ...(expectedPatterns !== undefined ? { expectedPatterns } : {}),
        ...(pr["rubric"] !== undefined ? { rubric: pr["rubric"] as string } : {}),
      };
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
  // ingest with the cycle spelled out. The walk is ITERATIVE with an explicit
  // stack (r1 F1): the recursive form threw a bare RangeError past ~5000 atoms —
  // outside the ContextPackError channel this module promises — and depth is
  // attacker-choosable (packs install from URLs, slice-07 R4); no recursion
  // threshold is safe across Node versions/platforms, so there isn't one.
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  for (const root of atoms) {
    if (state.get(root.id) === "done") continue;
    // Each frame tracks how far through its requires list it has walked.
    const stack: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    state.set(root.id, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const reqs = byId.get(frame.id)!.requires ?? [];
      if (frame.next >= reqs.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const req = reqs[frame.next++]!;
      const s = state.get(req);
      if (s === "done") continue;
      if (s === "visiting") {
        const trail = stack.map((f) => f.id);
        const cycle = [...trail.slice(trail.indexOf(req)), req].join(" -> ");
        throw new ContextPackError("manifest_invalid", `manifest at ${sourcePath} atoms: requires cycle ${cycle} — no subset profile could ever close over it`, { sourcePath });
      }
      state.set(req, "visiting");
      stack.push({ id: req, next: 0 });
    }
  }

  return atoms;
}
