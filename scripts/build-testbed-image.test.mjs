import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 testbed image — the build verb (scripts/build-testbed-image.sh) is HOST-executed (it needs
// docker; the locus ruling puts the container runtime host-side). Its real logic lives in the
// tested node helpers (testbed-emit-manifest / build-inputs / manifest); this guard is the
// VM-authorable proof that the shell wrapper honors the plan §1 + FENCES contract, so a later edit
// that pushes the image, floats the build, or pulls openrig from the registry breaks here.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "build-testbed-image.sh");

function readScript() {
  return readFileSync(SCRIPT, "utf8");
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

test("Q2 fix B: resolves the target arch HOST-side + passes it explicitly, fail-CLOSED (never a silent amd64 default -> exit 133)", () => {
  const text = readScript();
  assert.match(text, /uname -m/, "must resolve the host arch (uname -m) so the legacy builder gets a real TARGETARCH");
  assert.match(text, /--build-arg\s+TARGETARCH=/, "must pass TARGETARCH explicitly (builder-agnostic)");
  assert.match(text, /uname -m[\s\S]*?exit\s+[1-9]/, "must fail-closed (non-zero exit) on an unresolvable arch");
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
