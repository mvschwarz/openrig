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
import { basename, delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { assembleBundle } from "../src/domain/context-packs/bundle-assembler.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { composeProfile } from "../src/domain/context-packs/profile-composer.js";
import { writeRefocusNpmFixture } from "./helpers/refocus-native-fixtures.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const DAEMON_ROOT = resolve(import.meta.dirname, "..");
const STATIC_ROOT = resolve(DAEMON_ROOT, "context-packs-src");
const PUBLIC_WORLD_ROOT = resolve(STATIC_ROOT, "world-public");
const temporaryRoots: string[] = [];

const EXPECTED_PUBLIC_CLAIM_IDS = [
  "world-purpose",
  "author-derive-rule",
  "derive-identity",
  "derive-topology",
  "discover-context",
  "discover-commands",
  "trust-source-table",
  "agents-complement",
  "minimal-world-layout",
  "authoring-convention",
  "context-kinds",
  "regions-are-tags",
  "coverage-map-contract",
  "retrieve-public-pack",
  "compose-fresh-profile",
  "region-metadata",
  "no-region-selector",
  "derived-reading-cost",
  "book-example-purpose",
  "retrieve-world-example",
  "book-exercise-guidance",
  "book-to-software",
  "software-shaped-bridge",
  "optional-claim-checking-climb",
  "derive-pack-path",
  "run-public-verifier",
  "boundary-coverage",
  "boundary-exclusions",
  "boundary-guidance",
  "private-ref-boundary",
  "world-example-purpose",
  "world-example-install",
  "world-example-authoring",
  "world-example-book-exercise",
  "world-example-regions",
  "world-example-checks",
] as const;

const EXPECTED_COVERAGE_MAP_ROWS = [
  "| product | `world-public/boundaries.md#this-pack-does-not-cover` |",
  "| topology | `skills/core/openrig-architect/SKILL.md` |",
  "| context | `world-public/build-your-world.md#separate-kinds-tag-regions` |",
  "| skill | `onboarding-width/public-reference-material.md#the-one-you-read-rather-than-consult` |",
  "| queue/custody | `onboarding-width/public-what-you-can-do.md#making-work-outlive-you` |",
  "| source/worktree | `onboarding-width/public-reference-material.md#the-command-surface-docs-as-built-in-the-source-repo` |",
  "| proof/review | `skills/process/verification-before-completion/SKILL.md` |",
  "| lifecycle/release | `skills/core/rig-lifecycle/SKILL.md` |",
  "| continuity/recovery | `onboarding-width/public-what-you-can-do.md#when-something-is-broken` |",
  "| host-boundary | `skills/core/cross-host-rig-commands/SKILL.md` |",
] as const;

const EXPECTED_MANIFEST_CLAIMS = [
  { id: "public-manifest-purpose", value: "A portable operating-world primer that derives volatile facts and teaches agents to author their own world." },
  { id: "public-manifest-summary-start-here", value: "Derive where you are, what to trust, and which context belongs in a world." },
  { id: "public-manifest-summary-build-your-world", value: "The minimal authoring convention and a book-world exercise." },
  { id: "public-manifest-summary-boundaries", value: "What this public world covers, excludes, and cannot decide." },
  { id: "public-manifest-summary-claims", value: "Every authored claim mapped to a failing check or an explicit honesty flag." },
  { id: "public-manifest-summary-verify-world", value: "Portable named checks with loud failures and skips." },
  { id: "public-manifest-summary-verify-world-native", value: "Native Node checks with the same failures and skips." },
  { id: "public-manifest-probe-enter-the-world-prompt", value: "You just arrived in an unfamiliar OpenRig environment. What do you derive before acting?" },
  { id: "public-manifest-probe-enter-the-world-expect", value: "The agent derives its identity, live topology, available context, and command surface instead of guessing." },
  { id: "public-manifest-probe-author-a-world-prompt", value: "Create a world for a book-writing project without turning the eight regions into folders." },
  { id: "public-manifest-probe-author-a-world-expect", value: "The agent starts with a small manifest and authored files, tags atoms by region, and keeps other context kinds separate." },
  { id: "public-manifest-probe-know-the-edges-prompt", value: "Which gaps can this public world answer, and which still require local sources or human judgment?" },
  { id: "public-manifest-probe-know-the-edges-expect", value: "The agent distinguishes public structure from rig-local facts, current state, mission context, and irreversible judgment." },
  { id: "example-manifest-purpose", value: "A fill-in template showing the anatomy of an OpenRig world pack." },
  { id: "example-manifest-summary-your-world", value: "A minimal fill-in template for describing an agent's world." },
  { id: "example-manifest-probe-your-world-prompt", value: "Describe the operating world for a book-writing project." },
  { id: "example-manifest-probe-your-world-expect", value: "The agent fills one coherent world file and derives volatile state instead of creating a folder per region." },
] as const;

function publicWorldDir(): string {
  readFileSync(join(PUBLIC_WORLD_ROOT, "manifest.yaml"));
  return PUBLIC_WORLD_ROOT;
}

function manifestAt(packDir = publicWorldDir()) {
  const path = join(packDir, "manifest.yaml");
  return parseManifest(readFileSync(path, "utf8"), path);
}

function authoredManifestClaims(packDir: string, prefix: "public" | "example") {
  const manifest = parseYaml(readFileSync(join(packDir, "manifest.yaml"), "utf8")) as {
    purpose: string;
    files: Array<{ path: string; summary: string }>;
    atoms: Array<{ id: string; probe: { prompt: string; expect: string } }>;
  };
  return [
    { id: `${prefix}-manifest-purpose`, value: manifest.purpose },
    ...manifest.files.map((file) => ({
      id: `${prefix}-manifest-summary-${file.path.replace(/\.[^.]+$/, "")}`,
      value: file.summary,
    })),
    ...manifest.atoms.filter((atom) => atom.probe).flatMap((atom) => [
      { id: `${prefix}-manifest-probe-${atom.id}-prompt`, value: atom.probe.prompt },
      { id: `${prefix}-manifest-probe-${atom.id}-expect`, value: atom.probe.expect },
    ]),
  ];
}

function runVerifier(packDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") return spawnSync(process.execPath, [join(packDir, "verify-world-native.mjs")], {
    cwd: packDir, env: nativeEnv(env), encoding: "utf8", timeout: 30000,
  });
  return spawnSync("/bin/sh", [join(packDir, "verify-world.sh")], {
    cwd: packDir,
    env,
    encoding: "utf8",
  });
}

