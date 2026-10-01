#!/usr/bin/env bash
# 51-04 testbed image build verb (plan §1). HOST-EXECUTED — it needs docker, and the locus ruling
# puts the container runtime host-side (the VM seat has none). Builds openrig-testbed:<git-sha> from
# the TREE (npm pack — never the npm registry; 0.5.1 is unreleased) against a digest-pinned base,
# then emits the reproducible manifest + stub-assets census receipt via the tested node orchestrator.
# It NEVER pushes. The fences here are guarded by scripts/build-testbed-image.test.mjs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTBED_DIR="${REPO_ROOT}/docker/testbed"
BASE_IMAGE_FILE="${TESTBED_DIR}/base-image"
STUB_ASSETS_LIST="${TESTBED_DIR}/stub-assets.list"
OUT_DIR="${1:-${REPO_ROOT}/dist/testbed-image}"

command -v docker >/dev/null 2>&1 || {
  echo "[testbed] Docker client not found; select the prepared disposable executor" >&2
  exit 3
}

# Resolve the daemon's platform BEFORE building locally. A remote amd64 daemon
# reached from an arm64 Mac needs amd64 Node; client uname is not the target.
mkdir -p "${OUT_DIR}"
TARGET_PLATFORM="$(node "${REPO_ROOT}/scripts/scenario-executor.mjs" platform "${OUT_DIR}/docker-server.json")"
TARGETARCH="${TARGET_PLATFORM#linux/}"

# --- identity from the tree: the image is built AT this git sha, so gitSha == openrigSha ---
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
IMAGE_TAG="openrig-testbed:${GIT_SHA}"

# --- the digest-pinned base — readBaseImage REFUSES a tag-floating / unresolved slot (the fence) ---
BASE_IMAGE="$(cd "${REPO_ROOT}" && node -e \
  'import("./scripts/testbed-build-inputs.mjs").then(m => process.stdout.write(m.readBaseImage(process.argv[1]).ref))' \
  "${BASE_IMAGE_FILE}")"

# --- the pinned node version — single source: the Dockerfile ARG default ---
NODE_VERSION="$(sed -n 's/^ARG NODE_VERSION=\([0-9][0-9.]*\).*/\1/p' "${TESTBED_DIR}/Dockerfile" | head -n1)"

# --- assemble a clean build context: Dockerfile + entrypoint + the openrig pack + staged stub assets ---
CONTEXT="$(mktemp -d)"
LOAD_CONTAINER=""
cleanup() {
  if [ -n "${LOAD_CONTAINER}" ]; then
    node "${REPO_ROOT}/scripts/scenario-executor.mjs" timeout 30 docker rm -f "${LOAD_CONTAINER}" >/dev/null ||
      echo "[testbed] cleanup incomplete; retained container name: ${LOAD_CONTAINER}" >&2
  fi
  rm -rf "${CONTEXT}"
}
trap cleanup EXIT
cp "${TESTBED_DIR}/Dockerfile" "${TESTBED_DIR}/entrypoint.sh" "${CONTEXT}/"

# OpenRig CLI from the TREE (never the npm registry). ASSEMBLE the publishable @openrig/cli first
# (build-package.sh bundles daemon/ui/tui + the `rig` bin into packages/cli), then pack THAT. Packing
# the private monorepo ROOT yields openrig@0.5.0 with NO `bin` — Docker installs it "successfully" but
# `rig --version` then fails with exit 127 (the whole point of the image is a runnable rig).
bash "${REPO_ROOT}/scripts/build-package.sh" >&2
TARBALL_NAME="$(cd "${REPO_ROOT}/packages/cli" && npm pack --silent | tail -n1)"
mv "${REPO_ROOT}/packages/cli/${TARBALL_NAME}" "${CONTEXT}/openrig.tgz"

# Stage the EXACT stub-asset set named in the census list (comment/blank tolerant); the same list is
# the census scope the manifest hashes (census-scope-match-code-path — no recursive over-count).
mkdir -p "${CONTEXT}/stub-assets"
while IFS= read -r line; do
  rel="${line%%#*}"; rel="$(echo "${rel}" | tr -d '[:space:]')"
  [ -z "${rel}" ] && continue
  mkdir -p "${CONTEXT}/stub-assets/$(dirname "${rel}")"
  cp "${REPO_ROOT}/${rel}" "${CONTEXT}/stub-assets/${rel}"
done < "${STUB_ASSETS_LIST}"

