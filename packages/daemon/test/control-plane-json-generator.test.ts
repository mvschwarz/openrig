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

  it("reads product JSON and preserves authority bytes while refreshing digests", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    const input = seedGeneratorInput(root);
    seedEdges(root);
    const sourcePaths = [input.membershipPath, input.denylistPath, input.layoutPath];
    const sourceBytes = sourcePaths.map((path) => readFileSync(path));

    await generator.generateControlPlaneJson(input);
    const first = readGenerated(input.outputDir);
    await generator.generateControlPlaneJson(input);
    expect(readGenerated(input.outputDir)).toEqual(first);
    expect(sourcePaths.map((path) => readFileSync(path))).toEqual(sourceBytes);
    expect(first.membership.product_public.clean).toEqual(["alpha"]);
    expect(first.denylist.allowed_context_lines).toEqual(["  Generic <path> placeholder"]);
    expect(first.layout.skills.alpha).toEqual({ edges: ["canonical", "plugin", "spec"], category: "core" });
    expect(first.digests.edges.plugin["alpha/SKILL.md"]).toBe(sha256("# Plugin alpha\n"));
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
      edges: ["canonical", "plugin", "spec"],
      category: "process",
    });
  });

  it("projects spec overrides onto the canonical mirror edge", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    seedEdges(root);

    const layout = await generator.extractSkillEdgeLayout({
      repoRoot: root,
      config: {
        version: 0,
        owner: "skills-architect@example",
        edges: edgeConfig(),
        extract_from_committed_trees: true,
        forward_overrides: {
          future: { edges: ["spec"], category: "process" },
        },
      },
    });

    expect(layout.skills.future).toEqual({
      edges: ["canonical", "spec"],
      category: "process",
    });
  });

  it("removes an empty-edge override from the generated product layout", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    seedEdges(root);

    const layout = await generator.extractSkillEdgeLayout({
      repoRoot: root,
      config: {
        version: 0,
        owner: "skills-architect@example",
        edges: edgeConfig(),
        extract_from_committed_trees: true,
        forward_overrides: {
          alpha: { edges: [], category: null },
        },
      },
    });

    expect(layout.skills.alpha).toBeUndefined();
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

  it("reports malformed product policy with its product path", async () => {
    const generator = await loadGenerator();
    const input = seedGeneratorInput(tempRoot());
    const original = readFileSync(input.membershipPath);
    write(input.membershipPath, JSON.stringify({ version: 0 }));
    await expect(generator.generateControlPlaneJson(input)).rejects.toThrow(/product-public-skills\.generated\.json.*product_public/);
    writeFileSync(input.membershipPath, original);
    write(input.denylistPath, JSON.stringify({ charged_terms: "not-an-array" }));
    await expect(generator.generateControlPlaneJson(input)).rejects.toThrow(/internal-tokens\.generated\.json.*charged_terms/);
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

  it("rejects malformed optional exact-line allowances", async () => {
    const generator = await loadGenerator();
    const root = tempRoot();
    const input = seedGeneratorInput(root);
    seedEdges(root);
    const original = JSON.parse(readFileSync(input.denylistPath, "utf8"));
    for (const value of [null, "text", [42], [""], ["two\nlines"], ["two\rlines"]]) {
      write(input.denylistPath, JSON.stringify({ ...original, allowed_context_lines: value }));
      await expect(generator.generateControlPlaneJson(input)).rejects.toThrow(/allowed_context_lines/);
    }
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
  const scripts = join(root, "scripts");
  const membershipPath = join(scripts, "product-public-skills.generated.json");
  const denylistPath = join(scripts, "internal-tokens.generated.json");
  const layoutPath = join(scripts, "skill-edge-layout.generated.json");
  write(membershipPath, JSON.stringify({
    version: 0,
    product_public: { clean: ["alpha"], ship_after_fix: [], ship_misses_add: [], sanitize_borderlines_ship: [] },
    vendored_ship_with_provenance: [], not_public: {}, pending_author_public: [],
  }));
  write(denylistPath, JSON.stringify({
    version: 1, path_prefixes: [], seat_and_rig_patterns: [], host_patterns: [], charged_terms: [],
    frontmatter_drop_keys: [], internal_path_globs: [],
    section_fence: { begin: "<!-- internal:begin -->", end: "<!-- internal:end -->" },
    allowed_context_substrings: [], allowed_context_lines: ["  Generic <path> placeholder"],
  }));
  write(layoutPath, JSON.stringify({
    version: 0, edges: edgeConfig(),
    skills: { alpha: { edges: ["canonical", "plugin", "spec"], category: "core" } },
  }));
  return { repoRoot: root, membershipPath, denylistPath, layoutPath, outputDir: join(root, "export") };
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

it("the committed internal-token mirror covers the whole substrate shared-docs class", () => {
  const generated = readJson(join(REPO_ROOT, "scripts/internal-tokens.generated.json"));
  const legacyPrefix = ["code", "substrate", "shared-docs", ""].join("/");
  expect(generated.path_prefixes).toContain("substrate/shared-docs/");
  expect(generated.path_prefixes).not.toContain(legacyPrefix);
});

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