function runRig(rigPath: string, args: string[], env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") return spawnSync(process.execPath, [join(rigPath, "node_modules/@openrig/cli/probe.cjs"), ...args], { env: nativeEnv(env), encoding: "utf8" });
  return spawnSync(join(rigPath, "rig"), args, { env, encoding: "utf8" });
}

function nativeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const fixture of temporaryRoots) {
    if (result.PATH?.startsWith(fixture + ":")) result.PATH = fixture + delimiter + result.PATH.slice(fixture.length + 1);
    if (result.OPENRIG_CONTEXT_ROOT === "/fixture/context" && result.PATH?.startsWith(fixture + delimiter)) result.OPENRIG_CONTEXT_ROOT = join(fixture, "context");
  }
  return result;
}

function writeRigFixture(options: {
  identityJson?: string;
  topology?: string;
  showStatus?: number;
  listJson?: string;
  configRoot?: string;
  addStatus?: number;
  partialSync?: boolean;
  publicGet?: string;
  profileJson?: string;
  exampleGet?: string;
  showSourcePath?: string;
} = {}): string {
  const fixturePath = mkdtempSync(join(tmpdir(), "public-world-rig-"));
  temporaryRoots.push(fixturePath);
  const installState = join(fixturePath, "installed-ref");
  const library = new ContextPackLibraryService({ roots: [{ path: STATIC_ROOT, sourceType: "builtin" }] });
  library.scan();
  const publicEntry = library.getByRef("world-public")!;
  const exampleEntry = library.getByRef("world-example")!;
  const sourcePath = publicEntry.sourcePath;
  const manifest = manifestAt(sourcePath);
  const profile = composeProfile({
    atoms: manifest.atoms ?? [],
    situation: "fresh",
    runtime: "codex",
    budgetTokens: 0,
    readFile: (ref) => readFileSync(join(sourcePath, ref), "utf8"),
  });
  const showJson = JSON.stringify({
    ...publicEntry,
    sourcePath: options.showSourcePath ?? publicEntry.sourcePath,
  });
  const listJson = options.listJson ?? JSON.stringify([
    ...library.list(),
    { relativePath: "world/install", sourceType: "user_file", sourcePath: "/fixture/private-world" },
  ]);
  const configRoot = options.configRoot === undefined
    ? '"${OPENRIG_CONTEXT_ROOT:-/fixture/context}"'
    : `'${options.configRoot}'`;
  writeFileSync(
    join(fixturePath, "world-public-get.txt"),
    options.publicGet ?? assembleBundle({ packEntry: publicEntry }).text,
  );
  writeFileSync(join(fixturePath, "world-public-profile.json"), options.profileJson ?? JSON.stringify(profile));
  writeFileSync(
    join(fixturePath, "world-public-profile.txt"),
    profile.pieces.map((piece) => piece.text).join("\n"),
  );
  writeFileSync(
    join(fixturePath, "world-example-get.txt"),
    options.exampleGet ?? assembleBundle({ packEntry: exampleEntry }).text,
  );
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
    '    target="$OPENRIG_CONTEXT_ROOT/$5"',
    '    mkdir -p "$target"',
    '    printf \'%s\\n\' \'name: partial-sync-fixture\' > "$target/manifest.yaml"',
    '    printf \'{"installedAt":"%s","syncError":"HTTP 503"}\\n\' "$target"',
    "    exit 0",
    "  fi",
    '  target="$OPENRIG_CONTEXT_ROOT/$5"',
    '  mkdir -p "$target"',
    '  cp -R "$3"/. "$target"/',
    '  printf \'%s\\n\' "$5" > "$install_state"',
    '  printf \'{"installedAt":"%s"}\\n\' "$target"',
    'elif [ "$1" = "context" ] && [ "$2" = "list" ]; then',
    '  if [ -f "$install_state" ]; then',
    '    installed_ref=$(sed -n \'1p\' "$install_state")',
    '    cat "$fixture_dir/context-list.json" | sed \'s/]$//\'',
    "    printf ',{\"relativePath\":\"%s\",\"sourceType\":\"user_file\",\"sourcePath\":\"%s/%s\"}]\\n' \"$installed_ref\" \"$OPENRIG_CONTEXT_ROOT\" \"$installed_ref\"",
    "  else",
    '    cat "$fixture_dir/context-list.json"',
    "  fi",
    'elif [ "$1" = "context" ] && [ "$2" = "rm" ]; then',
    `  [ ${options.partialSync ? 1 : 0} -eq 0 ] || exit 72`,
    '  [ -f "$install_state" ] || exit 1',
    '  [ "$(sed -n \'1p\' "$install_state")" = "$3" ] || exit 1',
    '  rm -rf -- "$OPENRIG_CONTEXT_ROOT/$3"',
    '  rm -f "$install_state"',
    '  printf \'{"removed":true,"ref":"%s"}\\n\' "$3"',
    'elif [ "$1" = "config" ] && [ "$2" = "get" ] && [ "$3" = "context.root" ]; then',
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
  if (process.platform === "win32") writeRefocusNpmFixture(fixturePath, `
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),dir=${JSON.stringify(fixturePath)},state=${JSON.stringify(installState)},opt=${JSON.stringify(options)};
const out=x=>process.stdout.write(typeof x==='string'?x:JSON.stringify(x));
const file=name=>fs.readFileSync(p.join(dir,name),'utf8');
if(a[0]==='--help'||a[0]==='context'&&a[2]==='--help')process.exit(0);
if(a[0]==='context'){
 const verb=a[1],ref=a[2],context=process.env.OPENRIG_CONTEXT_ROOT;
 if(verb==='show'&&ref==='world-public'){out(file('world-public-show.json'));process.exitCode=opt.showStatus||0;}
 else if(verb==='show'&&ref==='world/install')out({relativePath:'world/install',sourceType:'user_file',sourcePath:'/fixture/private-world'});
 else if(verb==='get'&&ref==='world-public')out(file('world-public-get.txt'));
 else if(verb==='get'&&ref==='world-example')out(file('world-example-get.txt'));
 else if(verb==='profile'&&ref==='world-public')out(file(a.includes('--json')?'world-public-profile.json':'world-public-profile.txt'));
 else if(verb==='add'){
  if(opt.addStatus)process.exit(opt.addStatus);if(a[3]!=='--name')process.exit(64);
  const target=p.join(context,a[4]);fs.mkdirSync(target,{recursive:true});
  if(opt.partialSync){fs.writeFileSync(p.join(target,'manifest.yaml'),'name: partial-sync-fixture\\n');out({installedAt:target,syncError:'HTTP 503'});}
  else{fs.cpSync(ref,target,{recursive:true});fs.writeFileSync(state,a[4]);out({installedAt:target});}
 }else if(verb==='list'){
  const rows=JSON.parse(file('context-list.json'));if(fs.existsSync(state)){const name=fs.readFileSync(state,'utf8');rows.push({relativePath:name,sourceType:'user_file',sourcePath:p.join(context,name)});}out(rows);
 }else if(verb==='rm'){
  if(opt.partialSync)process.exit(72);if(!fs.existsSync(state)||fs.readFileSync(state,'utf8')!==ref)process.exit(1);
  fs.rmSync(p.join(context,ref),{recursive:true,force:true});fs.unlinkSync(state);out({removed:true,ref});
 }else process.exitCode=2;
}else if(a[0]==='config'&&a[1]==='get'&&a[2]==='context.root')out(opt.configRoot===undefined?(process.env.OPENRIG_CONTEXT_ROOT||'/fixture/context'):opt.configRoot);
else if(a[0]==='whoami')out(opt.identityJson||'${'{"identity":{"rigName":"fixture","memberId":"qa","sessionName":"qa@fixture"}}'}');
else if(a[0]==='ps')out(opt.topology||'${'[{"canonicalSessionName":"qa@fixture","rigName":"fixture","sessionStatus":"running"}]'}');
else process.exitCode=2;
`);
  return fixturePath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public world pack", () => {
  it.runIf(process.platform === "win32")("runs all native checks through the actual paired v2 seat shim", async () => {
    const fixture = writeRigFixture();
    const pkg = join(fixture, "cli O'Brien %PATH%"), cli = join(pkg, "dist", "probe.cjs"), home = join(fixture, "home");
    mkdirSync(join(pkg, "dist"), { recursive: true }); mkdirSync(home);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/probe.cjs" } }));
    cpSync(join(fixture, "node_modules/@openrig/cli/probe.cjs"), cli);
    const tmux = { getPaneCommand: async () => "powershell", getSessionEnv: async (_session: string, key: string) =>
      ({ OPENRIG_NODE_ID: "owned", OPENRIG_SESSION_NAME: "qa@fixture" }[key]) } as unknown as TmuxAdapter;
    const launch = new SeatLaunchEnvironment(tmux, { OPENRIG_HOME: home, PATH: fixture }, fixture, cli, undefined, "win32");
    await launch.command("qa@fixture", "'unused.exe'", { runtime: "claude-code", nodeId: "owned" });
    const seatBins = join(home, "run", "seat-bin"), bin = join(seatBins, readdirSync(seatBins)[0]!);
    const env = { ...process.env, PATH: bin, PATHEXT: ".CMD", OPENRIG_CONTEXT_ROOT: join(fixture, "context"), OPENRIG_SESSION_NAME: "qa@fixture" };
    const result = runVerifier(publicWorldDir(), env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("29 passed · 0 failed · 0 skipped");
    const shim = join(bin, "rig.cmd"); writeFileSync(shim, readFileSync(shim, "utf8").replaceAll("%%", "%"));
    const invalid = runVerifier(publicWorldDir(), env);
    expect(invalid.status).toBe(1); expect(invalid.stdout).toContain("[FAIL] rig-command-surface");
  });

  it.runIf(process.platform === "win32")("fails native verification when a named check is removed from its specification", () => {
    const parent = mkdtempSync(join(tmpdir(), "world-native-inventory-")); temporaryRoots.push(parent);
    const pack = join(parent, "world-public"); cpSync(PUBLIC_WORLD_ROOT, pack, { recursive: true });
    cpSync(join(STATIC_ROOT, "world-example"), join(parent, "world-example"), { recursive: true });
    const specification = join(pack, "verify-world.sh");
    writeFileSync(specification, readFileSync(specification, "utf8").replace(/^\s*pass taught-commands[^\r\n]*\r?\n/m, ""));
    const fixture = writeRigFixture({ showSourcePath: pack });
    const result = runVerifier(pack, { ...process.env, PATH: fixture, PATHEXT: ".CMD", OPENRIG_CONTEXT_ROOT: join(fixture, "context"), OPENRIG_SESSION_NAME: "qa@fixture" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("[FAIL] check-inventory");
    expect(result.stdout).toContain("taught-commands");
  });

  it("ships one real world-classed atom graph spanning all eight regions", () => {
    const packDir = publicWorldDir();
    const manifest = manifestAt(packDir);
    const files = manifest.files.map((file) => file.path).sort();

    expect(manifest.taxonomy).toBe("world");
    expect(manifest.atoms?.length).toBeGreaterThanOrEqual(3);
    expect(new Set(manifest.atoms?.flatMap((atom) => atom.regions ?? []))).toEqual(
      new Set(["identity", "ontology", "terrain", "actors", "laws", "history", "state", "affordances"]),
    );
    expect(manifest.profiles?.map((profile) => profile.id)).toEqual(["codex-coverage", "guided"]);
    expect(manifest.profiles?.find((profile) => profile.id === "codex-coverage")?.phases).toEqual([
      { id: "bootstrap", atoms: ["codex-bootstrap"] },
      { id: "project-mission-role-task", context: ["project", "mission", "seat", "slice"] },
      { id: "coverage-map", atoms: ["coverage-map"] },
    ]);
    expect(files).toEqual([
      "boundaries.md",
      "build-your-world.md",
      "claims.yaml",
      "start-here.md",
      "verify-world-native.mjs",
      "verify-world.sh",
    ]);

    for (const atom of manifest.atoms ?? []) {
      expect(atom.taxonomy).toBe("world");
      expect(atom.address).toMatch(/\.md(?:#|$)/);
      expect(atom.situations.length).toBeGreaterThan(0);
      expect(atom.order).toEqual(expect.any(Number));
      if (!atom.profileOnly) {
        expect(atom.probe?.prompt).toEqual(expect.any(String));
        expect(atom.probe?.expect).toEqual(expect.any(String));
      }
    }

    const profile = composeProfile({
      atoms: manifest.atoms ?? [],
      situation: "fresh",
      runtime: "codex",
      budgetTokens: 0,
      readFile: (ref) => readFileSync(join(packDir, ref), "utf8"),
    });
    expect(profile.pieces.map((piece) => piece.atomId)).toEqual((manifest.atoms ?? []).filter((atom) => !atom.profileOnly).map((atom) => atom.id));
    expect(profile.totalEstimatedTokens).toBeGreaterThan(0);
    expect(profile.budget?.overageTokens).toBe(profile.totalEstimatedTokens);
    expect(profile.pieces).toHaveLength(manifest.atoms?.filter((atom) => !atom.profileOnly).length ?? 0);
  });

  it("keeps the Codex coverage map bound to the ten exact authoritative addresses", () => {
    const prose = readFileSync(join(publicWorldDir(), "build-your-world.md"), "utf8");
    for (const row of EXPECTED_COVERAGE_MAP_ROWS) expect(prose).toContain(row);
    expect(prose).not.toContain("project-world/");
    expect(prose.match(/^\| (?:product|topology|context|skill|queue\/custody|source\/worktree|proof\/review|lifecycle\/release|continuity\/recovery|host-boundary) \|/gm)).toHaveLength(10);
  });

  it("keeps the complete judgment-owned authored claim census checked or explicitly flagged", () => {
    const packDir = publicWorldDir();
    const claims = parseYaml(readFileSync(join(packDir, "claims.yaml"), "utf8")) as {
      claims: Array<{ id: string; statement: string; kind: string; check?: string; flagged?: string }>;
    };
    const byId = new Map(claims.claims.map((claim) => [claim.id, claim]));
    const prose = ["start-here.md", "build-your-world.md", "boundaries.md"]
      .map((file) => readFileSync(join(packDir, file), "utf8"))
      .concat(readFileSync(join(STATIC_ROOT, "world-example", "your-world.md"), "utf8"))
      .join("\n");
    const manifests = [
      readFileSync(join(packDir, "manifest.yaml"), "utf8"),
      readFileSync(join(STATIC_ROOT, "world-example", "manifest.yaml"), "utf8"),
    ].join("\n");
    const marked = [...prose.matchAll(/<!--\s*world-claim:\s*([a-z0-9-]+)\s*-->/g)].map((match) => match[1]!);
    const verifier = readFileSync(join(packDir, "verify-world.sh"), "utf8");
    const passIds = new Set([...verifier.matchAll(/^\s*pass ([a-z0-9-]+) /gm)].map((match) => match[1]!));
    const failIds = new Set([...verifier.matchAll(/^\s*fail ([a-z0-9-]+) /gm)].map((match) => match[1]!));
    const manifestClaims = [
      ...authoredManifestClaims(packDir, "public"),
      ...authoredManifestClaims(join(STATIC_ROOT, "world-example"), "example"),
    ];
    const verifierManifestClaimIds = verifier.match(/expected_manifest_claim_ids='([\s\S]*?)'/)?.[1]
      .split(/\r?\n/)
      .filter(Boolean);

    expect(marked).toEqual(EXPECTED_PUBLIC_CLAIM_IDS);
    expect(new Set(marked).size).toBe(marked.length);
    expect(manifestClaims).toEqual(EXPECTED_MANIFEST_CLAIMS);
    expect(verifierManifestClaimIds).toEqual(EXPECTED_MANIFEST_CLAIMS.map((claim) => claim.id));
    expect(claims.claims.map((claim) => claim.id)).toEqual([
      ...EXPECTED_PUBLIC_CLAIM_IDS,
      ...EXPECTED_MANIFEST_CLAIMS.map((claim) => claim.id),
    ]);
    expect(new Set([...marked, ...manifestClaims.map((claim) => claim.id)])).toEqual(new Set(byId.keys()));
    expect(new Set(claims.claims.filter((claim) => claim.kind === "operational").map((claim) => claim.id))).toEqual(new Set([
      "compose-fresh-profile",
      "derive-identity",
      "derive-pack-path",
      "derive-topology",
      "discover-commands",
      "discover-context",
      "retrieve-public-pack",
      "retrieve-world-example",
      "run-public-verifier",
      "world-example-install",
    ]));
    expect(new Set(claims.claims.map((claim) => claim.kind))).toEqual(new Set(["judgment", "operational", "structural"]));
    const flaggedIds = new Set(claims.claims.filter((claim) => claim.flagged).map((claim) => claim.id));
    expect(flaggedIds.has("book-example-purpose")).toBe(true);
    expect(flaggedIds.has("book-to-software")).toBe(true);
    expect(flaggedIds.has("software-shaped-bridge")).toBe(true);
    expect(claims.claims.some((claim) => claim.flagged), "taste or unverifiable claims must be visibly flagged").toBe(true);
    for (const claim of claims.claims) {
      expect(claim.statement.length, `${claim.id} must state the claim being classified`).toBeGreaterThan(10);
      expect(["judgment", "operational", "structural"], `${claim.id} needs a known claim kind`).toContain(claim.kind);
      expect(`${prose}\n${manifests}`, `${claim.id} ledger statement must appear verbatim in the shipped authored content`).toContain(claim.statement);
      expect(Boolean(claim.check) !== Boolean(claim.flagged), `${claim.id} needs exactly one disposition`).toBe(true);
      if (claim.check) {
        expect(passIds, `${claim.id} check must have a real pass branch`).toContain(claim.check);
        expect(failIds, `${claim.id} check must have a real fail branch`).toContain(claim.check);
      }
    }
  });

  it("keeps both shipped manifests free of uncensused authored prose comments", () => {
    const comments = [
      ["world-public", join(publicWorldDir(), "manifest.yaml")],
      ["world-example", join(STATIC_ROOT, "world-example", "manifest.yaml")],
    ].flatMap(([pack, manifestPath]) =>
      readFileSync(manifestPath, "utf8")
        .split("\n")
        .filter((line) => /(^|\s)#\s/.test(line))
        .map((line) => ({ pack, line })),
    );

    expect(comments).toEqual([]);
  });

  it.each(["world-public", "world-example"] as const)(
    "fails when an uncensused authored prose comment appears in %s",
    (pack) => {
      const sourcePack = publicWorldDir();
      const redRoot = mkdtempSync(join(tmpdir(), "public-world-manifest-comment-red-"));
      temporaryRoots.push(redRoot);
      const redPack = join(redRoot, basename(sourcePack));
      cpSync(sourcePack, redPack, { recursive: true });
      cpSync(join(STATIC_ROOT, "world-example"), join(redRoot, "world-example"), { recursive: true });
      const manifestPath = join(pack === "world-public" ? redPack : join(redRoot, "world-example"), "manifest.yaml");
      writeFileSync(
        manifestPath,
        readFileSync(manifestPath, "utf8").replace(
          `name: ${pack}`,
          `name: ${pack} # Private rig-specific instructions for one internal operator.`,
        ),
      );

      const rigPath = writeRigFixture({ showSourcePath: redPack });
      const result = runVerifier(redPack, {
        ...process.env,
        PATH: `${rigPath}:${process.env.PATH ?? ""}`,
        OPENRIG_CONTEXT_ROOT: "/fixture/context",
        OPENRIG_SESSION_NAME: "qa@fixture",
        RIGGED_SESSION_NAME: "",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/FAIL.*manifest-authored-comments/i);
    },
  );

  it("fails when authored manifest purpose or probe semantics materially drift", () => {
    const sourcePack = publicWorldDir();
    const redRoot = mkdtempSync(join(tmpdir(), "public-world-manifest-claims-red-"));
    temporaryRoots.push(redRoot);
    const redPack = join(redRoot, basename(sourcePack));
    cpSync(sourcePack, redPack, { recursive: true });
    cpSync(join(STATIC_ROOT, "world-example"), join(redRoot, "world-example"), { recursive: true });
    const manifestPath = join(redPack, "manifest.yaml");
    const manifest = readFileSync(manifestPath, "utf8")
      .replace(
        "A portable operating-world primer that derives volatile facts and teaches agents to author their own world.",
        "A generic pack whose purpose is unrelated to operating worlds.",
      )
      .replace(
        "The agent derives its identity, live topology, available context, and command surface instead of guessing.",
        "The agent guesses a convenient roster from memory.",
      );
    writeFileSync(manifestPath, manifest);

    const rigPath = writeRigFixture({ showSourcePath: redPack });
    const result = runVerifier(redPack, {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*public-manifest-authored-claims/i);
  });

  it.each([
    [
      "trust-source relationship",
      "start-here.md",
      "| What exists right now? | The command that lists the live system |",
      "| What exists right now? | Whichever source is convenient |",
      /FAIL.*trust-source-table/i,
    ],
    [
      "boundary coverage",
      "boundaries.md",
      "- the eight world regions as atom metadata;",
      "- a convenient subset of world regions;",
      /FAIL.*boundary-coverage/i,
    ],
    [
      "authoring convention",
      "build-your-world.md",
      "The manifest names the files. The prose states durable purpose, relationships, and what to trust.",
      "The manifest may name files. The prose can say whatever is convenient.",
      /FAIL.*authoring-convention/i,
    ],
  ] as const)("fails when an authored %s claim materially drifts", (_label, file, before, after, failure) => {
    const sourcePack = publicWorldDir();
    const redRoot = mkdtempSync(join(tmpdir(), "public-world-claim-census-red-"));
    temporaryRoots.push(redRoot);
    const redPack = join(redRoot, basename(sourcePack));
    cpSync(sourcePack, redPack, { recursive: true });
    cpSync(join(STATIC_ROOT, "world-example"), join(redRoot, "world-example"), { recursive: true });
    const filePath = join(redPack, file);
    const source = readFileSync(filePath, "utf8");
    expect(source).toContain(before);
    writeFileSync(filePath, source.replace(before, after));

    const rigPath = writeRigFixture({ showSourcePath: redPack });
    const result = runVerifier(redPack, {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(failure);
  });

  it("passes on the shipped bytes, fails on a falsified claim, and skips loudly when rig is absent", () => {
    const packDir = publicWorldDir();
    const rigPath = writeRigFixture();
    const fixtureEnv = {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    };
    const green = runVerifier(packDir, fixtureEnv);
    expect(green.status, green.stdout + green.stderr).toBe(0);
    expect(green.stdout).toMatch(/passed · 0 failed · 0 skipped/i);
    expect(green.stdout).toMatch(/ok.*run-public-verifier/i);
    if (process.platform === "win32") {
      const expected = [...readFileSync(join(packDir, "verify-world.sh"), "utf8").matchAll(/^\s*pass ([a-z0-9-]+) /gm)].map(match => match[1]);
      expect([...green.stdout.matchAll(/^\[ok\] ([a-z0-9-]+) /gm)].map(match => match[1])).toEqual(expected);
    }

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
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
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
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
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
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*derive-pack-path/i);
    expect(result.stdout).toMatch(/FAIL.*private-ref-boundary/i);
  });

  it("fails when the context store projection ignores its typed override", () => {
    const rigPath = writeRigFixture({ configRoot: "/fixture/wrong-context" });
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: "/fixture/expected-context",
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
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAIL.*world-example-install/i);
  });

  it.each([
    ["public pack retrieval", { publicGet: "# unrelated content" }, /FAIL.*retrieve-public-pack/i],
    ["fresh profile composition", { profileJson: '{"pieces":[],"totalEstimatedTokens":0}' }, /FAIL.*compose-fresh-profile/i],
    ["worked example retrieval", { exampleGet: "# unrelated content" }, /FAIL.*retrieve-world-example/i],
  ] as const)("fails when %s returns the wrong bytes", (_label, fixtureOptions, expectedFailure) => {
    const rigPath = writeRigFixture(fixtureOptions);
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: "/fixture/context",
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(expectedFailure);
  });

  it("removes a copied pack when daemon sync never indexes it", () => {
    const contextRoot = mkdtempSync(join(tmpdir(), "public-world-context-root-"));
    temporaryRoots.push(contextRoot);
    const rigPath = writeRigFixture({ configRoot: contextRoot, partialSync: true });
    const result = runVerifier(publicWorldDir(), {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: contextRoot,
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
    const contextRoot = join(openrigHome, "context");
    mkdirSync(openrigHome);
    expect(readdirSync(openrigHome)).toEqual([]);

    const rigPath = writeRigFixture({ configRoot: contextRoot });
    const env = {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_HOME: openrigHome,
      OPENRIG_CONTEXT_ROOT: contextRoot,
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
    const shownPack = JSON.parse(show.stdout) as { relativePath: string; sourceType: string; sourcePath: string };
    expect(shownPack).toMatchObject({ relativePath: "world-public", sourceType: "builtin" });

    const verification = runVerifier(shownPack.sourcePath, env);
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

  it("fails loudly when the pack path returned by context show has no verifier", () => {
    const strangerRoot = mkdtempSync(join(tmpdir(), "public-world-missing-verifier-"));
    temporaryRoots.push(strangerRoot);
    const missingVerifierRoot = join(strangerRoot, "world-public");
    mkdirSync(missingVerifierRoot);
    const rigPath = writeRigFixture({ showSourcePath: missingVerifierRoot });
    const env = {
      ...process.env,
      PATH: `${rigPath}:${process.env.PATH ?? ""}`,
      OPENRIG_CONTEXT_ROOT: join(strangerRoot, "context"),
      OPENRIG_SESSION_NAME: "qa@fixture",
      RIGGED_SESSION_NAME: "",
    };

    const show = runRig(rigPath, ["context", "show", "world-public", "--json"], env);
    expect(show.status, show.stderr).toBe(0);
    const shownPack = JSON.parse(show.stdout) as { sourcePath: string };
    expect(shownPack.sourcePath).toBe(missingVerifierRoot);

    const verification = runVerifier(shownPack.sourcePath, env);
    expect(verification.status).not.toBe(0);
    expect(verification.stderr).toMatch(process.platform === "win32"
      ? /Cannot find module.*verify-world-native\.mjs/i : /verify-world\.sh.*(?:cannot open|no such file)/i);
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
    expect(exercise).toContain("rig config get context.root");
    expect(exercise).not.toMatch(/identity\/|ontology\/|terrain\//);

    const packDir = publicWorldDir();
    const convention = readFileSync(join(packDir, "build-your-world.md"), "utf8");
    expect(convention).toContain("WORLD + LORE + SKILLS + MISSION");
    expect(convention).toContain("book");
    expect(convention).toContain("world-example");
    expect(convention).toContain("specifications, verification loops, tooling, and the programming substrate");
    expect(convention).toContain("named files and a manifest as the spec shape");
    expect(convention).toContain("per-claim checks and a verifier that can fail as the test suite");
    expect(convention).toContain("derive-at-source commands as the feedback loop");
    expect(convention).toContain("A blank-slate reader therefore already knows how to build this kind of artifact");
    expect(convention).toContain("world-building supplies the information architecture while software-shaping supplies buildability");
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
