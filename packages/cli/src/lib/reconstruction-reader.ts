import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };
export const RECONSTRUCTION_SCHEMA = "openrig.reconstruction/v0";
const MAX_DOCUMENT = 8 * 1024 * 1024;
const MAX_CLOSURE = 32 * 1024 * 1024;
const PRESERVED = ["authority", "constraint", "gap"];

export class ReconstructionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new ReconstructionError("invalid_reconstruction", message);
}
function object(value: Json | undefined, label: string): RecordValue {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}
function list(value: Json | undefined, label: string): Json[] {
  requireValue(Array.isArray(value), `${label} must be an array`); return value;
}
function text(value: Json | undefined, label: string): string {
  requireValue(typeof value === "string" && value.trim(), `${label} must be a nonempty string`); return value;
}
function strings(value: Json | undefined, label: string): string[] {
  const values = list(value === undefined ? [] : value, label);
  requireValue(values.every(v => typeof v === "string"), `${label} must contain strings`); return values as string[];
}
function timestamp(value: Json | undefined, label: string, nullable = false): void {
  if (value === null && nullable) return;
  requireValue(typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), `${label} must have an ISO timestamp with timezone${nullable ? " or null" : ""}`);
}
function absolute(value: Json | undefined, label: string): string {
  const name = text(value, label); requireValue(isAbsolute(name), `${label} must be an absolute local path`); return normalize(name);
}
function revision(value: Json | undefined): string {
  const id = text(value, "revision"); requireValue(/^[a-f0-9]{64}$/.test(id), "revision must be a full lowercase SHA256 ID"); return id;
}
function validUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      requireValue(next >= 0xdc00 && next <= 0xdfff, "unpaired Unicode surrogate is unsupported by v0 UTF-8 hashing");
    } else requireValue(unit < 0xdc00 || unit > 0xdfff, "unpaired Unicode surrogate is unsupported by v0 UTF-8 hashing");
  }
}

/** v0 is Python sorted compact JSON, not JS property order. Reject numeric
 * representations we cannot reproduce, rather than silently changing an ID. */
