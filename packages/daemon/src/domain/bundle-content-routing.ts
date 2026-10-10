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
import { parse as parseYaml } from "yaml";
import { registerBundleProject, type ProjectRegistrationResult } from "./workspace/project-registration.js";

/**
 * Routes the primitives a .rigbundle declares (skills, plugins, workflow
 * specs, context packs, agent images) into the operator's libraries.
 *
 * Bootstrap runs this in the pre-launch hook, after the rig record exists and
 * before any seat launches, so a seat's first turn can already see what the
 * bundle carried. It never throws: each kind is routed independently and a
 * failure is recorded in `routingFailures` rather than hidden.
 */

export type BundleContentKind = "bundle" | "skills" | "plugins" | "workflowSpecs" | "contextPacks" | "agentImages" | "project";

export interface BundleContentRouting {
  skillsRouting?: RouteSkillsResult;
  pluginsRouting?: RoutePluginsResult;
  workflowSpecsRouting?: RouteWorkflowSpecsResult;
  contextPacksRouting?: RouteContextPacksResult;
  agentImagesRouting?: RouteAgentImagesResult;
  /** The bundle's project in the workspace catalog, and this rig's association with it. */
  projectRegistration?: ProjectRegistrationResult;
  routingFailures?: Array<{ kind: BundleContentKind; error: string }>;
}

export interface BundleContentRoutingOptions {
  /** Called after context packs were routed, so the live library can rescan them. Returns the scan's per-pack errors. */
  onContextPacksRouted?: () => { errors?: Array<{ source: string; error: string }> } | void;
}

/** The message of anything thrown or rejected, including values that are not Errors (null, undefined, strings). */
export function thrownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      failures.push({ kind, error: thrownMessage(err) });
      return undefined;
    }
  };

  let tmpDir: string | null = null;
  try {
    const bundleRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-content-route-"));
    tmpDir = bundleRoot;
    let manifest: Record<string, unknown> | null = null;
    try {
      await unpack(bundlePath, bundleRoot);
      const manifestPath = nodePath.join(bundleRoot, "bundle.yaml");
      if (fs.existsSync(manifestPath)) {
        manifest = parsePodBundleManifest(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      }
    } catch (err) {
      failures.push({ kind: "bundle", error: thrownMessage(err) });
    }

    if (manifest) {
      // Legacy declared skill files go to the package cache. S04 keeps this
      // package-shaped payload out of the managed skill catalog; importing a
      // complete harness skill into the catalog is a separate action.
      const declaredSkills = stringEntries(manifest["skills"]);
      if (declaredSkills.length > 0) {
        routing.skillsRouting = attempt("skills", () => routeSkills(
          { bundleRoot, declaredSkills, targetSkillsDir: getDefaultOpenRigPath("packages"), targetPrefixToStrip: "packages/" },
          skillsRouterFsOps(),
        ));
      }

      const declaredPlugins = pluginEntries(manifest["plugins"]);
      if (declaredPlugins.length > 0) {
        routing.pluginsRouting = attempt("plugins", () => routePlugins(
          { bundleRoot, declaredPlugins, targetPluginsDir: getDefaultOpenRigPath("plugins") },
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
            { bundleRoot, declaredWorkflowSpecs, targetWorkflowSpecsDir: nodePath.join(workspaceSpecsRoot, "workflows") },
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
            bundleRoot,
            declaredContextPacks,
            targetContextPacksDir: new SettingsStore().resolveOne("context.root").value as string,
          },
          contextPacksRouterFsOps(),
        ));
        if (routing.contextPacksRouting && opts.onContextPacksRouted) {
          const rescan = opts.onContextPacksRouted;
          const scan = attempt("contextPacks", () => rescan()) as { errors?: Array<{ source: string; error: string }> } | undefined;
          // A pack the live library rejects (for example a manifest without a version) is not usable,
          // whatever the copy said: report the library's diagnostic for each pack routed here.
          const routedDirs = routing.contextPacksRouting.records
            .filter((r) => r.status === "routed" && r.installedAt)
            .map((r) => r.installedAt!);
          for (const scanError of scan?.errors ?? []) {
            if (routedDirs.some((dir) => scanError.source === dir || scanError.source.startsWith(dir + nodePath.sep))) {
              failures.push({ kind: "contextPacks", error: `the context-pack library could not load ${scanError.source}: ${scanError.error}` });
            }
          }
        }
      }

      // The project this rig works in: registered in the workspace catalog with
      // this rig associated, so work-install resolves it at the first turn.
      const project = manifest["project"];
      if (project && typeof project === "object" && !Array.isArray(project)) {
        const { id, path: projectPath } = project as { id?: unknown; path?: unknown };
        attempt("project", () => {
          if (typeof id !== "string" || typeof projectPath !== "string") throw new Error("bundle project entry needs an id and a path");
          const rigSpec = parseYaml(fs.readFileSync(nodePath.join(bundleRoot, String(manifest!["rig_spec"])), "utf-8")) as { name?: unknown };
          if (typeof rigSpec?.name !== "string") throw new Error("bundle rig spec has no name");
          const settings = new SettingsStore();
          const result = registerBundleProject({
            bundleProjectDir: nodePath.join(bundleRoot, projectPath),
            projectId: id,
            rigName: rigSpec.name,
            projectsRoot: settings.resolveOne("workspace.projects_root").value as string,
            workspaceRoot: settings.resolveOne("workspace.root").value as string,
            catalogPath: settings.resolveOne("workspace.catalog_path").value as string,
          });
          routing.projectRegistration = result;
          if (result.status === "conflict") failures.push({ kind: "project", error: result.detail ?? "project registration conflict" });
        });
      }

      // Agent images are image DIRECTORIES under <openrigHome>/agent-images,
      // the root the live AgentImageLibraryService reads.
      const declaredAgentImages = stringEntries(manifest["agent_images"]);
      if (declaredAgentImages.length > 0) {
        routing.agentImagesRouting = attempt("agentImages", () => routeAgentImages(
          { bundleRoot, declaredAgentImages, targetAgentImagesDir: getDefaultOpenRigPath("agent-images") },
          agentImagesRouterFsOps(),
        ));
      }
    }
  } catch (err) {
    failures.push({ kind: "bundle", error: thrownMessage(err) });
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* a leftover temp directory is not a routing failure */ }
    }
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
