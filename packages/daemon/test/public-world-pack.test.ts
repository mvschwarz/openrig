// OPR.0.5.6.11 — the public world is authored prose with a derivation seam:
// real atoms, a claim-to-check ledger, a verifier that can fail or skip loudly,
// and a worked stranger exercise rather than a private-world copy.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { composeProfile } from "../src/domain/context-packs/profile-composer.js";

const DAEMON_ROOT = resolve(import.meta.dirname, "..");
const STATIC_ROOT = resolve(DAEMON_ROOT, "context-packs-src");
const PUBLIC_WORLD_ROOT = resolve(STATIC_ROOT, "world-public");
const temporaryRoots: string[] = [];

function publicWorldDir(): string {
  readFileSync(join(PUBLIC_WORLD_ROOT, "manifest.yaml"));
  return PUBLIC_WORLD_ROOT;
}

function manifestAt(packDir = publicWorldDir()) {
  const path = join(packDir, "manifest.yaml");
  return parseManifest(readFileSync(path, "utf8"), path);
}

function runVerifier(packDir: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("/bin/sh", [join(packDir, "verify-world.sh")], {
    cwd: packDir,
    env,
    encoding: "utf8",
  });
}

function runRig(rigPath: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(join(rigPath, "rig"), args, { env, encoding: "utf8" });
}

