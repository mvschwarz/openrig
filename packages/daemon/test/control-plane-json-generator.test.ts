import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("control-plane JSON generator", () => {
  it("exposes the daemon-workspace generation command without a root YAML dependency", () => {
    const daemonPackage = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/daemon/package.json"), "utf8"),
    );
    const rootPackage = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );

    expect(daemonPackage.scripts["gen:control-plane-json"]).toBe(
      "node scripts/gen-control-plane-json.mjs",
    );
    expect(daemonPackage.dependencies.yaml).toBeTruthy();
    expect(rootPackage.dependencies?.yaml).toBeUndefined();
    expect(rootPackage.devDependencies?.yaml).toBeUndefined();
  });

  it("parses canon YAML and emits deterministic JSON plus edge digests", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    const conventions = join(root, "conventions");
    const output = join(root, "scripts");

    const membershipPath = join(conventions, "product-public-skills.yaml");
    const denylistPath = join(conventions, "internal-tokens.yaml");
    const layoutPath = join(conventions, "skill-edge-layout.yaml");
    write(
      membershipPath,
      [
        "version: 0",
        "provisional: true",
        "owner: pm-lead@example",
        "product_public:",
        "  clean: [alpha]",
        "  ship_after_fix: [beta]",
        "  ship_misses_add: []",
        "  sanitize_borderlines_ship: []",
        "vendored_ship_with_provenance: []",
        "not_public:",
        "  reclass_host_only: [private]",
        "pending_author_public: [future]",
        "",
      ].join("\n"),
    );
    write(
      denylistPath,
      [
        "version: 1",
        "path_prefixes: [openrig-work/]",
        "seat_and_rig_patterns: ['operator-agent@']",
        "host_patterns: [mm2-]",
        "charged_terms: [founder]",
        "frontmatter_drop_keys: [source_evidence]",
        "internal_path_globs: ['*.internal.*', '**/internal/**', '*-internal/**']",
        "section_fence:",
        "  begin: '<!-- internal:begin -->'",
        "  end: '<!-- internal:end -->'",
        "allowed_context_substrings: [do not ship]",
        "",
      ].join("\n"),
    );
    write(layoutPath, layoutYaml());
    seedEdges(root);

    await generator.generateControlPlaneJson({
      repoRoot: root,
      membershipPath,
      denylistPath,
      layoutPath,
      outputDir: output,
    });
    const first = readGenerated(output);
    await generator.generateControlPlaneJson({
      repoRoot: root,
      membershipPath,
      denylistPath,
      layoutPath,
      outputDir: output,
    });
    const second = readGenerated(output);

    expect(second).toEqual(first);
    expect(first.membership.product_public.clean).toEqual(["alpha"]);
    expect(first.membership.not_public.reclass_host_only).toEqual(["private"]);
    expect(first.denylist.section_fence.begin).toBe("<!-- internal:begin -->");
    expect(first.layout.skills.alpha).toEqual({
      edges: ["canonical", "plugin", "spec"],
      category: "core",
    });
    expect(first.layout.skills.pluginOnly).toEqual({
      edges: ["plugin"],
      category: null,
    });
    expect(first.digests.edges.plugin["alpha/SKILL.md"]).toBe(
      sha256("# Plugin alpha\n"),
    );
  });

  it("exact-tree extraction ignores illustrative layout and applies only forward_overrides", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    seedEdges(root);

    const config = {
      version: 0,
      owner: "skills-architect@example",
      edges: {
        spec: {
          path: "packages/daemon/specs/agents/shared/skills",
          layout: "categorized",
        },
        canonical: {
          path: "skills/_canonical",
          layout: "mirror-of-spec",
        },
        plugin: {
          path: "packages/daemon/assets/plugins/openrig-core/skills",
          layout: "flat",
        },
      },
      extract_from_committed_trees: true,
      forward_overrides: {
        future: { edges: ["spec", "plugin"], category: "process" },
      },
      reference_layout_da101b29: {
        spec_categorized: { pm: ["alpha"], core: ["stale-only"] },
        plugin_flat: ["stale-only"],
      },
    };

    const layout = await generator.extractSkillEdgeLayout({
      repoRoot: root,
      config,
    });

    expect(layout.skills.alpha).toEqual({
      edges: ["canonical", "plugin", "spec"],
      category: "core",
    });
    expect(layout.skills["stale-only"]).toBeUndefined();
    expect(layout.skills.future).toEqual({
      edges: ["plugin", "spec"],
      category: "process",
    });
  });

  it("rejects malformed forward overrides with the source path and reason", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    seedEdges(root);

    await expect(
      generator.extractSkillEdgeLayout({
        repoRoot: root,
        sourcePath: "/canon/conventions/skill-edge-layout.yaml",
        config: {
          version: 0,
          edges: edgeConfig(),
          extract_from_committed_trees: true,
          forward_overrides: {
            broken: { edges: ["spec"], category: "not-a-category" },
          },
        },
      }),
    ).rejects.toThrow(
      /skill-edge-layout\.yaml.*broken.*category|broken.*category.*skill-edge-layout\.yaml/i,
    );
  });

  it("fails closed on malformed membership and denylist schemas with source paths", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    const conventions = join(root, "conventions");
    const output = join(root, "scripts");
    const membershipPath = join(conventions, "product-public-skills.yaml");
    const denylistPath = join(conventions, "internal-tokens.yaml");
    const layoutPath = join(conventions, "skill-edge-layout.yaml");
    write(layoutPath, layoutYaml());
    seedEdges(root);

    write(membershipPath, "version: 0\nowner: pm\n");
    write(
      denylistPath,
      "version: 1\npath_prefixes: []\nseat_and_rig_patterns: []\nhost_patterns: []\ncharged_terms: []\nfrontmatter_drop_keys: []\ninternal_path_globs: []\nsection_fence: {begin: a, end: b}\nallowed_context_substrings: []\n",
    );
    await expect(
      generator.generateControlPlaneJson({
        repoRoot: root,
        membershipPath,
        denylistPath,
        layoutPath,
        outputDir: output,
      }),
    ).rejects.toThrow(/product-public-skills\.yaml.*product_public|product_public.*product-public-skills\.yaml/i);

    write(
      membershipPath,
      "version: 0\nproduct_public: {clean: [], ship_after_fix: [], ship_misses_add: [], sanitize_borderlines_ship: []}\nvendored_ship_with_provenance: []\nnot_public: {}\npending_author_public: []\n",
    );
    write(denylistPath, "version: 1\ncharged_terms: not-an-array\n");
    await expect(
      generator.generateControlPlaneJson({
        repoRoot: root,
        membershipPath,
        denylistPath,
        layoutPath,
        outputDir: output,
      }),
    ).rejects.toThrow(/internal-tokens\.yaml.*charged_terms|charged_terms.*internal-tokens\.yaml/i);
  });

  it("rejects edge file symlinks before digesting outside-root bytes", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    const input = seedGeneratorInput(root);
    seedEdges(root);
    const outside = join(root, "outside-file.txt");
    write(outside, "outside edge bytes\n");
    const link = join(
      root,
      "packages/daemon/assets/plugins/openrig-core/skills/alpha/references/linked.txt",
    );
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, "file");

    await expect(
      generator.generateControlPlaneJson(input),
    ).rejects.toThrow(/symlink.*linked\.txt|linked\.txt.*symlink/i);
    expect(
      existsSync(join(input.outputDir, "skill-edge-digests.generated.json")),
    ).toBe(false);
  });

  it("rejects edge directory symlinks before traversal or digesting outside-root bytes", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    const input = seedGeneratorInput(root);
    seedEdges(root);
    const outside = join(root, "outside-directory");
    write(join(outside, "secret.txt"), "outside directory bytes\n");
    const link = join(
      root,
      "skills/_canonical/core/alpha/references/linked-directory",
    );
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, "dir");

    await expect(
      generator.generateControlPlaneJson(input),
    ).rejects.toThrow(/symlink.*linked-directory|linked-directory.*symlink/i);
    expect(
      existsSync(join(input.outputDir, "skill-edge-digests.generated.json")),
    ).toBe(false);
  });
});

