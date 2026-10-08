import { shellQuote as quote } from "../adapters/shell-quote.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { parseAddress, parseMarkdownSections, resolveAddress, slugifyHeader } from "./markdown-address.js";
import type { ContextPackLibraryService } from "./context-packs/context-pack-library-service.js";

type Mapping = Record<string, any>;
type Source = { kind: string; path: string; sha256: string; binding: "matches-bound" | "differs-from-bound" | "not-bound" };
type Component = { id: string; owner?: string; admission?: string };
export interface GuidanceInput {
  instanceId: string;
  contextRefs?: string[];
  binding?: Record<string, unknown> | null;
  stepId?: string;
  ownerSession?: string;
  packetId?: string;
  component?: string;
  full?: boolean;
  library?: ContextPackLibraryService;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const mapping = (value: unknown, at: string): Mapping => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(at + ": expected a mapping");
  return value as Mapping;
};
const string = (value: unknown, at: string): string => {
  if (typeof value !== "string" || !value.trim()) throw Error(at + ": expected non-empty text");
  return value;
};

/** Current authored advice. No component cursor, scheduler, cache or adoption write. */
export function readWorkflowGuidance(input: GuidanceInput) {
  const unknowns: string[] = [], sources: Source[] = [], stories: Array<{ address: string; text: string }> = [];
  const bound = Array.isArray(input.binding?.sources) ? input.binding.sources as Array<{kind: string; path: string; sha256: string}> : [];
  const refs = [...new Set([...(input.contextRefs ?? []), ...bound.filter(s => s.kind !== "slice").map(s => s.path)])];
  const manifests: Array<{kind: string; path: string; document: Mapping}> = [];
  let components: Component[] = [], edges: Array<{from: string; to: string; when?: string}> = [];
  let selectionSource: string | null = null, catalogSource: string | null = null, catalog: Mapping | null = null;
  let catalogPath: string | null = null, catalogHash: string | null = null;
  let selected = false, selectionInvalid = false;
  let rawComponents: unknown, rawEdges: unknown = [];
  const command = "rig workflow guidance " + quote(input.instanceId) + (input.packetId ? " --packet " + quote(input.packetId) : "");
  const readManifest = (kind: string, path: string) => {
    const text = readFileSync(path, "utf8"), sha256 = hash(text), prior = bound.find(s => resolve(s.path) === resolve(path));
    sources.push({kind, path, sha256, binding: !prior ? "not-bound" : prior.sha256 === sha256 ? "matches-bound" : "differs-from-bound"});
    const document = mapping(parse(text), path);
    manifests.push({kind, path, document});
    return document;
  };
  try {
    for (const kind of ["project", "mission"]) {
      const paths = refs.filter(ref => basename(ref) === kind + ".yaml");
      if (paths.length > 1) throw Error("Multiple " + kind + " sources; select unambiguous authored context: " + paths.join(", "));
      if (paths[0]) readManifest(kind, paths[0]);
    }
    // Bound members are membership, not the active slice. Only an explicit
    // context or a legacy slice's exact executable identity establishes it.
    const slicePaths = refs.filter(ref => basename(ref) === "slice.yaml");
    if ((input.binding?.graphSource as Mapping | undefined)?.mode === "legacy-slices" && input.stepId) {
      for (const source of bound.filter(s => s.kind === "slice")) {
        const doc = mapping(parse(readFileSync(source.path, "utf8")), source.path);
        if ((doc.metadata?.id ?? basename(dirname(source.path))) === input.stepId) slicePaths.push(source.path);
      }
    }
    const slices = [...new Set(slicePaths)];
    if (slices.length > 1) throw Error("Active slice unknown: multiple explicit slice contexts: " + slices.join(", "));
    if (slices[0]) readManifest("slice", slices[0]);
    for (const source of manifests) {
      if (!("sdlc" in source.document)) continue;
      selected = true;
      const at = source.path + "#sdlc", sdlc = mapping(source.document.sdlc, at);
      if ("catalog" in sdlc) { catalog = sdlc.catalog; catalogSource = source.path; }
      if ("components" in sdlc) {
        rawComponents = sdlc.components; selectionSource = source.path;
        rawEdges = []; // Replacement never appends ancestor gates or edges.
      }
      if ("edges" in sdlc) rawEdges = sdlc.edges;
    }
    if (selected && !selectionSource) throw Error("Explicit SDLC selection has no components list; no default gates selected.");
    if (selected) {
      // Validate only the effective fields consumed below, not overridden advice.
      if (!Array.isArray(rawComponents)) throw Error(selectionSource + "#sdlc.components: expected a list");
      components = rawComponents.map(raw => {
        const c = mapping(raw, selectionSource + "#sdlc.components");
        return {id: string(c.id, selectionSource + "#sdlc.components.id"),
          ...(c.owner === undefined ? {} : {owner: string(c.owner, selectionSource + "#sdlc.components.owner")}),
          ...(c.admission === undefined ? {} : {admission: string(c.admission, selectionSource + "#sdlc.components.admission")})};
      });
      if (new Set(components.map(c => c.id)).size !== components.length) throw Error(selectionSource + "#sdlc.components: duplicate IDs");
      if (!Array.isArray(rawEdges)) throw Error("Effective sdlc.edges: expected a list");
      edges = rawEdges.map(raw => {
        const e = mapping(raw, "sdlc.edges");
        return {from: string(e.from, "sdlc.edges.from"), to: string(e.to, "sdlc.edges.to"),
          ...(e.when === undefined ? {} : {when: string(e.when, "sdlc.edges.when")})};
      });
    }
    for (const edge of edges) if (![edge.from, edge.to].every(id => components.some(c => c.id === id))) throw Error("SDLC edge names an unselected component: " + edge.from + " -> " + edge.to);
  } catch (error) { selectionInvalid = true; unknowns.push(String(error)); }

  if (selected) for (const source of manifests) {
    try {
      const ref = source.document.composition?.[source.kind + "_markdown"]?.spec ?? "SPEC.md";
      const address = resolve(dirname(source.path), string(ref, source.path + ": spec"));
      const text = readFileSync(address, "utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const intent = frontmatter ? parse(frontmatter[1]!)?.intent : undefined;
      stories.push({address: address + (typeof intent === "string" ? " (frontmatter intent)" : "#intent"),
        text: typeof intent === "string" ? intent : resolveAddress(text, ["intent"]).text});
    } catch (error) { unknowns.push(source.path + ": original intent unavailable: " + String(error)); }
  }
  const teaching: Array<Component & { address: string; text: string }> = [];
  if (selected && !selectionInvalid) {
    try {
      if (!catalog || !catalogSource) throw Error("Selected SDLC catalog is missing; no fallback catalog chosen.");
      catalog = mapping(catalog, catalogSource + "#sdlc.catalog");
      const {ref, headerPath} = parseAddress(string(catalog.address, catalogSource + "#sdlc.catalog.address"));
      if (catalog.root !== undefined && catalog.root !== "repository") throw Error("Unknown SDLC catalog root: " + String(catalog.root));
      if (catalog.root === "repository") {
        const repository = execFileSync("git", ["-C", dirname(catalogSource), "rev-parse", "--show-toplevel"], {encoding:"utf8", stdio:["ignore","pipe","pipe"], timeout:2000}).trim();
        catalogPath = resolve(repository, ref);
      } else if (ref.startsWith("$OPENRIG_HOME/")) {
        if (!process.env.OPENRIG_HOME) throw Error("OPENRIG_HOME is unavailable for " + ref);
        catalogPath = join(process.env.OPENRIG_HOME, ref.slice("$OPENRIG_HOME/".length));
      } else if (isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("../")) {
        catalogPath = resolve(dirname(catalogSource), ref);
      } else {
        // Existing library owns pack refs. Unmatched refs are paths relative
        // to the declaring manifest, never daemon cwd.
        const entry = input.library?.list().filter(e => ref.startsWith(e.relativePath + "/")).sort((a,b) => b.relativePath.length - a.relativePath.length)[0];
        if (entry) {
          const file = ref.slice(entry.relativePath.length + 1);
          if (!entry.files.some(f => f.path === file)) throw Error(ref + ": file is not declared by the context pack");
          catalogPath = input.library!.resolveFileWithinPack(entry, file);
        } else catalogPath = resolve(dirname(catalogSource), ref);
      }
      catalogPath = realpathSync(catalogPath);
      const text = readFileSync(catalogPath, "utf8"); catalogHash = hash(text);
      // Preserve prose verbatim; only address uniqueness matters to this reader.
      resolveAddress(text, headerPath);
      const sections = parseMarkdownSections(text).filter(s => headerPath.every((p,i) => s.headerPath[i] === p));
      for (const c of components) {
        const candidates = sections.filter(s => slugifyHeader(s.title) === slugifyHeader(c.id));
        if (candidates.length !== 1) { unknowns.push(catalog.address + ": component " + c.id + " missing or ambiguous"); continue; }
        const section = candidates[0]!;
        teaching.push({...c, address: catalogPath + "#" + section.headerPath.join("/"), text: section.text});
      }
    } catch (error) { unknowns.push("SDLC catalog unavailable: " + String(error)); }
  }
  const owned = teaching.filter(c => c.owner === input.ownerSession);
  const relevant = input.component ? teaching.filter(c => c.id === input.component) : owned;
  if (input.component && !relevant.length) unknowns.push("Requested component is not available in the effective selection: " + input.component);
  const expanded = input.full ? (input.component ? relevant : (owned.length ? owned : teaching)) : (input.component ? relevant : owned.length ? owned : teaching).slice(0,1);
  const position = "UNKNOWN: component position is not authored. Exact owner matches establish relevance, not a stage; choose from selected components and explicit edges using current evidence. Array order is presentation only.";
  const blocks = [
    ...unknowns.map(u => "UNKNOWN: " + u),
    selected ? "Selected SDLC advice from " + selectionSource + "; catalog from " + catalogSource + ": " + catalog?.address : "No SDLC composition selected in the available authored context.",
    ...(selected ? ["Current authored advice; component prose is not an adopted executable snapshot. Binding status: " + sources.map(s => s.kind + "=" + s.binding).join(", ") + ". Inspect/adopt YAML changes with rig workflow revise " + quote(input.instanceId) + ".", "Original story:", ...stories.map(s => s.address + "\n" + s.text),
      position,
      "Selected components" + (components.length > 20 && !input.full ? " (first 20 of " + components.length + ")" : "") + ": " + (input.full ? components : components.slice(0,20)).map(c => c.id + (c.owner ? " owner=" + c.owner : " owner=unknown") + (c.admission ? " admission=" + c.admission : "")).join("; "),
      ...(expanded.length ? expanded.map(c => "Selected teaching preview " + c.id + (input.component ? " (explicit component choice), " : owned.length ? " (owner match; not process position), " : " (menu preview; owner relevance unknown), ") + c.address + "\n" + c.text) : ["No exact owner match for " + (input.ownerSession ?? "unknown owner") + "; choose a selected component explicitly to expand."]),
      "Authored edges: " + (edges.length ? (input.full ? edges : edges.slice(0,20)).map(e => e.from + " -> " + e.to + (e.when ? " when " + e.when : "")).join("; ") : "none; do not infer dependencies"),
      "Selection sources: " + sources.map(s => s.path + " sha256=" + s.sha256 + " " + s.binding).join("; "),
      "Referenced teaching: " + catalogPath + " sha256=" + catalogHash + ". Current authored advice, not a bound executable snapshot. YAML edits require inspection/adoption with rig workflow revise " + quote(input.instanceId) + "; catalog prose refreshes on read and does not revise the graph."] : []),
  ];
  // Omit whole blocks, never cut a Stop/Skip caveat into a misleading fragment.
  const lines: string[] = []; let omitted = false, size = 0;
  for (const block of blocks) {
    const rendered = block.split("\n").map(line => "Workflow method: " + line);
    if (!input.full && size + rendered.join("\n").length > 5600) { omitted = true; continue; }
    lines.push(...rendered); size += rendered.join("\n").length;
  }
  const expansionCommand = command + " --full" + (input.component ? " --component " + quote(input.component) : "");
  lines.push("Workflow method: " + (omitted ? "Some complete blocks omitted by the compact budget. " : "") + "Expand relevant teaching: " + expansionCommand + "; select another with --component <id>. Read authored caveats and edges before adapting; advice grants no extra assignment.");
  return {state: unknowns.length ? "unknown" : selected ? "selected" : "unselected", selectionSource, catalogSource, catalogPath, catalogHash,
    sources, position, ownerSession: input.ownerSession ?? null, unknowns, expansionCommand, lines,
    ...(input.full ? {stories, components, edges, teaching: expanded} : {})};
}