function writeRigFixture(options: {
  identityJson?: string;
  topology?: string;
  showStatus?: number;
  listJson?: string;
  configRoot?: string;
  addStatus?: number;
  partialSync?: boolean;
} = {}): string {
  const fixturePath = mkdtempSync(join(tmpdir(), "public-world-rig-"));
  temporaryRoots.push(fixturePath);
  const installState = join(fixturePath, "installed-ref");
  const sourcePath = publicWorldDir();
  const examplePath = join(STATIC_ROOT, "world-example");
  const manifest = manifestAt(sourcePath);
  const profile = composeProfile({
    atoms: manifest.atoms ?? [],
    situation: "fresh",
    runtime: "codex",
    budgetTokens: 0,
    readFile: (ref) => readFileSync(join(sourcePath, ref), "utf8"),
  });
  const showJson = JSON.stringify({
    relativePath: "world-public",
    sourceType: "builtin",
    sourcePath,
    derivedEstimatedTokens: profile.totalEstimatedTokens,
  });
  const listJson = options.listJson ?? JSON.stringify([
    { relativePath: "world-public", sourceType: "builtin", sourcePath },
    { relativePath: "world/install", sourceType: "user_file", sourcePath: "/fixture/private-world" },
  ]);
  const configRoot = options.configRoot === undefined
    ? '"${OPENRIG_CONTEXT_PACKS_ROOT:-/fixture/context-packs}"'
    : `'${options.configRoot}'`;
  writeFileSync(
    join(fixturePath, "world-public-get.txt"),
    manifest.files.map((file) => readFileSync(join(sourcePath, file.path), "utf8")).join("\n"),
  );
  writeFileSync(join(fixturePath, "world-public-profile.json"), JSON.stringify(profile));
  writeFileSync(
    join(fixturePath, "world-public-profile.txt"),
    profile.pieces.map((piece) => piece.text).join("\n"),
  );
  writeFileSync(join(fixturePath, "world-example-get.txt"), readFileSync(join(examplePath, "your-world.md"), "utf8"));
  writeFileSync(join(fixturePath, "world-public-show.json"), showJson);
  writeFileSync(join(fixturePath, "context-list.json"), listJson);
  writeFileSync(join(fixturePath, "rig"), [
    "#!/bin/sh",
    `fixture_dir=${JSON.stringify(fixturePath)}`,
    `install_state=${JSON.stringify(installState)}`,
    'if [ "$#" -eq 1 ] && [ "$1" = "--help" ]; then',
    "  exit 0",
    'elif [ "$1" = "context" ] && [ "$3" = "--help" ]; then',
    "  exit 0",
    'elif [ "$1" = "context" ] && [ "$2" = "show" ] && [ "$3" = "world-public" ]; then',
    '  cat "$fixture_dir/world-public-show.json"',
    `  exit ${options.showStatus ?? 0}`,
    'elif [ "$1" = "context" ] && [ "$2" = "show" ] && [ "$3" = "world/install" ]; then',
    `  printf '%s\\n' '{"relativePath":"world/install","sourceType":"user_file","sourcePath":"/fixture/private-world"}'`,
    'elif [ "$1" = "context" ] && [ "$2" = "get" ] && [ "$3" = "world-public" ]; then',
    '  cat "$fixture_dir/world-public-get.txt"',
    'elif [ "$1" = "context" ] && [ "$2" = "get" ] && [ "$3" = "world-example" ]; then',
    '  cat "$fixture_dir/world-example-get.txt"',
    'elif [ "$1" = "context" ] && [ "$2" = "profile" ] && [ "$3" = "world-public" ]; then',
    '  case " $* " in',
    '    *" --json "*) cat "$fixture_dir/world-public-profile.json" ;;',
    '    *) cat "$fixture_dir/world-public-profile.txt" ;;',
    '  esac',
    'elif [ "$1" = "context" ] && [ "$2" = "add" ]; then',
    `  if [ ${options.addStatus ?? 0} -ne 0 ]; then`,
    "    printf '%s\\n' 'context add is broken' >&2",
    `    exit ${options.addStatus ?? 0}`,
    "  fi",
    '  [ "$4" = "--name" ] || exit 64',
    `  if [ ${options.partialSync ? 1 : 0} -eq 1 ]; then`,
    '    target="$OPENRIG_CONTEXT_PACKS_ROOT/$5"',
    '    mkdir -p "$target"',
    '    printf \'%s\\n\' \'name: partial-sync-fixture\' > "$target/manifest.yaml"',
    '    printf \'{"installedAt":"%s","syncError":"HTTP 503"}\\n\' "$target"',
    "    exit 0",
    "  fi",
    '  target="$OPENRIG_CONTEXT_PACKS_ROOT/$5"',
    '  mkdir -p "$target"',
    '  cp -R "$3"/. "$target"/',
    '  printf \'%s\\n\' "$5" > "$install_state"',
    '  printf \'{"installedAt":"%s"}\\n\' "$target"',
    'elif [ "$1" = "context" ] && [ "$2" = "list" ]; then',
    '  if [ -f "$install_state" ]; then',
    '    installed_ref=$(sed -n \'1p\' "$install_state")',
    '    cat "$fixture_dir/context-list.json" | sed \'s/]$//\'',
    "    printf ',{\"relativePath\":\"%s\",\"sourceType\":\"user_file\",\"sourcePath\":\"%s/%s\"}]\\n' \"$installed_ref\" \"$OPENRIG_CONTEXT_PACKS_ROOT\" \"$installed_ref\"",
    "  else",
    '    cat "$fixture_dir/context-list.json"',
    "  fi",
    'elif [ "$1" = "context" ] && [ "$2" = "rm" ]; then',
    `  [ ${options.partialSync ? 1 : 0} -eq 0 ] || exit 72`,
    '  [ -f "$install_state" ] || exit 1',
    '  [ "$(sed -n \'1p\' "$install_state")" = "$3" ] || exit 1',
    '  rm -rf -- "$OPENRIG_CONTEXT_PACKS_ROOT/$3"',
    '  rm -f "$install_state"',
    '  printf \'{"removed":true,"ref":"%s"}\\n\' "$3"',
    'elif [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "context.packs_root" ]; then',
    `  printf '%s\\n' ${configRoot}`,
    'elif [ "$1" = "whoami" ]; then',
    `  printf '%s\\n' '${options.identityJson ?? '{"identity":{"rigName":"fixture","memberId":"qa","sessionName":"qa@fixture"}}'}'`,
    'elif [ "$1" = "ps" ] && [ "$2" = "--nodes" ]; then',
    `  printf '%s\\n' '${options.topology ?? '[{"canonicalSessionName":"qa@fixture","rigName":"fixture","sessionStatus":"running"}]'}'`,
    'elif [ "$1" = "ps" ]; then',
    "  printf '%s\\n' '1 rig · 1 seat · 0 need attention'",
    "else",
    "  exit 2",
    "fi",
  ].join("\n"));
  chmodSync(join(fixturePath, "rig"), 0o755);
  return fixturePath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public world pack", () => {
  it("ships one real world-classed atom graph spanning all eight regions", () => {
    const packDir = publicWorldDir();
    const manifest = manifestAt(packDir);
    const files = manifest.files.map((file) => file.path).sort();

    expect(manifest.taxonomy).toBe("world");
    expect(manifest.atoms?.length).toBeGreaterThanOrEqual(3);
    expect(new Set(manifest.atoms?.flatMap((atom) => atom.regions ?? []))).toEqual(
      new Set(["identity", "ontology", "terrain", "actors", "laws", "history", "state", "affordances"]),
    );
    expect(files).toEqual([
      "boundaries.md",
      "build-your-world.md",
      "claims.yaml",
      "start-here.md",
      "verify-world.sh",
    ]);

    for (const atom of manifest.atoms ?? []) {
      expect(atom.taxonomy).toBe("world");
      expect(atom.address).toMatch(/\.md(?:#|$)/);
      expect(atom.situations.length).toBeGreaterThan(0);
      expect(atom.order).toEqual(expect.any(Number));
      expect(atom.probe?.prompt).toEqual(expect.any(String));
      expect(atom.probe?.expect).toEqual(expect.any(String));
    }

    const profile = composeProfile({
      atoms: manifest.atoms ?? [],
      situation: "fresh",
      runtime: "codex",
      budgetTokens: 0,
      readFile: (ref) => readFileSync(join(packDir, ref), "utf8"),
    });
    expect(profile.pieces.map((piece) => piece.atomId)).toEqual((manifest.atoms ?? []).map((atom) => atom.id));
    expect(profile.totalEstimatedTokens).toBeGreaterThan(0);
    expect(profile.budget?.overageTokens).toBe(profile.totalEstimatedTokens);
    expect(profile.pieces).toHaveLength(manifest.atoms?.length ?? 0);
  });

  it("keeps every marked authored claim checked or explicitly flagged", () => {
    const packDir = publicWorldDir();
    const claims = parseYaml(readFileSync(join(packDir, "claims.yaml"), "utf8")) as {
      claims: Array<{ id: string; statement: string; kind: string; check?: string; flagged?: string }>;
    };
    const byId = new Map(claims.claims.map((claim) => [claim.id, claim]));
    const prose = ["start-here.md", "build-your-world.md", "boundaries.md"]
      .map((file) => readFileSync(join(packDir, file), "utf8"))
      .concat(readFileSync(join(STATIC_ROOT, "world-example", "your-world.md"), "utf8"))
      .join("\n");
    const marked = [...prose.matchAll(/<!--\s*world-claim:\s*([a-z0-9-]+)\s*-->/g)].map((match) => match[1]!);

    expect(marked.length).toBeGreaterThanOrEqual(8);
    expect(new Set(marked).size).toBe(marked.length);
    expect(new Set(marked)).toEqual(new Set(byId.keys()));
    expect(new Set(claims.claims.filter((claim) => claim.kind === "operational").map((claim) => claim.id))).toEqual(new Set([
      "compose-fresh-profile",
      "derive-identity",
      "derive-pack-path",
      "derive-topology",
      "discover-commands",
      "discover-context",
      "retrieve-public-pack",
      "retrieve-world-example",
      "world-example-install",
    ]));
    expect(new Set(claims.claims.map((claim) => claim.kind))).toEqual(new Set(["judgment", "operational", "structural"]));
    expect(claims.claims.some((claim) => claim.flagged), "taste or unverifiable claims must be visibly flagged").toBe(true);
    for (const claim of claims.claims) {
      expect(claim.statement.length, `${claim.id} must state the claim being classified`).toBeGreaterThan(10);
      expect(["judgment", "operational", "structural"], `${claim.id} needs a known claim kind`).toContain(claim.kind);
      expect(prose, `${claim.id} ledger statement must appear verbatim in the public prose`).toContain(claim.statement);
      expect(Boolean(claim.check) !== Boolean(claim.flagged), `${claim.id} needs exactly one disposition`).toBe(true);
    }
  });

  it("passes on the shipped bytes, fails on a falsified claim, and skips loudly when rig is absent", () => {
    const packDir = publicWorldDir();
    const rigPath = writeRigFixture();
    const fixtureEnv = {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: "/fixture/context-packs",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    };
    const green = runVerifier(packDir, fixtureEnv);
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).toMatch(/passed · 0 failed · 0 skipped/i);

    const redRoot = mkdtempSync(join(tmpdir(), "public-world-red-"));
    temporaryRoots.push(redRoot);
    const redPack = join(redRoot, basename(packDir));
    cpSync(packDir, redPack, { recursive: true });
    writeFileSync(
      join(redPack, "manifest.yaml"),
      readFileSync(join(redPack, "manifest.yaml"), "utf8").replace("taxonomy: world", "taxonomy: lore"),
    );
    const red = runVerifier(redPack, fixtureEnv);
    expect(red.status).toBe(1);
    expect(red.stdout).toMatch(/FAIL.*pack-taxonomy/i);

    const wrongIdentityPath = writeRigFixture({
      identityJson: '{"identity":{"rigName":"fixture","memberId":"qa","sessionName":"wrong@fixture"}}',
    });
    const wrongIdentity = runVerifier(packDir, {
      ...process.env,
      PATH: `${wrongIdentityPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: "/fixture/context-packs",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });
    expect(wrongIdentity.status).toBe(1);
    expect(wrongIdentity.stdout).toMatch(/FAIL.*derive-identity/i);
    expect(wrongIdentity.stdout).toMatch(/ok.*derive-topology/i);

    const wrongTopologyPath = writeRigFixture({ topology: "[]" });
    const wrongTopology = runVerifier(packDir, {
      ...process.env,
      PATH: `${wrongTopologyPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: "/fixture/context-packs",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });
    expect(wrongTopology.status).toBe(1);
    expect(wrongTopology.stdout).toMatch(/ok.*derive-identity/i);
    expect(wrongTopology.stdout).toMatch(/FAIL.*derive-topology/i);

    const missingPath = mkdtempSync(join(tmpdir(), "public-world-path-"));
    temporaryRoots.push(missingPath);
    const skip = runVerifier(packDir, { ...process.env, PATH: missingPath });
    expect(skip.status, skip.stdout + skip.stderr).toBe(0);
    expect(skip.stdout).toMatch(/skip.*rig-command-surface/i);
    expect(skip.stdout).toMatch(/1 skipped/i);
  });

  it("fails when world-public is absent from the serving and namespace projections", () => {
    const rigPath = writeRigFixture({
      showStatus: 73,
      listJson: JSON.stringify([
        { relativePath: "world/install", sourceType: "user_file", sourcePath: "/fixture/private-world" },
      ]),
    });
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: "/fixture/context-packs",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*derive-pack-path/i);
    expect(result.stdout).toMatch(/FAIL.*private-ref-boundary/i);
  });

  it("fails when the context store projection ignores its typed override", () => {
    const rigPath = writeRigFixture({ configRoot: "/fixture/wrong-context-packs" });
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: "/fixture/expected-context-packs",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*world-example-install/i);
  });

  it("fails when context add is broken despite healthy help and config projections", () => {
    const rigPath = writeRigFixture({ addStatus: 71 });
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: "/fixture/context-packs",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*world-example-install/i);
  });

  it("removes a copied pack when daemon sync never indexes it", () => {
    const contextRoot = mkdtempSync(join(tmpdir(), "public-world-context-root-"));
    temporaryRoots.push(contextRoot);
    const rigPath = writeRigFixture({ configRoot: contextRoot, partialSync: true });
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_PACKS_ROOT: contextRoot,
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*world-example-install/i);
    expect(readdirSync(contextRoot)).toEqual([]);
  });

  it("lets a stranger in an empty OPENRIG_HOME follow the taught world journey and observe real content", () => {
    const strangerRoot = mkdtempSync(join(tmpdir(), "public-world-stranger-"));
    temporaryRoots.push(strangerRoot);
    const openrigHome = join(strangerRoot, "openrig-home");
    const contextRoot = join(openrigHome, "context-packs");
    mkdirSync(openrigHome);
    expect(readdirSync(openrigHome)).toEqual([]);

    const rigPath = writeRigFixture({ configRoot: contextRoot });
    const env = {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_HOME: openrigHome,
      OPENRIG_CONTEXT_PACKS_ROOT: contextRoot,
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    };

    const publicGet = runRig(rigPath, ["context", "get", "world-public"], env);
    expect(publicGet.status, publicGet.stderr).toBe(0);
    expect(publicGet.stdout).toContain("# Enter the world");
    expect(publicGet.stdout).toContain("# Build your world");

    const profile = runRig(rigPath, ["context", "profile", "world-public", "--situation", "fresh"], env);
    expect(profile.status, profile.stderr).toBe(0);
    expect(profile.stdout).toContain("# Enter the world");
    expect(profile.stdout).toContain("# Boundaries");

    const show = runRig(rigPath, ["context", "show", "world-public", "--json"], env);
    expect(show.status, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({ relativePath: "world-public", sourceType: "builtin" });

    const verification = runVerifier(publicWorldDir(), env);
    expect(verification.status, verification.stdout + verification.stderr).toBe(0);
    expect(verification.stdout).toMatch(/ok.*retrieve-public-pack/i);
    expect(verification.stdout).toMatch(/ok.*compose-fresh-profile/i);
    expect(verification.stdout).toMatch(/ok.*retrieve-world-example/i);

    const exampleGet = runRig(rigPath, ["context", "get", "world-example"], env);
    expect(exampleGet.status, exampleGet.stderr).toBe(0);
    expect(exampleGet.stdout).toContain("## Exercise: Book world");

    const add = runRig(rigPath, ["context", "add", join(STATIC_ROOT, "world-example"), "--name", "stranger-example", "--json"], env);
    expect(add.status, add.stderr).toBe(0);
    expect(existsSync(join(contextRoot, "stranger-example", "manifest.yaml"))).toBe(true);
    const list = runRig(rigPath, ["context", "list", "--json"], env);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout).some((entry: { relativePath: string }) => entry.relativePath === "stranger-example")).toBe(true);
    const cleanup = runRig(rigPath, ["context", "rm", "stranger-example", "--json"], env);
    expect(cleanup.status, cleanup.stderr).toBe(0);
    expect(existsSync(join(contextRoot, "stranger-example"))).toBe(false);
  });

  it("graduates world-example into the same convention and a book-writer exercise", () => {
    const exampleDir = join(STATIC_ROOT, "world-example");
    const example = manifestAt(exampleDir);
    const exercise = readFileSync(join(exampleDir, "your-world.md"), "utf8");

    expect(example.taxonomy).toBe("world");
    expect(example.atoms?.length).toBeGreaterThan(0);
    expect(exercise).toContain("Book world");
    expect(exercise).toContain("rig context get world-example");
    expect(exercise).toContain("rig context add <pack-directory>");
    expect(exercise).toContain("rig context list");
    expect(exercise).toContain("rig config get context.packs_root");
    expect(exercise).not.toMatch(/identity\/|ontology\/|terrain\//);

    const packDir = publicWorldDir();
    const convention = readFileSync(join(packDir, "build-your-world.md"), "utf8");
    expect(convention).toContain("WORLD + LORE + SKILLS + MISSION");
    expect(convention).toContain("book");
    expect(convention).toContain("world-example");
  });

  it("stays portable and teaches only commands present on the live CLI surface", () => {
    const packDir = publicWorldDir();
    const text = readdirSync(packDir)
      .filter((file) => !file.endsWith(".json"))
      .map((file) => readFileSync(join(packDir, file), "utf8"))
      .join("\n");

    expect(text).not.toMatch(/\/(?:Users|home|private|tmp|var)\//);
    expect(text).not.toMatch(/~\//);
    expect(text).not.toMatch(/@v-openrig|openrig-work|shared-docs\//i);
    expect(text).not.toMatch(/\bworld model\b/i);
    expect(text).toMatch(/private world installs remain rig-local under their own refs and are never shadowed by this builtin/i);
    expect(text).toMatch(/AGENTS\.md.*repo instructions/i);
    expect(text).toContain("rig whoami --json");
    expect(text).toContain("rig ps --nodes --json");
    expect(text).toContain("rig context list");
    expect(text).toContain("rig context get world-public");
    expect(text).toContain("rig context add <pack-directory>");
    expect(text).toContain("rig context profile world-public --situation fresh");
    expect(text).toMatch(/consumers may filter that metadata as data/i);
    expect(text).toContain("rig --help");
    const cliSource = readFileSync(resolve(DAEMON_ROOT, "../cli/src/commands/context.ts"), "utf8");
    expect(cliSource).toContain('cmd.command("get")');
    expect(cliSource).toContain('cmd.command("profile")');
    expect(cliSource).toContain('requiredOption("--situation <situation>"');
  });
});
