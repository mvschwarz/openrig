import nodePath from "node:path";
import { createHash } from "node:crypto";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { serializePodBundleManifest, type PodBundleManifest, type PodBundleAgentEntry, type PodBundleAgentImportEntry } from "./bundle-types.js";
import type { RigSpec, StartupBlock } from "./types.js";

export interface PodAssemblerFsOps extends AgentResolverFsOps {
  mkdirp(path: string): void;
  writeFile(path: string, content: string): void;
  copyDir(src: string, dest: string): void;
  listFiles(dirPath: string): string[];
}

export interface PodAssembleOptions {
  rigRoot: string;
  rigSpecPath: string;
  outputDir: string;
  bundleName: string;
  bundleVersion: string;
}

export interface PodAssembleResult {
  manifest: PodBundleManifest;
  collectedFiles: string[];
}

/**
 * Pod-aware bundle assembler. Walks embedded pod members' agent_ref to
 * collect AgentSpecs and their resources/imports. Produces a self-contained
 * bundle with rewritten refs.
 */
export class PodBundleAssembler {
  private fs: PodAssemblerFsOps;

  constructor(deps: { fsOps: PodAssemblerFsOps }) {
    this.fs = deps.fsOps;
  }

  /**
   * Assemble a pod-aware bundle from a rig spec.
   * @param opts - assembly options
   * @returns manifest and list of collected files
   */
  assemble(opts: PodAssembleOptions): PodAssembleResult {
    // 1. Parse + validate rig spec
    if (!this.fs.exists(opts.rigSpecPath)) {
      throw new Error(`Rig spec not found: ${opts.rigSpecPath}`);
    }
    const rigSpecYaml = this.fs.readFile(opts.rigSpecPath);
    const raw = RigSpecCodec.parse(rigSpecYaml);
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      throw new Error(`Invalid rig spec: ${validation.errors.join("; ")}`);
    }
    const rigSpec = RigSpecSchema.normalize(raw as Record<string, unknown>);

    // 2. Collect all files
    const collectedFiles: string[] = [];
    const agentEntries: PodBundleAgentEntry[] = [];
    const resolvedAgentPaths = new Set<string>();

    // 2a. Rig spec — written after ref rewriting (deferred to step 4)
    this.fs.mkdirp(opts.outputDir);
    collectedFiles.push("rig.yaml");

    // Track ref rewrites: originalRef -> vendored local: ref
    const refRewrites = new Map<string, string>();

    // 2b. Culture file
    if (rigSpec.cultureFile) {
      this.collectRigFile(rigSpec.cultureFile, opts.rigRoot, opts.outputDir, collectedFiles);
    }

    // 2b2. Docs files — required when declared (unlike culture/startup which are optional)
    if (rigSpec.docs) {
      for (const doc of rigSpec.docs) {
        const absPath = nodePath.resolve(opts.rigRoot, doc.path);
        if (!this.fs.exists(absPath)) {
          throw new Error(`Declared doc file not found: ${doc.path} (resolved to ${absPath}). Remove it from the docs field or create the file.`);
        }
        this.collectRigFile(doc.path, opts.rigRoot, opts.outputDir, collectedFiles);
      }
    }

    // 2c. Rig startup files
    this.collectStartupFiles(rigSpec.startup, opts.rigRoot, opts.outputDir, collectedFiles);

    // 2d. Walk pods
    for (const pod of rigSpec.pods) {
      // Pod startup files
      this.collectStartupFiles(pod.startup, opts.rigRoot, opts.outputDir, collectedFiles);

      for (const member of pod.members) {
        // Member startup files
        this.collectStartupFiles(member.startup, opts.rigRoot, opts.outputDir, collectedFiles);

        // Terminal members are bundle-native sentinels, not vendored agents.
        if (member.agentRef === "builtin:terminal") {
          continue;
        }

        // Resolve agent_ref
        const result = resolveAgentRef(member.agentRef, opts.rigRoot, this.fs);
        if (!result.ok) {
          throw new Error(`Failed to resolve agent_ref "${member.agentRef}" for member ${pod.id}.${member.id}: ${result.code === "validation_failed" ? (result as { errors: string[] }).errors.join("; ") : (result as { error: string }).error}`);
        }

        // Dedup: skip if already collected (but still record rewrite)
        const agentVendorPath = `agents/${result.resolved.spec.name}`;
        refRewrites.set(member.agentRef, `local:${agentVendorPath}`);

        if (resolvedAgentPaths.has(result.resolved.sourcePath)) continue;
        resolvedAgentPaths.add(result.resolved.sourcePath);
        this.vendorDirectory(result.resolved.sourcePath, nodePath.join(opts.outputDir, agentVendorPath), collectedFiles, agentVendorPath);

        // Collect import entries — always record provenance, only vendor once
        const importEntries: PodBundleAgentImportEntry[] = [];
        for (const imp of result.imports) {
          const importVendorPath = `agents/${imp.spec.name}`;

          // Vendor files only once (dedup by path), but always record importEntry
          if (!resolvedAgentPaths.has(imp.sourcePath)) {
            resolvedAgentPaths.add(imp.sourcePath);
            this.vendorDirectory(imp.sourcePath, nodePath.join(opts.outputDir, importVendorPath), collectedFiles, importVendorPath);
          }

          importEntries.push({
            name: imp.spec.name,
            version: imp.spec.version,
            path: importVendorPath,
            originalRef: this.findOriginalImportRef(result.resolved.spec, imp.spec.name, result.imports),
            hash: imp.hash,
          });
        }

        // Rewrite vendored agent.yaml import refs to local: vendored paths
        if (result.imports.length > 0) {
          this.rewriteAgentYamlImportRefs(
            nodePath.join(opts.outputDir, agentVendorPath, "agent.yaml"),
            agentVendorPath,
            result.imports.map((imp) => ({
              originalRef: this.findOriginalImportRef(result.resolved.spec, imp.spec.name, result.imports),
              vendoredPath: `agents/${imp.spec.name}`,
            })),
          );
        }

        agentEntries.push({
          name: result.resolved.spec.name,
          version: result.resolved.spec.version,
          path: agentVendorPath,
          originalRef: member.agentRef,
          hash: result.resolved.hash,
          importEntries,
        });
      }
    }