# The stub-asset file list as JSON (same comment-tolerant parse) for the manifest census.
STUB_FILES_JSON="$(node -e \
  'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").split("\n").map(s=>s.replace(/#.*/,"").trim()).filter(Boolean);process.stdout.write(JSON.stringify(l))' \
  "${STUB_ASSETS_LIST}")"

# --- build (host-side) ---
docker build --platform "${TARGET_PLATFORM}" \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --build-arg NODE_VERSION="${NODE_VERSION}" \
  --build-arg OPENRIG_TARBALL=openrig.tgz \
  --build-arg TARGETARCH="${TARGETARCH}" \
  -t "${IMAGE_TAG}" \
  -f "${CONTEXT}/Dockerfile" \
  "${CONTEXT}"

# --- EFFECT PROOF (PM rider — assert-the-EFFECT-not-the-command; closes break #4's CLASS: 'the gate
# was green while the install was broken'). This is the sealed Q2 ruling's effect-proof (a clean-target
# install that LOADS the daemon) made resident. It MUST be a CONTAINER load, not a host clean-dir
# install: the host has python/make/g++ so a host install of better-sqlite3 succeeds and would NOT
# catch break #4 — only the toolchain-free image does. Assert the daemon actually LOADS (better-sqlite3
# binds), not merely that `rig` exists (rig --version alone never opens the DB). Reuses the proven
# L3-daemon-in-container load sequence (docker/testbed/runbooks/L3). A broken native install fails
# `rig daemon start` here → set -e → non-zero → the build verb fails BEFORE the A/B pin. Not a per-fold
# gate (a docker build per fold is unaffordable) — this rides the pre-pin build verb; the A/B pin
# package REQUIRES it green. ---
echo "[testbed] effect proof: daemon LOAD inside the container (better-sqlite3 must have built)" >&2
# Operator-corrected load sequence (adopted verbatim from the host RED/GREEN run): start WITHOUT the
# kernel, confirm readiness by hitting /healthz DIRECTLY (deterministic — no fixed sleep), then daemon
# status; an EXIT trap stops the daemon so a failed assertion still tears down. A broken native install
# fails `rig daemon start` here → set -e → non-zero → the build verb fails BEFORE the A/B pin.
LOAD_CONTAINER="openrig-testbed-load-$(node -p 'require("node:crypto").randomUUID()')"
printf '%s\n' "${LOAD_CONTAINER}" > "${OUT_DIR}/image-load.container-name.txt"
load_status=0
node "${REPO_ROOT}/scripts/scenario-executor.mjs" timeout 120 docker run --name "${LOAD_CONTAINER}" \
  --platform "${TARGET_PLATFORM}" --network none --cap-drop ALL --security-opt no-new-privileges \
  --cpus 2 --memory 2g --memory-swap 2g --pids-limit 256 "${IMAGE_TAG}" bash -lc \
  'set -euo pipefail; trap "rig daemon stop >/dev/null 2>&1 || true" EXIT; rig --version; rig daemon start --no-kernel; curl -fsS http://127.0.0.1:7433/healthz; rig daemon status' \
  > "${OUT_DIR}/image-load.log" 2>&1 || load_status=$?
printf '%s\n' "${load_status}" > "${OUT_DIR}/image-load.exit-code.txt"
cat "${OUT_DIR}/image-load.log" >&2
inspect_status=0
node "${REPO_ROOT}/scripts/scenario-executor.mjs" timeout 30 docker inspect "${LOAD_CONTAINER}" \
  > "${OUT_DIR}/image-load.container.json" || inspect_status=$?
[ "${load_status}" -eq 0 ] || exit "${load_status}"
[ "${inspect_status}" -eq 0 ] || exit "${inspect_status}"
node "${REPO_ROOT}/scripts/scenario-executor.mjs" timeout 30 docker rm -f "${LOAD_CONTAINER}" >/dev/null
LOAD_CONTAINER=""

# --- emit the reproducible manifest + census receipt via the tested node orchestrator ---
INPUTS="$(mktemp)"
node -e \
  'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({gitSha:process.argv[2],openrigSha:process.argv[2],nodeVersion:process.argv[3],baseImagePath:process.argv[4],stubAssetsRoot:process.argv[5],stubAssetFiles:JSON.parse(process.argv[6])}))' \
  "${INPUTS}" "${GIT_SHA}" "${NODE_VERSION}" "${BASE_IMAGE_FILE}" "${CONTEXT}/stub-assets" "${STUB_FILES_JSON}"
node "${REPO_ROOT}/scripts/testbed-emit-manifest.mjs" "${INPUTS}" "${OUT_DIR}"
rm -f "${INPUTS}"

echo "[testbed] built ${IMAGE_TAG}; manifest + census receipt in ${OUT_DIR}" >&2