async function loadGenerator(): Promise<Record<string, any>> {
  const url = pathToFileURL(
    join(REPO_ROOT, "packages/daemon/scripts/gen-control-plane-json.mjs"),
  ).href;
  const loaded = await import(url).catch(() => null);
  expect(loaded, "daemon control-plane JSON generator must exist").not.toBeNull();
  expect(typeof loaded?.generateControlPlaneJson).toBe("function");
  expect(typeof loaded?.extractSkillEdgeLayout).toBe("function");
  return loaded as Record<string, any>;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openrig-control-json-red-"));
  roots.push(root);
  return root;
}

function seedEdges(root: string): void {
  write(
    join(
      root,
      "packages/daemon/specs/agents/shared/skills/core/alpha/SKILL.md",
    ),
    "# Spec alpha\n",
  );
  write(
    join(root, "skills/_canonical/core/alpha/SKILL.md"),
    "# Spec alpha\n",
  );
  write(
    join(
      root,
      "packages/daemon/assets/plugins/openrig-core/skills/alpha/SKILL.md",
    ),
    "# Plugin alpha\n",
  );
  write(
    join(
      root,
      "packages/daemon/assets/plugins/openrig-core/skills/pluginOnly/SKILL.md",
    ),
    "# Plugin only\n",
  );
}

