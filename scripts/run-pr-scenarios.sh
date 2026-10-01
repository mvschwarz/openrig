#!/usr/bin/env bash
# All daemon/seat work runs inside the existing disposable testbed.
# Default: GitHub CI. --remote: explicitly selected SSH Docker executor.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
REMOTE=false
CASES=(fixture library)
MODES=(healthy lost-baton healthy)
OUT="$REPO_ROOT/dist/pr-scenarios"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote) REMOTE=true; shift ;;
    --case)
      case "${2:-}" in fixture|library) CASES=("$2");; *) echo 'Expected --case fixture|library' >&2; exit 2;; esac
      shift 2 ;;
    --mode)
      case "${2:-}" in healthy|lost-baton) MODES=("$2");; *) echo 'Expected --mode healthy|lost-baton' >&2; exit 2;; esac
      shift 2 ;;
    --out) test -n "${2:-}" || exit 2; OUT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if "$REMOTE"; then
  case "${DOCKER_HOST:-}" in ssh://?*) ;; *) echo '--remote requires explicit DOCKER_HOST=ssh://...' >&2; exit 2;; esac
  test -z "${DOCKER_CONTEXT:-}" || { echo 'Unset DOCKER_CONTEXT so it cannot override the selected DOCKER_HOST' >&2; exit 2; }
else
  test "${GITHUB_ACTIONS:-}" = true || { echo 'Use GitHub CI or --remote with the prepared disposable SSH executor' >&2; exit 2; }
  test "$(uname -s)" = Linux
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
TARGET_PLATFORM="$(node scripts/scenario-executor.mjs platform "$OUT/docker-server.json")"

# build-testbed-image performs the stock package build, clean target install,
# and daemon-load effect proof, then records the image inputs. It never pushes.
bash scripts/build-testbed-image.sh "$OUT/image"
SHA="$(git rev-parse HEAD)"
BASE="openrig-testbed:$SHA"
IMAGE="openrig-pr-scenarios:$SHA"
CONTEXT="$(mktemp -d)"
CONTAINER=""
cleanup() {
  if [ -n "$CONTAINER" ]; then
    node scripts/scenario-executor.mjs timeout 30 docker rm -f "$CONTAINER" >/dev/null || echo "Cleanup incomplete; retained container name: $CONTAINER" >&2
  fi
  rm -rf "$CONTEXT"
}
trap cleanup EXIT
cp docker/testbed/Dockerfile.scenarios "$CONTEXT/Dockerfile"
cp -R packages/daemon/test/fixtures/scenarios "$CONTEXT/scenarios"
cp -R packages/test-system/scenarios "$CONTEXT/library"
# esbuild already ships in the lockfile through tsx. Bundle the existing helper
# closure (including YAML) so the container needs no source tree or dev install.
node_modules/.bin/esbuild packages/test-system/ci/run.mjs --bundle --platform=node \
  --format=esm --banner:js='import { createRequire as nodeRequire } from "node:module"; const require = nodeRequire(import.meta.url);' \
  --outfile="$CONTEXT/runner.mjs" --metafile="$OUT/runner-inputs.json"
docker build --network none --platform "$TARGET_PLATFORM" --build-arg TESTBED_IMAGE="$BASE" -t "$IMAGE" "$CONTEXT"
docker image inspect "$IMAGE" > "$OUT/image-inspect.json"

attempt=0
for scenario in "${CASES[@]}"; do
for mode in "${MODES[@]}"; do
  attempt=$((attempt + 1))
  status=0
  LOG="$OUT/$attempt-$scenario-$mode.log"
  CONTAINER="openrig-pr-${SHA:0:12}-$attempt-$$"
  printf '%s\n' "$CONTAINER" > "$OUT/$attempt-$scenario-$mode.container-name.txt"
  # Fresh writable scratch only. No mounts, host networking, credentials or Docker
  # socket; the container is non-root, resource bounded and removed even on failure.
  node scripts/scenario-executor.mjs timeout 300 docker run --name "$CONTAINER" --platform "$TARGET_PLATFORM" --network none \
    --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
    --memory 2g --memory-swap 2g --cpus 2 "$IMAGE" node /opt/openrig-testbed/runner.mjs "$mode" "$scenario" \
    > "$LOG" 2>&1 || status=$?
  printf '%s\n' "$status" > "$OUT/$attempt-$scenario-$mode.exit-code.txt"
  cat "$LOG"
  node scripts/scenario-executor.mjs timeout 30 docker inspect "$CONTAINER" > "$OUT/$attempt-$scenario-$mode.container.json"
  node scripts/scenario-executor.mjs timeout 30 docker rm -f "$CONTAINER" >/dev/null
  CONTAINER=""
  node --input-type=module - "$mode" "$status" "$LOG" "$scenario" <<'JS'
import { readFileSync } from 'node:fs';
import { readReport, verifyRun } from './packages/test-system/ci/result.mjs';
const [mode, status, log, scenario] = process.argv.slice(2);
verifyRun(mode, Number(status), readReport(readFileSync(log, 'utf8')), scenario);
console.log(`${scenario}/${mode}: ${mode === 'healthy' ? 'healthy scenario passed' : 'seeded durability regression caught at the expected assertion'}`);
JS
done
done
