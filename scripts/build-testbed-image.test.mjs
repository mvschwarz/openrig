import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 testbed image — the build verb (scripts/build-testbed-image.sh) is HOST-executed (it needs
// docker; the locus ruling puts the container runtime host-side). Its real logic lives in the
// tested node helpers (testbed-emit-manifest / build-inputs / manifest); this guard is the
// VM-authorable proof that the shell wrapper honors the plan §1 + FENCES contract, so a later edit
// that pushes the image, floats the build, or pulls openrig from the registry breaks here.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "build-testbed-image.sh");
const DOCKERFILE = join(HERE, "..", "docker", "testbed", "Dockerfile");

function readScript() {
  return readFileSync(SCRIPT, "utf8");
}

function readDockerfile() {
  return readFileSync(DOCKERFILE, "utf8");
}

test("is a strict bash script (shebang + set -euo pipefail)", () => {
  const text = readScript();
  assert.match(text, /^#!.*\b(bash|sh)\b/, "must have a shell shebang");
  assert.match(text, /set -euo pipefail/, "must fail-fast (set -euo pipefail)");
});

test("derives the image tag from the git sha (openrig-testbed:<git-sha>)", () => {
  const text = readScript();
  assert.match(text, /git\s+(?:-C\s+\S+\s+)?rev-parse/, "must resolve the git sha via git rev-parse");
  assert.match(text, /openrig-testbed:/, "must tag openrig-testbed:<git-sha>");
});

test("builds OpenRig from the tree via npm pack — never npm publish, never the registry", () => {
  const text = readScript();
  assert.match(text, /npm pack/, "must build the tarball from the tree via npm pack");
  assert.doesNotMatch(text, /npm\s+publish/, "must NOT npm publish");
  assert.doesNotMatch(
    text,
    /npm\s+(?:install|i|add)\s+(?:-g\s+)?openrig(?:@|\s|$)/m,
    "must NOT install openrig from the npm registry",
  );
});

test("runs docker build with the digest-pinned base + tarball build-args", () => {
  const text = readScript();
  assert.match(text, /docker build/, "must docker build");
  assert.match(text, /--build-arg\s+BASE_IMAGE=/, "must pass BASE_IMAGE (the digest-pinned base)");
  assert.match(text, /--build-arg\s+OPENRIG_TARBALL=/, "must pass OPENRIG_TARBALL (the local pack)");
});

test("Q2 fix A: packs the ASSEMBLED @openrig/cli (has the `rig` bin), NEVER the private monorepo root", () => {
  const text = readScript();
  // must assemble the publishable CLI first (bundles daemon/ui/tui + the bin) ...
  assert.match(text, /build-package\.sh/, "must run scripts/build-package.sh to assemble @openrig/cli");
  // ... and pack packages/cli, not the repo root (root = openrig@0.5.0, no bin -> rig --version exit 127)
  assert.match(text, /packages\/cli["'}\s]*&&\s*npm pack|cd\s+"?\$\{REPO_ROOT\}\/packages\/cli/, "npm pack must run with cwd packages/cli");
  assert.doesNotMatch(text, /cd\s+"?\$\{REPO_ROOT\}"?\s*&&\s*npm pack/, "must NOT pack the monorepo root");
});

test("resolves the target from the Docker server and passes both platform and arch", () => {
  const text = readScript();
  assert.match(text, /scenario-executor\.mjs.*platform/);
  assert.match(text, /--build-arg\s+TARGETARCH=/);
  assert.match(text, /docker build --platform/);
  assert.match(text, /docker run --name/);
  assert.doesNotMatch(text, /case.*uname -m/);
});

test("Q2 fix B: the Dockerfile fails CLOSED on an empty TARGETARCH (no silent amd64 default)", () => {
  const dockerfile = readFileSync(join(HERE, "..", "docker", "testbed", "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /TARGETARCH:-amd64/, "must NOT default TARGETARCH to amd64 (that installs wrong-arch Node)");
  assert.match(dockerfile, /"".*exit\s+[1-9]/, "an empty TARGETARCH must exit non-zero (fail closed)");
});

test("NEVER pushes the image (the never-push fence)", () => {
  const text = readScript();
  assert.doesNotMatch(text, /docker\s+push/, "must NOT docker push");
});

test("consumes the committed base-image slot + the stub-assets list (census scope)", () => {
  const text = readScript();
  assert.match(text, /base-image/, "must read the docker/testbed/base-image pin slot");
  assert.match(text, /stub-assets\.list/, "must read the explicit stub-assets census list");
});

test("emits the manifest via the tested node orchestrator", () => {
  const text = readScript();
  assert.match(text, /testbed-emit-manifest\.mjs/, "must emit the manifest via testbed-emit-manifest.mjs");
});

test("Q2 fix (break #4): the image installs the better-sqlite3 native-build toolchain (builds fresh on target)", () => {
  // The sealed Q2 packaging ruling builds better-sqlite3 FROM SOURCE on target (never a prebuilt/nested
  // binary). Its install is `prebuild-install || node-gyp rebuild`; node-gyp needs python3+make+g++.
  // Without them layer 3's `npm install -g` dies ('prebuild-install: not found' → no Python). This
  // static fence is the VM-authorable half; the behavioral RED→GREEN docker build runs host-side.
  const df = readDockerfile();
  assert.match(df, /python3 make g\+\+/, "layer 1 must install python3 make g++ (node-gyp toolchain)");
});

test("Q2 rider (effect proof): the build verb LOADS the daemon inside the container, not just `rig --version`", () => {
  // assert-the-EFFECT-not-the-command: a green build over a broken native install is the break-#4 CLASS.
  // Only a CONTAINER load catches it (the host has the toolchain, the image must not need it). The verb
  // must run the freshly-built image and START the daemon (opens the DB → better-sqlite3 must have
  // bound), failing the build if it can't. `rig --version` alone never opens the DB.
  const text = readScript();
  assert.match(text, /docker run\b[\s\S]*\$\{IMAGE_TAG\}/, "must run the freshly-built image (effect proof)");
  assert.match(text, /rig daemon start --no-kernel/, "must LOAD the daemon (better-sqlite3 binds) via the operator-corrected start, not merely check rig exists");
  assert.match(text, /\/healthz/, "must confirm readiness deterministically via /healthz (operator correction — no fixed sleep)");
});

test("image-load success, failure and deadline all retain status and remove only the named container", () => {
  const root = mkdtempSync(join(process.cwd(), ".testbed-load-"));
  try {
    for (const p of ["scripts", "docker/testbed", "packages/cli", "bin"]) mkdirSync(join(root, p), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts/build-testbed-image.sh"));
    copyFileSync(join(HERE, "scenario-executor.mjs"), join(root, "scripts/scenario-executor.mjs"));
    writeFileSync(join(root, "scripts/build-package.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "scripts/testbed-build-inputs.mjs"), "export const readBaseImage = () => ({ref:'fixture@sha256:abc'});\n");
    writeFileSync(join(root, "scripts/testbed-emit-manifest.mjs"), "import fs from 'node:fs';fs.writeFileSync(process.argv[3]+'/manifest.json','{}');\n");
    writeFileSync(join(root, "docker/testbed/Dockerfile"), "ARG NODE_VERSION=22.22.1\n");
    for (const p of ["docker/testbed/entrypoint.sh", "docker/testbed/base-image", "docker/testbed/stub-assets.list"]) writeFileSync(join(root, p), "");
    writeFileSync(join(root, "bin/git"), "#!/bin/sh\nprintf 'fake-source\\n'\n", { mode: 0o755 });
    writeFileSync(join(root, "bin/npm"), "#!/bin/sh\ntouch fixture.tgz\nprintf 'fixture.tgz\\n'\n", { mode: 0o755 });
    writeFileSync(join(root, "bin/mktemp"), '#!/bin/sh\nexec /usr/bin/mktemp "$@" "$HOME/tmp.XXXXXXXX"\n', { mode: 0o755 });
    // Use the real deadline helper with a short test deadline. No Docker daemon,
    // build, package install or network is involved; the marker models a remote
    // container surviving the client process until an explicit named removal.
    writeFileSync(join(root, "bin/node"), `#!${process.execPath}
import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);
if(args[1]==='timeout')args[2]='0.4';
const p=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'});process.exit(p.status??1);
`, { mode: 0o755 });
    writeFileSync(join(root, "bin/docker"), `#!${process.execPath}
import fs from 'node:fs';const args=process.argv.slice(2);const marker=process.env.FAKE_CONTAINER;
if(args[0]==='version')console.log(JSON.stringify({Os:'linux',Arch:'amd64'}));
else if(args[0]==='build'){}
else if(args[0]==='run'){
  const at=args.indexOf('--name');if(at<0)process.exit(9);
  fs.writeFileSync(marker,args[at+1]);
  if(process.env.LOAD_CASE==='timeout')setInterval(()=>{},1000);
  else process.exit(process.env.LOAD_CASE==='failure'?7:0);
}else if(args[0]==='inspect')console.log('[]');
else if(args[0]==='rm'){
  if(fs.readFileSync(marker,'utf8')!==args.at(-1))process.exit(8);
  fs.unlinkSync(marker);
}else process.exit(8);
`, { mode: 0o755 });
    for (const [mode, status] of [["success", 0], ["failure", 7], ["timeout", 124]]) {
      const out = join(root, mode), marker = join(root, "container");
      const run = spawnSync("/bin/bash", [join(root, "scripts/build-testbed-image.sh"), out], {
        env: { PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root, TMPDIR: root, LOAD_CASE: mode, FAKE_CONTAINER: marker },
        encoding: "utf8", timeout: 8000,
      });
      assert.equal(run.status, status, `${mode}: ${run.stderr}`);
      assert.equal(Number(readFileSync(join(out, "image-load.exit-code.txt"), "utf8")), status);
      assert.match(readFileSync(join(out, "image-load.container-name.txt"), "utf8"), /^openrig-testbed-load-/);
      assert.equal(existsSync(marker), false, `${mode}: container must be removed even after timeout`);
      assert.equal(existsSync(join(out, "manifest.json")), status === 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