function seedGeneratorInput(root: string): {
  repoRoot: string;
  membershipPath: string;
  denylistPath: string;
  layoutPath: string;
  outputDir: string;
} {
  const conventions = join(root, "conventions");
  const membershipPath = join(conventions, "product-public-skills.yaml");
  const denylistPath = join(conventions, "internal-tokens.yaml");
  const layoutPath = join(conventions, "skill-edge-layout.yaml");
  write(
    membershipPath,
    "version: 0\nproduct_public: {clean: [alpha], ship_after_fix: [], ship_misses_add: [], sanitize_borderlines_ship: []}\nvendored_ship_with_provenance: []\nnot_public: {}\npending_author_public: []\n",
  );
  write(
    denylistPath,
    "version: 1\npath_prefixes: []\nseat_and_rig_patterns: []\nhost_patterns: []\ncharged_terms: []\nfrontmatter_drop_keys: []\ninternal_path_globs: []\nsection_fence: {begin: '<!-- internal:begin -->', end: '<!-- internal:end -->'}\nallowed_context_substrings: []\n",
  );
  write(layoutPath, layoutYaml());
  return {
    repoRoot: root,
    membershipPath,
    denylistPath,
    layoutPath,
    outputDir: join(root, "scripts"),
  };
}

function layoutYaml(): string {
  return [
    "version: 0",
    "owner: skills-architect@example",
    "edges:",
    "  spec:",
    "    path: packages/daemon/specs/agents/shared/skills",
    "    layout: categorized",
    "  canonical:",
    "    path: skills/_canonical",
    "    layout: mirror-of-spec",
    "  plugin:",
    "    path: packages/daemon/assets/plugins/openrig-core/skills",
    "    layout: flat",
    "extract_from_committed_trees: true",
    "forward_overrides: {}",
    "reference_layout_da101b29:",
    "  spec_categorized:",
    "    pm: [alpha]",
    "    core: [stale-only]",
    "  plugin_flat: [stale-only]",
    "",
  ].join("\n");
}

function edgeConfig(): Record<string, unknown> {
  return {
    spec: {
      path: "packages/daemon/specs/agents/shared/skills",
      layout: "categorized",
    },
    canonical: {
      path: "skills/_canonical",
      layout: "mirror-of-spec",
    },
    plugin: {
      path: "packages/daemon/assets/plugins/openrig-core/skills",
      layout: "flat",
    },
  };
}

function readGenerated(output: string): Record<string, any> {
  return {
    membership: readJson(join(output, "product-public-skills.generated.json")),
    denylist: readJson(join(output, "internal-tokens.generated.json")),
    layout: readJson(join(output, "skill-edge-layout.generated.json")),
    digests: readJson(join(output, "skill-edge-digests.generated.json")),
  };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
