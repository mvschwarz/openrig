import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveNodeFile } from "./node-file.js";

/** One authored node in a single project's missions tree. IDs are read, never invented. */
export interface ParentScopeNode {
  id: string;
  name: string;
  kind: "mission" | "slice";
  path: string;
  missionId: string;
  parent: string | null;
  intent: string | null;
  status: string | null;
}

class InvalidScopeDocument extends Error {}

function frontmatter(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const value: unknown = YAML.parse(match[1]!);
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new InvalidScopeDocument(`${file}: frontmatter must be a mapping`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Discover declared missions and slices, including closed slices, under one root. */
export function readParentScope(root: string, options: { strict?: boolean; onInvalid?: (message: string) => void } = {}): ParentScopeNode[] {
  if (!fs.existsSync(root)) return [];
  const nodes: ParentScopeNode[] = [];
  function readDocument<T>(file: string, read: () => T): T | null {
    try { return read(); }
    catch (error) {
      const message = `${file}: ${(error as Error).message}`;
      if (options.strict) throw new Error(message);
      options.onInvalid?.(message);
      return null;
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const missionPath = path.join(root, entry.name), file = resolveNodeFile(missionPath);
    if (!file) continue;
    const fm = readDocument(file, () => frontmatter(file));
    if (!fm) continue;
    const id = stringValue(fm.id ?? fm.dotId);
    if (!id) continue;
    const manifest = path.join(missionPath, "mission.yaml");
    const hasManifest = fs.existsSync(manifest);
    const data: unknown = hasManifest ? readDocument(manifest, () => {
      const value: unknown = YAML.parse(fs.readFileSync(manifest, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidScopeDocument("mission manifest must be a mapping");
      return value;
    }) : null;
    if (hasManifest && data === null) continue;
    const meta = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).metadata : null;
    const metadata = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
    nodes.push({ id, name: entry.name, kind: "mission", path: missionPath, missionId: id,
      parent: stringValue(hasManifest ? metadata.parent : fm.parent), intent: stringValue(fm.intent), status: stringValue(metadata.status ?? fm.status) });
    for (const dir of ["slices", "closed"]) {
      const sliceRoot = path.join(missionPath, dir);
      if (!fs.existsSync(sliceRoot)) continue;
      for (const slice of fs.readdirSync(sliceRoot, { withFileTypes: true })) {
        if (!slice.isDirectory()) continue;
        const slicePath = path.join(sliceRoot, slice.name), nodeFile = resolveNodeFile(slicePath);
        if (!nodeFile) continue;
        const sfm = readDocument(nodeFile, () => frontmatter(nodeFile));
        if (!sfm) continue;
        const sid = stringValue(sfm.id ?? sfm.dotId);
        if (sid) nodes.push({ id: sid, name: slice.name, kind: "slice", path: slicePath, missionId: id,
          parent: null, intent: stringValue(sfm.intent), status: stringValue(sfm.status) });
      }
    }
  }
  return nodes;
}

/** Require an unambiguous node and reject a link that reaches its own mission. */
export function validateMissionParent(nodes: ParentScopeNode[], missionId: string, parentId: string, onWarning?: (message: string) => void): ParentScopeNode {
  const unique = (id: string) => {
    const found = nodes.filter((node) => node.id === id);
    if (found.length !== 1) throw new Error(`Parent scope '${id}' resolves to ${found.length} nodes; it must resolve uniquely.`);
    return found[0]!;
  };
  const parent = unique(parentId);
  const seen = new Set<string>();
  let current: ParentScopeNode | null = parent;
  while (current) {
    let owner: ParentScopeNode;
    try { owner = current.kind === "slice" ? unique(current.missionId) : current; }
    catch (error) { onWarning?.((error as Error).message); break; }
    if (owner.id === missionId || seen.has(owner.id)) { onWarning?.(`Parent '${parentId}' would form or enter a cycle.`); break; }
    seen.add(owner.id);
    try { current = owner.parent ? unique(owner.parent) : null; }
    catch (error) { onWarning?.((error as Error).message); break; }
  }
  return parent;
}
