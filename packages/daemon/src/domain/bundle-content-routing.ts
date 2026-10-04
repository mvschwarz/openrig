import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { unpack } from "./bundle-archive.js";
import { parsePodBundleManifest } from "./bundle-types.js";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { routeSkills, type SkillsRouterFsOps, type RouteSkillsResult } from "./bundle-skills-router.js";
import { routePlugins, type PluginsRouterFsOps, type RoutePluginsResult, type PluginRoutingInput } from "./bundle-plugins-router.js";
import { routeWorkflowSpecs, type WorkflowSpecsRouterFsOps, type RouteWorkflowSpecsResult } from "./bundle-workflow-specs-router.js";
import { routeContextPacks, type ContextPacksRouterFsOps, type RouteContextPacksResult } from "./bundle-context-packs-router.js";
import { routeAgentImages, type AgentImagesRouterFsOps, type RouteAgentImagesResult } from "./bundle-agent-images-router.js";
import { SettingsStore } from "./user-settings/settings-store.js";

/**
 * Routes the primitives a .rigbundle declares (skills, plugins, workflow
 * specs, context packs, agent images) into the operator's libraries.
 *
 * Bootstrap runs this in the pre-launch hook, after the rig record exists and
 * before any seat launches, so a seat's first turn can already see what the
 * bundle carried. It never throws: each kind is routed independently and a
 * failure is recorded in `routingFailures` rather than hidden.
 */

export type BundleContentKind = "bundle" | "skills" | "plugins" | "workflowSpecs" | "contextPacks" | "agentImages";

export interface BundleContentRouting {
  skillsRouting?: RouteSkillsResult;
  pluginsRouting?: RoutePluginsResult;
  workflowSpecsRouting?: RouteWorkflowSpecsResult;
  contextPacksRouting?: RouteContextPacksResult;
  agentImagesRouting?: RouteAgentImagesResult;
  routingFailures?: Array<{ kind: BundleContentKind; error: string }>;
}

export interface BundleContentRoutingOptions {
  /** Called after context packs were routed, so the live library can rescan them. */
  onContextPacksRouted?: () => void;
}

/** One human-readable warning per routing failure, for the result's warnings list. */
export function routingFailureWarnings(routing: BundleContentRouting | undefined): string[] {
  return (routing?.routingFailures ?? []).map((f) => `Bundle ${f.kind} routing failed: ${f.error}`);
}

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string" && s.length > 0);
}

function pluginEntries(value: unknown): PluginRoutingInput[] {
  if (!Array.isArray(value)) return [];
  const declared: PluginRoutingInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const p = entry as Record<string, unknown>;
    const s = p["source"];
    if (typeof p["id"] !== "string" || !p["id"]) continue;
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const src = s as Record<string, unknown>;
    if (src["kind"] !== "local" || typeof src["path"] !== "string" || !src["path"]) continue;
    declared.push({ id: p["id"], source: { kind: "local", path: src["path"] } });
  }
  return declared;
}

/**
 * Extract the bundle once through the banked unpack trust boundary, then route
 * every declared kind. A kind the bundle does not declare is left out of the
 * result.
 */
