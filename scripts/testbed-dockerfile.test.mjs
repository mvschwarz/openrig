import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 testbed image — the Dockerfile is the deliverable (plan §1). `docker build` runs
// HOST-side (the locus ruling: the VM seat has no container runtime); this contract test is the
// VM-authorable proof that the Dockerfile encodes the plan §1 fences as executable guards, so a
// later edit that floats the base tag, pulls openrig from the npm registry, or drops the non-root
// user breaks the build here — not silently in a host-side image nobody re-audits.
//
// The fences it pins (plan §1 + the FENCES line): base parameterized for a digest-pin (never a
// floating tag baked in); tmux + git present (the PTY/tmux substrate); node pinned to an in-range
// engines version; OpenRig installed from a COPY'd local tarball, NEVER the npm registry (0.5.1 is
// unreleased — build from the tree); a non-root `openrig` user; a tini/dumb-init entrypoint.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DOCKERFILE = join(REPO_ROOT, "docker", "testbed", "Dockerfile");

const ENGINES_LTS_MAJORS = new Set([20, 22, 24]); // mirrors scripts/check-engines LTS constraint

function readDockerfile() {
  return readFileSync(DOCKERFILE, "utf8");
}

/** Non-comment, non-blank instruction lines. */
function instructions(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

test("Dockerfile exists at docker/testbed/Dockerfile", () => {
  assert.match(readDockerfile(), /\S/);
});

test("base is parameterized via ARG BASE_IMAGE + FROM ${BASE_IMAGE} — no floating tag baked in", () => {
  const text = readDockerfile();
  assert.match(text, /^ARG\s+BASE_IMAGE\b/m, "must declare ARG BASE_IMAGE (digest supplied by the build verb)");
  assert.match(text, /^FROM\s+\$\{BASE_IMAGE\}/m, "FROM must consume ${BASE_IMAGE}, not a hardcoded image");
  // No FROM with a concrete floating tag baked in (e.g. FROM node:22-slim / debian:bookworm-slim).
  for (const line of instructions(text)) {
    if (/^FROM\s/i.test(line)) {
      assert.match(line, /\$\{BASE_IMAGE\}/, `FROM must be parameterized, got: ${line}`);
    }
  }
});

test("installs the PTY/tmux substrate: tmux AND git", () => {
  const text = readDockerfile();
  assert.match(text, /\btmux\b/, "must install tmux");
  assert.match(text, /\bgit\b/, "must install git");
});

test("node is pinned via ARG NODE_VERSION to an in-range (even LTS) engines version", () => {
  const text = readDockerfile();
  const m = text.match(/^ARG\s+NODE_VERSION=(\d+)\.(\d+)\.(\d+)\b/m);
  assert.ok(m, "must declare ARG NODE_VERSION=<x.y.z> with a concrete default");
  const major = Number(m[1]);
  assert.ok(ENGINES_LTS_MAJORS.has(major), `NODE_VERSION major ${major} must be in {20,22,24} (engines LTS)`);
});

test("OpenRig is installed from a COPY'd local tarball, NEVER the npm registry", () => {
  const text = readDockerfile();
  // Positive: there is a build ARG for the tarball, it is COPY'd in, and installed from that path.
  assert.match(text, /^ARG\s+OPENRIG_TARBALL\b/m, "must declare ARG OPENRIG_TARBALL");
  assert.match(text, /^COPY\s+.*\$\{OPENRIG_TARBALL\}/m, "must COPY the tarball into the image");
  assert.match(text, /npm\s+install[^\n]*\.tgz/, "must install openrig from the local .tgz");
  // Negative fence: no registry install of the openrig package by bare name.
  assert.doesNotMatch(
    text,
    /npm\s+(?:install|i|add)\s+(?:-g\s+)?openrig(?:@|\s|$)/m,
    "must NOT install openrig from the npm registry (build from the tree)",
  );
});

test("runs as a non-root `openrig` user (creates it + a trailing USER openrig)", () => {
  const text = readDockerfile();
  assert.match(text, /\bopenrig\b/, "must reference an openrig user");
  assert.match(text, /(useradd|adduser)[^\n]*openrig/, "must create the openrig user");
  const userLines = instructions(text).filter((l) => /^USER\s/i.test(l));
  assert.ok(userLines.length > 0, "must set a USER");
  assert.match(userLines[userLines.length - 1], /^USER\s+openrig\b/i, "the final USER must be openrig (non-root)");
});

test("entrypoint execs under tini/dumb-init (PID1 reaping)", () => {
  const text = readDockerfile();
  const entry = instructions(text).find((l) => /^ENTRYPOINT\s/i.test(l));
  assert.ok(entry, "must declare an ENTRYPOINT");
  assert.match(entry, /tini|dumb-init/, "ENTRYPOINT must exec under tini or dumb-init");
});

test("stages the stub runtime assets into the image (layer 4)", () => {
  const text = readDockerfile();
  assert.match(text, /^COPY\s+.*stub-assets/m, "must COPY the staged stub-assets set");
});