    // 3. Write rewritten rig.yaml with vendored agent_ref values
    const rewrittenRigYaml = this.rewriteRigSpecRefs(rigSpecYaml, refRewrites);
    this.fs.writeFile(nodePath.join(opts.outputDir, "rig.yaml"), rewrittenRigYaml);

    // 4. Build manifest
    const manifest: PodBundleManifest = {
      schemaVersion: 2,
      name: opts.bundleName,
      version: opts.bundleVersion,
      createdAt: new Date().toISOString(),
      rigSpec: "rig.yaml",
      agents: agentEntries,
      cultureFile: rigSpec.cultureFile,
    };

    // Write manifest
    this.fs.writeFile(
      nodePath.join(opts.outputDir, "bundle.yaml"),
      serializePodBundleManifest(manifest),
    );
    collectedFiles.push("bundle.yaml");

    return { manifest, collectedFiles };
  }

  private collectRigFile(relPath: string, rigRoot: string, outputDir: string, collected: string[]): void {
    const absPath = nodePath.resolve(rigRoot, relPath);
    if (!absPath.startsWith(rigRoot)) {
      throw new Error(`Path traversal detected: "${relPath}" escapes rig root`);
    }
    if (!this.fs.exists(absPath)) return; // optional files may not exist
    const content = this.fs.readFile(absPath);
    this.fs.mkdirp(nodePath.dirname(nodePath.join(outputDir, relPath)));
    this.fs.writeFile(nodePath.join(outputDir, relPath), content);
    collected.push(relPath);
  }

  private collectStartupFiles(startup: StartupBlock | undefined, rigRoot: string, outputDir: string, collected: string[]): void {
    if (!startup) return;
    for (const file of startup.files) {
      this.collectRigFile(file.path, rigRoot, outputDir, collected);
    }
  }

  private vendorDirectory(srcDir: string, destDir: string, collected: string[], relPrefix: string): void {
    this.fs.mkdirp(destDir);
    const files = this.fs.listFiles(srcDir);
    for (const file of files) {
      const srcPath = nodePath.join(srcDir, file);
      const destPath = nodePath.join(destDir, file);
      this.fs.mkdirp(nodePath.dirname(destPath));
      const content = this.fs.readFile(srcPath);
      this.fs.writeFile(destPath, content);
      collected.push(nodePath.join(relPrefix, file).replace(/\\/g, "/"));
    }
  }

  private findOriginalImportRef(spec: import("./types.js").AgentSpec, importName: string, resolvedImports: import("./agent-resolver.js").ResolvedAgentSpec[]): string {
    // Match by resolved spec name to original import ref
    for (let i = 0; i < spec.imports.length; i++) {
      if (i < resolvedImports.length && resolvedImports[i]!.spec.name === importName) {
        return spec.imports[i]!.ref;
      }
    }
    return `unknown:${importName}`;
  }

  private rewriteAgentYamlImportRefs(
    vendoredAgentYamlPath: string,
    agentVendorDir: string,
    importMappings: Array<{ originalRef: string; vendoredPath: string }>,
  ): void {
    if (!this.fs.exists(vendoredAgentYamlPath)) return;
    const content = this.fs.readFile(vendoredAgentYamlPath);
    let rewritten = content;
    for (const mapping of importMappings) {
      // Compute relative path from agent dir to vendored import dir
      const rel = nodePath.relative(agentVendorDir, mapping.vendoredPath).replace(/\\/g, "/");
      const localRef = `local:${rel}`;
      // Replace the original ref with the vendored local: ref
      rewritten = rewritten.replace(mapping.originalRef, localRef);
    }
    this.fs.writeFile(vendoredAgentYamlPath, rewritten);
  }

  private rewriteRigSpecRefs(originalYaml: string, refRewrites: Map<string, string>): string {
    // Parse as raw object, rewrite agent_ref values, re-serialize
    const raw = RigSpecCodec.parse(originalYaml) as Record<string, unknown>;
    const pods = raw["pods"] as Array<Record<string, unknown>> | undefined;
    if (pods) {
      for (const pod of pods) {
        const members = pod["members"] as Array<Record<string, unknown>> | undefined;
        if (members) {
          for (const member of members) {
            const originalRef = member["agent_ref"] as string;
            const rewritten = refRewrites.get(originalRef);
            if (rewritten) {
              member["agent_ref"] = rewritten;
            }
          }
        }
      }
    }
    return RigSpecCodec.serialize(RigSpecSchema.normalize(raw as Record<string, unknown>));
  }
}