export async function routeBundleContents(
  bundlePath: string,
  opts: BundleContentRoutingOptions = {},
): Promise<BundleContentRouting> {
  const routing: BundleContentRouting = {};
  const failures: Array<{ kind: BundleContentKind; error: string }> = [];
  const attempt = <T>(kind: BundleContentKind, run: () => T): T | undefined => {
    try {
      return run();
    } catch (err) {
      failures.push({ kind, error: (err as Error).message });
      return undefined;
    }
  };

  const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-content-route-"));
  try {
    let manifest: Record<string, unknown> | null = null;
    try {
      await unpack(bundlePath, tmpDir);
      const manifestPath = nodePath.join(tmpDir, "bundle.yaml");
      if (fs.existsSync(manifestPath)) {
        manifest = parsePodBundleManifest(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      }
    } catch (err) {
      failures.push({ kind: "bundle", error: (err as Error).message });
    }

    if (manifest) {
      // Legacy declared skill files go to the package cache. S04 keeps this
      // package-shaped payload out of the managed skill catalog; importing a
      // complete harness skill into the catalog is a separate action.
      const declaredSkills = stringEntries(manifest["skills"]);
      if (declaredSkills.length > 0) {
        routing.skillsRouting = attempt("skills", () => routeSkills(
          { bundleRoot: tmpDir, declaredSkills, targetSkillsDir: getDefaultOpenRigPath("packages"), targetPrefixToStrip: "packages/" },
          skillsRouterFsOps(),
        ));
      }

      const declaredPlugins = pluginEntries(manifest["plugins"]);
      if (declaredPlugins.length > 0) {
        routing.pluginsRouting = attempt("plugins", () => routePlugins(
          { bundleRoot: tmpDir, declaredPlugins, targetPluginsDir: getDefaultOpenRigPath("plugins") },
          pluginsRouterFsOps(),
        ));
      }

      // Workflow specs go to <workspace specs root>/workflows, the path the
      // spec-library workflow scanner reads. SettingsStore is the sole
      // authority (see bundle-workflow-specs-router.ts).
      const declaredWorkflowSpecs = stringEntries(manifest["workflow_specs"]);
      if (declaredWorkflowSpecs.length > 0) {
        routing.workflowSpecsRouting = attempt("workflowSpecs", () => {
          const workspaceSpecsRoot = new SettingsStore().resolveConfig().workspaceSpecsRoot;
          if (!workspaceSpecsRoot) throw new Error("workspace specs root is not configured");
          return routeWorkflowSpecs(
            { bundleRoot: tmpDir, declaredWorkflowSpecs, targetWorkflowSpecsDir: nodePath.join(workspaceSpecsRoot, "workflows") },
            workflowSpecsRouterFsOps(),
          );
        });
      }

      // Context packs go to context.root, exactly like the live
      // ContextPackLibraryService. A configured root replaces the default;
      // bundle routing must not silently create a second writable library.
      const declaredContextPacks = stringEntries(manifest["context_packs"]);
      if (declaredContextPacks.length > 0) {
        routing.contextPacksRouting = attempt("contextPacks", () => routeContextPacks(
          {
            bundleRoot: tmpDir,
            declaredContextPacks,
            targetContextPacksDir: new SettingsStore().resolveOne("context.root").value as string,
          },
          contextPacksRouterFsOps(),
        ));
        if (routing.contextPacksRouting && opts.onContextPacksRouted) {
          const rescan = opts.onContextPacksRouted;
          attempt("contextPacks", () => rescan());
        }
      }

      // Agent images are image DIRECTORIES under <openrigHome>/agent-images,
      // the root the live AgentImageLibraryService reads.
      const declaredAgentImages = stringEntries(manifest["agent_images"]);
      if (declaredAgentImages.length > 0) {
        routing.agentImagesRouting = attempt("agentImages", () => routeAgentImages(
          { bundleRoot: tmpDir, declaredAgentImages, targetAgentImagesDir: getDefaultOpenRigPath("agent-images") },
          agentImagesRouterFsOps(),
        ));
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures.length > 0) routing.routingFailures = failures;
  return routing;
}

function skillsRouterFsOps(): SkillsRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    copyFile: (s, d) => fs.copyFileSync(s, d),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

function pluginsRouterFsOps(): PluginsRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

function workflowSpecsRouterFsOps(): WorkflowSpecsRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    copyFile: (s, d) => fs.copyFileSync(s, d),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  };
}

function contextPacksRouterFsOps(): ContextPacksRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    readFile: (p) => fs.readFileSync(p, "utf8"),
    listFiles: (dir) => {
      const files: string[] = [];
      const walk = (current: string, prefix: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const child = nodePath.join(current, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(child, relativePath);
          else if (entry.isFile()) files.push(relativePath);
        }
      };
      walk(dir, "");
      return files;
    },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

function agentImagesRouterFsOps(): AgentImagesRouterFsOps {
  return {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}
