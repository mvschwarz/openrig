import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { authoredMapping, readDeclaredConfigurations, resolveConfiguration } from "./bundle-configuration.js";
import { authoredCompatibility } from "./bundle-source.js";

interface Check {
  ruleId: string;
  status: "pass" | "finding" | "not_checked";
  reason: string;
  path?: string;
}

/** Advisory filesystem reads only. No daemon, bundler, preflight, provider or launch. */
export async function checkBundleFolder(folder: string) {
  const { validateRigSpecImport, validateAgentSpecFromYaml, isSensitivePath } = await import("@openrig/daemon/spec-validation");
  const checks: Check[] = [];
  const add = (ruleId: string, status: Check["status"], reason: string, file?: string) => checks.push({ ruleId, status, reason, ...(file ? { path: file } : {}) });
  const result = { standardVersion: "openrig.bundle-standard/v1", checks };
  const withoutRig = () => {
    for (const rule of ["readme_in_docs", "readme_coverage", "referenced_files", "portable_agents", "minimum_versions", "configurations", "credential_paths", "embedded_secrets"]) add(rule, "not_checked", "Requires a readable, valid pod-aware rig.yaml.");
    return result;
  };
  let root: string;
  let spec: Record<string, unknown>;
  try {
    root = fs.realpathSync(folder);
    const yaml = fs.readFileSync(path.join(root, "rig.yaml"), "utf8");
    spec = parseYaml(yaml) as Record<string, unknown>;
    const valid = validateRigSpecImport(yaml);
    if (!valid.valid || !Array.isArray(spec?.pods)) {
      add("pod_aware_rig", "finding", valid.errors.join("; ") || "The shared bundle standard uses a pod-aware rig.yaml.", "rig.yaml");
      return withoutRig();
    }
    add("pod_aware_rig", "pass", "rig.yaml passes the pod-aware validator.", "rig.yaml");
  } catch {
    add("pod_aware_rig", "finding", "rig.yaml could not be read or parsed.", "rig.yaml");
    return withoutRig();
  }

  const within = (file: string): boolean => {
    const rel = path.relative(root, file);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const fileRead = (relative: string, base = root): string | null => {
    try {
      const full = fs.realpathSync(path.resolve(base, relative));
      if (!within(full)) throw new Error();
      fs.accessSync(full, fs.constants.R_OK);
      return full;
    } catch { add("referenced_files", "finding", "Declared file is missing, unreadable or outside the bundle folder.", path.relative(root, path.resolve(base, relative))); return null; }
  };
  const docs = Array.isArray(spec.docs) ? spec.docs as Array<{ path?: string }> : [];
  const readme = docs.find(doc => typeof doc.path === "string" && /^readme(?:\.md)?$/i.test(path.basename(doc.path)));
  add("readme_in_docs", readme && fileRead(readme.path!) ? "pass" : "finding", readme ? "README must be readable and included through docs." : "Declare the bundle README in rig.yaml docs.");
  add("readme_coverage", "not_checked", "Read the README for purpose, seats, prerequisites, running, permissions, writes, stopping and cleanup; file presence cannot establish its completeness.");
  const beforeReferences = checks.length;
  for (const doc of docs) if (typeof doc.path === "string") fileRead(doc.path);

  // Declared startup/culture file references are mechanical. Inline text is not a file.
  const startupFiles = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) startupFiles(entry); return; }
    for (const [key, v] of Object.entries(value)) {
      if (key === "startup" && v && typeof v === "object") {
        for (const file of (v as { files?: Array<{ path?: string }> }).files ?? []) if (typeof file.path === "string") fileRead(file.path);
      }
      if ((key === "file" || key === "culture_file") && typeof v === "string") fileRead(v);
      else if (typeof v === "object") startupFiles(v);
    }
  };
  startupFiles(spec);

  const visited = new Set<string>();
  let agentFindings = 0;
  const agent = (ref: unknown, from = root): void => {
    if (ref === "builtin:terminal") return;
    if (typeof ref !== "string" || !ref.startsWith("local:") || path.isAbsolute(ref.slice(6))) {
      agentFindings++; add("portable_agents", "finding", "Agent refs and imports must be local paths inside this bundle folder."); return;
    }
    const dir = fileRead(ref.slice(6), from);
    if (!dir) { agentFindings++; return; }
    if (visited.has(dir)) return;
    visited.add(dir);
    try {
      const manifestPath = fileRead("agent.yaml", dir);
      if (!manifestPath) { agentFindings++; return; }
      const yaml = fs.readFileSync(manifestPath, "utf8");
      const valid = validateAgentSpecFromYaml(yaml);
      if (!valid.valid) { agentFindings++; add("portable_agents", "finding", valid.errors.join("; "), path.relative(root, dir)); return; }
      const a = parseYaml(yaml) as { imports?: Array<{ ref?: string }>; resources?: Record<string, unknown> };
      for (const imp of a.imports ?? []) agent(imp.ref, dir);
      for (const entries of Object.values(a.resources ?? {})) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries as Array<{ path?: string; source?: { kind?: string; path?: string } }>) {
          if (typeof entry.path === "string") fileRead(entry.path, dir);
          else if (entry.source?.kind === "local" && typeof entry.source.path === "string") fileRead(entry.source.path, dir);
          else if (entry.source) add("host_resources", "not_checked", "Host-resolved plugin/resource availability is checked at launch, not by this author check.", path.relative(root, dir));
        }
      }
    } catch { agentFindings++; add("portable_agents", "finding", "Agent manifest could not be read or parsed.", path.relative(root, dir)); }
  };
  for (const pod of spec.pods as Array<{ members: Array<{ agent_ref?: string }> }>) for (const member of pod.members) agent(member.agent_ref);
  if (!agentFindings) add("portable_agents", "pass", "Declared agent refs/imports resolve inside this folder and their manifests validate.");
  if (!checks.slice(beforeReferences).some(c => c.ruleId === "referenced_files")) add("referenced_files", "pass", "Declared docs, startup files and agent resource paths checked for readability.");

  try { authoredCompatibility(root); add("minimum_versions", "pass", "Authored minimum versions are absent or correctly shaped."); }
  catch (err) { add("minimum_versions", "finding", (err as Error).message, "bundle.yaml"); }
  try {
    const declared = readDeclaredConfigurations(root);
    if (declared) {
      const authored = authoredMapping(path.join(root, "rig.yaml"));
      if (!declared.presets || !declared.seats || !declared.presets[declared.recommended]) throw new Error("Declare seats, presets and a recommended preset.");
      for (const preset of Object.keys(declared.presets)) resolveConfiguration(declared, authored, { preset });
    }
    add("configurations", "pass", declared ? "Every declared preset resolves against the authored team." : "No alternate configurations declared; the authored team is used.");
  } catch { add("configurations", "finding", "configurations.yaml is unreadable or inconsistent with the authored team.", "configurations.yaml"); }

  let visitedFiles = 0;
  let sensitive = 0;
  try {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (++visitedFiles > 10_000) throw new Error();
        if (entry.name === ".git" || entry.name === "node_modules") continue; // Not bundle content.
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) { add("credential_paths", "not_checked", "Symlink content was not scanned.", path.relative(root, file)); continue; }
        if (entry.isDirectory()) walk(file);
        else if (isSensitivePath(path.relative(root, file))) { sensitive++; add("credential_paths", "finding", "Known sensitive filename; exclude credentials from the published folder.", path.relative(root, file)); }
      }
    };
    walk(root);
    if (!sensitive && !checks.some(c => c.ruleId === "credential_paths")) add("credential_paths", "pass", "No known sensitive filenames in the checked folder (excluding Git metadata/dependencies).");
  } catch { add("credential_paths", "not_checked", "Folder scan was incomplete (unreadable entry or 10,000-entry bound)."); }
  add("embedded_secrets", "not_checked", "Filename checks cannot establish that arbitrary file contents contain no secrets. Review the files before publishing.");
  return result;
}