export function parseReconstructionJson(input: string): Json {
  let at = 0;
  const space = () => { while (/[ \n\r\t]/.test(input[at] ?? "x")) at++; };
  const quoted = (): string => {
    const start = at++;
    while (at < input.length) {
      const char = input[at++];
      if (char === "\\") at++;
      else if (char === '"') {
        const result: unknown = JSON.parse(input.slice(start, at));
        requireValue(typeof result === "string", "invalid JSON string"); validUnicode(result); return result;
      }
    }
    throw new ReconstructionError("invalid_reconstruction", "unterminated JSON string");
  };
  const value = (depth: number): Json => {
    requireValue(depth <= 128, "JSON nesting exceeds 128"); space();
    if (input[at] === '"') return quoted();
    if (input[at] === "{") {
      at++; space(); const result: RecordValue = Object.create(null) as RecordValue;
      if (input[at] !== "}") while (true) {
        requireValue(input[at] === '"', "expected JSON object key"); const key = quoted(); space();
        requireValue(!Object.hasOwn(result, key), `duplicate JSON key: ${key}`);
        requireValue(input[at++] === ":", "expected JSON colon"); result[key] = value(depth + 1); space();
        if (input[at] !== ",") break; at++; space();
      }
      requireValue(input[at++] === "}", "expected JSON object end"); return result;
    }
    if (input[at] === "[") {
      at++; space(); const result: Json[] = [];
      if (input[at] !== "]") while (true) {
        result.push(value(depth + 1)); space(); if (input[at] !== ",") break; at++;
      }
      requireValue(input[at++] === "]", "expected JSON array end"); return result;
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (input.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(at))?.[0];
    requireValue(number !== undefined, "expected JSON value");
    if (/[.eE]/.test(number) || !Number.isSafeInteger(Number(number))) {
      throw new ReconstructionError("unsupported_v0_number", "v0 reader supports safe integer JSON numbers only; floating/exponent and unsafe integers require an explicit compatible reader, never an ID rewrite");
    }
    at += number.length; return Number(number);
  };
  try {
    const parsed = value(0); space(); requireValue(at === input.length, "trailing JSON input"); return parsed;
  } catch (error) {
    if (error instanceof ReconstructionError) throw error;
    throw new ReconstructionError("invalid_reconstruction", `invalid JSON: ${(error as Error).message}`);
  }
}

function codepointOrder(a: string, b: string): number {
  const aa = Array.from(a), bb = Array.from(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const difference = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!; if (difference) return difference;
  }
  return aa.length - bb.length;
}
export function canonicalV0(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") requireValue(Number.isSafeInteger(value), "unsupported v0 number");
    if (typeof value === "string") validUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalV0).join(",")}]`;
  return `{${Object.keys(value).sort(codepointOrder).map(key => `${canonicalV0(key)}:${canonicalV0(value[key]!)}`).join(",")}}`;
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Regular-file, no-follow, bounded read; no source commands are executed. */
function readRegular(file: string, limit: number): Buffer {
  const initial = lstatSync(file);
  requireValue(initial.isFile() && !initial.isSymbolicLink(), `not a regular file: ${file}`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    requireValue(before.isFile() && before.dev === initial.dev && before.ino === initial.ino && before.size <= limit, `file identity or byte bound failed: ${file}`);
    const chunks: Buffer[] = []; let bytes = 0;
    while (bytes <= limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
      const count = readSync(fd, buffer); if (!count) break;
      bytes += count; requireValue(bytes <= limit, `file exceeds byte bound: ${file}`); chunks.push(buffer.subarray(0, count));
    }
    const after = fstatSync(fd), current = lstatSync(file);
    requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && after.dev === current.dev && after.ino === current.ino, `file changed during read: ${file}`);
    return Buffer.concat(chunks);
  } finally { closeSync(fd); }
}
function jsonFile(file: string, remainingBytes = MAX_DOCUMENT): { value: Json; bytes: number } {
  const bytes = readRegular(file, Math.min(MAX_DOCUMENT, remainingBytes));
  return { value: parseReconstructionJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), bytes: bytes.length };
}

export interface StoreMapping { sourceStore: string; localStore: string; sourceHost?: string }
export function readStoreMappings(file: string): StoreMapping[] {
  return list(jsonFile(file).value, "store mappings").map(value => {
    const entry = object(value, "mapping");
    return { sourceStore: absolute(entry.sourceStore, "sourceStore"), localStore: absolute(entry.localStore, "localStore"),
      ...(entry.sourceHost === undefined ? {} : { sourceHost: text(entry.sourceHost, "sourceHost") }) };
  });
}
interface Pointer { store: string; revision: string }
function pointer(value: Json | undefined): Pointer {
  const v = object(value, "pointer"); return { store: absolute(v.store, "pointer.store"), revision: revision(v.revision) };
}
function records(value: Json | undefined, kind: "items" | "sources"): RecordValue[] {
  const seen = new Set<string>();
  return list(value === undefined ? [] : value, kind).map(v => {
    const r = object(v, kind), id = text(r.id, `${kind}.id`); requireValue(!seen.has(id), `duplicate ${kind} ID: ${id}`); seen.add(id);
    timestamp(r.observed_at, `${kind}.observed_at`, true);
    if (kind === "items") {
      text(r.category, "item.category"); text(r.text, "item.text");
      if (r.status !== undefined) text(r.status, "item.status");
      for (const name of ["sources", "depends_on", "tags"]) strings(r[name], name);
      requireValue(["source-belief", "assessment", "observed", "reported"].includes(String(r.perspective ?? "assessment")), "invalid item perspective");
    } else {
      requireValue(r.path !== undefined || r.address !== undefined, "source requires path or address");
      if (r.path !== undefined) absolute(r.path, "source.path");
      if (r.address !== undefined) text(r.address, "source.address");
      if (r.sha256 !== undefined && r.sha256 !== null) revision(r.sha256);
    }
    return r;
  });
}
function discovery(value: Json | undefined): Json[] {
  const roots = list(value === undefined ? [] : value, "discovery"), ids = new Set<string>();
  for (const value of roots) {
    const root = object(value, "discovery entry"), id = text(root.id, "discovery.id");
    requireValue(!ids.has(id), "duplicate discovery ID"); ids.add(id);
    absolute(root.path, "discovery.path");
    for (const name of strings(root.known_paths, "discovery.known_paths")) {
      requireValue(!isAbsolute(name) && !name.split("/").includes(".."), "discovery known_paths must stay under root");
    }
    const entries = root.max_entries ?? 1000, depth = root.max_depth ?? 8;
    requireValue(typeof entries === "number" && Number.isInteger(entries) && entries >= 1 && entries <= 10000, "discovery.max_entries must be 1..10000");
    requireValue(typeof depth === "number" && Number.isInteger(depth) && depth >= 0 && depth <= 32, "discovery.max_depth must be 0..32");
    timestamp(root.observed_at ?? null, "discovery.observed_at", true);
  }
  return roots;
}
function validate(doc: RecordValue): void {
  if (doc.schema !== RECONSTRUCTION_SCHEMA) throw new ReconstructionError("unsupported_schema", `unsupported reconstruction schema: ${String(doc.schema)}`);
  requireValue(["base", "delta", "composition"].includes(String(doc.kind)), "invalid reconstruction kind");
  for (const key of ["subject", "purpose", "author"]) text(doc[key], key);
  timestamp(doc.created_at, "created_at");
  requireValue(["orientation", "working", "continuity", "full-domain"].includes(String(doc.depth)), "invalid reconstruction depth");
  for (const key of ["items", "upsert_items"]) if (doc[key] !== undefined) records(doc[key], "items");
  for (const key of ["sources", "upsert_sources"]) if (doc[key] !== undefined) records(doc[key], "sources");
  if (doc.coverage !== undefined) {
    const coverage = object(doc.coverage, "coverage"); strings(coverage.included, "coverage.included"); strings(coverage.excluded, "coverage.excluded");
  }
  strings(doc.unknowns, "unknowns"); discovery(doc.discovery);
  for (const key of ["remove_items", "remove_sources"]) {
    const ids = strings(doc[key], key); requireValue(new Set(ids).size === ids.length, `duplicate ${key}`);
  }
  if (doc.kind === "delta") {
    pointer(doc.parent);
    requireValue(!["items", "sources", "members"].some(key => key in doc), "delta uses upsert/remove fields; members remain pinned");
  } else requireValue(!Object.keys(doc).some(key => key.startsWith("upsert_") || key.startsWith("remove_")), "base/composition uses items and sources, not delta fields");
  if (doc.kind === "composition") {
    const members = list(doc.members, "members"); requireValue(members.length > 0 && members.length <= 64, "composition requires 1..64 members"); members.forEach(pointer);
  }
}
interface Node {
  document: RecordValue; sourceStore: string; localStore: string; items: RecordValue[]; sources: RecordValue[];
  coverage: Json; unknowns: string[]; discovery: Json[]; members: Node[]; lineage: Pointer[];
}
interface Issue { code: string; message: string; store?: string; revision?: string; subject?: string }
export interface ReconstructionOptions {
  store: string; revision: string; mappings?: StoreMapping[];
  items?: string[]; categories?: string[]; tags?: string[]; checkSources?: boolean;
}
const flatten = (node: Node): Node[] => [node, ...node.members.flatMap(flatten)];

export function readReconstruction(options: ReconstructionOptions) {
  const rootStore = absolute(options.store, "store"), rootRevision = revision(options.revision);
  const mappings = new Map<string, StoreMapping>();
  for (const entry of options.mappings ?? []) {
    const source = absolute(entry.sourceStore, "sourceStore");
    requireValue(!mappings.has(source), "ambiguous duplicate source-store mapping; v0 pointers have no host discriminator");
    mappings.set(source, { ...entry, sourceStore: source, localStore: absolute(entry.localStore, "localStore") });
  }
  const issues: Issue[] = [], loaded: Array<{ revision: string; sourceStore: string; localStore: string; fileBytes: number }> = [];
  let totalBytes = 0, visited = 0;
  let exhausted = false;
  const materialize = (store: string, id: string, stack: string[]): Node | undefined => {
    if (exhausted) return undefined;
    const sourceStore = absolute(store, "pointer.store"), key = `${sourceStore}\0${id}`;
    try {
      if (stack.length >= 64 || ++visited > 64 || totalBytes >= MAX_CLOSURE) {
        exhausted = true;
        throw new ReconstructionError("closure_limit", "reconstruction closure exceeds 64 references or 32 MiB");
      }
      requireValue(!stack.includes(key), "reconstruction reference cycle");
      const mapping = mappings.get(sourceStore);
      if (!mapping && sourceStore !== rootStore) throw new ReconstructionError("unmapped_external_store", `external store ${sourceStore} requires an explicit store mapping; no implicit remote read`);
      const localStore = mapping?.localStore ?? sourceStore;
      const file = jsonFile(join(localStore, `${revision(id)}.json`), MAX_CLOSURE - totalBytes); totalBytes += file.bytes;
      if (totalBytes > MAX_CLOSURE) {
        exhausted = true;
        throw new ReconstructionError("closure_limit", "reconstruction closure exceeds 32 MiB");
      }
      const doc = object(file.value, "revision"); requireValue(doc.id === id, "stored ID does not match requested revision");
      const { id: ignored, ...body } = doc; void ignored;
      requireValue(hash(canonicalV0(body)) === id, "revision content hash mismatch"); validate(doc);
      loaded.push({ revision: id, sourceStore, localStore, fileBytes: file.bytes });
      const trail = [...stack, key]; let result: Node;
      if (doc.kind === "delta") {
        const parent = pointer(doc.parent), inherited = materialize(parent.store, parent.revision, trail);
        if (!inherited) return undefined;
        requireValue(inherited.document.subject === doc.subject, "delta cannot change subject identity");
        result = { ...inherited, members: [...inherited.members], lineage: [...inherited.lineage, { store: sourceStore, revision: id }] };
        for (const collection of ["items", "sources"] as const) {
          const values = new Map(inherited[collection].map(v => [String(v.id), v]));
          const removed = strings(doc[`remove_${collection}`], `remove_${collection}`);
          const updates = records(doc[`upsert_${collection}`], collection);
          for (const remove of removed) {
            requireValue(values.has(remove) && !updates.some(v => v.id === remove), `invalid removal/upsert: ${remove}`); values.delete(remove);
          }
          for (const v of updates) values.set(String(v.id), v);
          result[collection] = [...values.values()];
        }
        if (doc.coverage !== undefined) result.coverage = doc.coverage;
        if (doc.unknowns !== undefined) result.unknowns = strings(doc.unknowns, "unknowns");
        if (doc.discovery !== undefined) result.discovery = list(doc.discovery, "discovery");
      } else {
        result = { document: doc, sourceStore, localStore, items: records(doc.items, "items"), sources: records(doc.sources, "sources"),
          coverage: doc.coverage ?? { included: [], excluded: [] }, unknowns: strings(doc.unknowns, "unknowns"), discovery: discovery(doc.discovery),
          members: [], lineage: [{ store: sourceStore, revision: id }] };
        for (const member of list(doc.members === undefined ? [] : doc.members, "members")) {
          const p = pointer(member), node = materialize(p.store, p.revision, trail); if (node) result.members.push(node);
        }
      }
      return { ...result, document: doc, sourceStore, localStore };
    } catch (error) {
      issues.push({ code: error instanceof ReconstructionError ? error.code : "revision_unavailable", message: (error as Error).message, store: sourceStore, revision: id });
      return undefined;
    }
  };
  let root = materialize(rootStore, rootRevision, []);
  const seenSubjects = new Set<string>();
  if (root) for (const node of flatten(root)) {
    const subject = String(node.document.subject);
    if (seenSubjects.has(subject)) { issues.push({ code: "duplicate_subject", message: `composition repeats subject ${subject}` }); root = undefined; break; }
    seenSubjects.add(subject);
  }
  const nodes = root ? flatten(root) : [], allIds = new Set(nodes.flatMap(node => node.items.map(v => String(v.id))));
  const filtered = Boolean(options.items?.length || options.categories?.length || options.tags?.length);
  for (const id of options.items ?? []) if (!allIds.has(id)) issues.push({ code: "missing_item", message: `selected item is missing: ${id}` });
  const selected = nodes.map(node => {
    const byId = new Map(node.items.map(v => [String(v.id), v]));
    const ids = new Set(node.items.filter(v => !filtered || options.items?.includes(String(v.id)) || options.categories?.includes(String(v.category))
      || strings(v.tags, "tags").some(tag => options.tags?.includes(tag)) || PRESERVED.includes(String(v.category))).map(v => String(v.id)));
    const pending = [...ids];
    while (pending.length) for (const dependency of strings(byId.get(pending.pop()!)!.depends_on, "depends_on")) {
      if (!byId.has(dependency)) issues.push({ code: "missing_dependency", message: `missing dependency: ${dependency}`, subject: String(node.document.subject) });
      else if (!ids.has(dependency)) { ids.add(dependency); pending.push(dependency); }
    }
    const items = node.items.filter(v => ids.has(String(v.id))), cited = new Set(items.flatMap(v => strings(v.sources, "sources")));
    const sources = new Map(node.sources.map(v => [String(v.id), v]));
    for (const id of cited) if (!sources.has(id)) issues.push({ code: "missing_citation", message: `missing source: ${id}`, subject: String(node.document.subject) });
    return { node, items, cited, ids };
  });
  let sourceBytes = 0, sourceCount = 0;
  const sourceChecks = options.checkSources ? nodes.flatMap(node => node.sources.map(source => {
    const base = { subject: node.document.subject, id: source.id, observedAt: source.observed_at };
    if (source.path === undefined) return { ...base, status: "unchecked", reason: "opaque/nonlocal route; not fetched" };
    try {
      requireValue(++sourceCount <= 128 && sourceBytes < 64 * 1024 * 1024, "source checking budget exhausted (128 files / 64 MiB total)");
      const bytes = readRegular(String(source.path), 64 * 1024 * 1024 - sourceBytes); sourceBytes += bytes.length;
      const actual = hash(bytes);
      return { ...base, sha256: actual, status: source.sha256 ? (actual === source.sha256 ? "unchanged" : "changed") : "unchecked", reason: "byte comparison only; observation dates and semantic freshness are not refreshed" };
    } catch (error) { return { ...base, status: "unavailable", reason: (error as Error).message }; }
  })) : undefined;
  const materializedBytes = Buffer.byteLength(JSON.stringify(root ?? null));
  return {
    presentationSchema: "openrig.reconstruction-reader/v1", storedSchema: RECONSTRUCTION_SCHEMA,
    requestedStore: rootStore, requestedRevision: rootRevision, complete: issues.length === 0, issues,
    completenessScope: "record closure and selected item/citation references; not source freshness",
    caveat: "Context is evidence for understanding, not authority, competence, acceptance or current runtime state. Authors are claimed attribution. No discovery cursor or implicit remote reads.",
    selectors: { mode: filtered ? "filtered" : "full", items: options.items ?? [], categories: options.categories ?? [], tags: options.tags ?? [], combination: "union", alwaysIncludeCategories: PRESERVED, includeTransitiveDependencies: true },
    mappings: [...mappings.values()], records: loaded, closureBytesRead: totalBytes, atomicGroupCapture: false,
    size: { materializedJsonUtf8Bytes: materializedBytes, approximateTokens: Math.ceil(materializedBytes / 4),
      estimateMethod: "materialized reader JSON UTF-8 bytes / 4; rough, not a model tokenizer" },
    nodes: selected.map(({ node, items, cited, ids }) => ({
      subject: node.document.subject, revision: node.document.id, kind: node.document.kind, author: node.document.author,
      purpose: node.document.purpose, depth: node.document.depth, createdAt: node.document.created_at,
      sourceStore: node.sourceStore, localStore: node.localStore, lineage: node.lineage,
      declaredCoverage: node.coverage, unknowns: node.unknowns, discovery: node.discovery,
      sourceManifest: node.sources, itemObservations: node.items.map(v => ({ id: v.id, observedAt: v.observed_at })),
      items, viewSources: node.sources.filter(v => !filtered || cited.has(String(v.id))),
      viewCoverage: { totalItems: node.items.length, includedIds: items.map(v => v.id), omittedIds: node.items.filter(v => !ids.has(String(v.id))).map(v => v.id),
        registeredSources: node.sources.length, citedSourceIds: [...cited], omittedRouteIds: filtered ? node.sources.filter(v => !cited.has(String(v.id))).map(v => v.id) : [] },
    })), ...(sourceChecks ? { sourceChecks } : {}),
  };
}

export type ReconstructionRead = ReturnType<typeof readReconstruction>;
export function reconstructionOutput(result: ReconstructionRead, mode: "inspect" | "view", json: boolean, maxBytes = 256 * 1024): string {
  requireValue(Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= MAX_DOCUMENT, "max-bytes must be 1024..8388608");
  // Inspect never delivers item bodies; view carries its actual omissions and
  // complete-manifest route rather than presenting full coverage as selected.
  const data = { ...result, nodes: result.nodes.map(node => mode === "inspect" ? { ...node, items: undefined, viewSources: undefined } : { ...node, sourceManifest: undefined }) };
  let output: string;
  if (json || mode === "inspect") output = JSON.stringify(data, null, 2);
  else {
    const lines = ["# Reconstruction view", "", result.caveat, `Complete: ${result.complete} (${result.completenessScope})`, `Applied selectors: ${JSON.stringify(result.selectors)}`];
    for (const issue of result.issues) lines.push(`UNAVAILABLE: ${issue.code}: ${issue.message}`);
    for (const node of result.nodes) {
      lines.push("", `## ${String(node.subject)}`, `Revision: ${String(node.revision)}`, `Author (claimed): ${String(node.author)}`, `Purpose: ${String(node.purpose)}`, `Depth: ${String(node.depth)}`,
        `Source store: ${node.sourceStore}; local read store: ${node.localStore}`,
        `Created: ${String(node.createdAt)} (not inherited-fact verification time)`, `Author-declared coverage: ${JSON.stringify(node.declaredCoverage)}`, `Selected view coverage: ${JSON.stringify(node.viewCoverage)}`,
        "Composition members retain independent observation dates; no atomic capture is claimed.");
      for (const unknown of node.unknowns) lines.push(`Unknown: ${unknown}`);
      for (const item of node.items) lines.push("", `### ${String(item.id)} [${String(item.category)}]`, String(item.text),
        `Perspective: ${String(item.perspective ?? "assessment")}; observed: ${String(item.observed_at)}; status: ${String(item.status ?? "unspecified")}`,
        `Sources: ${JSON.stringify(item.sources ?? [])}; dependencies: ${JSON.stringify(item.depends_on ?? [])}`);
      lines.push("", "Evidence routes:");
      for (const source of node.viewSources) lines.push(JSON.stringify(source));
      if (node.viewCoverage.omittedRouteIds.length) lines.push("Uncited routes omitted; inspect this exact revision for its complete source manifest.");
    }
    if (result.sourceChecks) lines.push("Source byte checks (not semantic reverification):", JSON.stringify(result.sourceChecks));
    output = lines.join("\n");
  }
  const bytes = Buffer.byteLength(output);
  if (bytes > maxBytes) throw new ReconstructionError("output_limit", `output is ${bytes} UTF-8 bytes; max-bytes is ${maxBytes}. Select a narrower view or explicitly raise the bound; no complete output was delivered.`);
  return output;
}
