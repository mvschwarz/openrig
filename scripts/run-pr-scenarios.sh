#!/usr/bin/env bash
# Hosted Linux only. All daemon/seat work runs inside the existing testbed.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
test "${GITHUB_ACTIONS:-}" = true || { echo 'Use a disposable GitHub runner, not a working host' >&2; exit 2; }
test "$(uname -s)" = Linux
OUT="$REPO_ROOT/dist/pr-scenarios"
mkdir -p "$OUT"

# build-testbed-image performs the stock package build, clean target install,
# and daemon-load effect proof, then records the image inputs. It never pushes.
bash scripts/build-testbed-image.sh "$OUT/image"
SHA="$(git rev-parse HEAD)"
BASE="openrig-testbed:$SHA"
IMAGE="openrig-pr-scenarios:$SHA"
CONTEXT="$(mktemp -d)"
CONTAINER=""
cleanup() {
  if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null; fi
  rm -rf "$CONTEXT"
}
trap cleanup EXIT
cp docker/testbed/Dockerfile.scenarios "$CONTEXT/Dockerfile"
cp -R packages/daemon/test/fixtures/scenarios "$CONTEXT/scenarios"
# esbuild already ships in the lockfile through tsx. Bundle the existing helper
# closure (including YAML) so the container needs no source tree or dev install.
node_modules/.bin/esbuild packages/test-system/ci/run.mjs --bundle --platform=node \
  --format=esm --banner:js='import { createRequire as nodeRequire } from "node:module"; const require = nodeRequire(import.meta.url);' \
  --outfile="$CONTEXT/runner.mjs" --metafile="$OUT/runner-inputs.json"
docker build --network none --build-arg TESTBED_IMAGE="$BASE" -t "$IMAGE" "$CONTEXT"
docker image inspect "$IMAGE" > "$OUT/image-inspect.json"

for mode in healthy lost-baton; do
  status=0
  CONTAINER="openrig-pr-${SHA:0:12}-$mode-$$"
  # Fresh writable scratch only. No mounts, host networking, credentials or Docker
  # socket; the container is non-root, resource bounded and removed even on failure.
  timeout --signal=TERM --kill-after=15s 300s docker run --name "$CONTAINER" --network none \
    --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
    --memory 2g --cpus 2 "$IMAGE" node /opt/openrig-testbed/runner.mjs "$mode" \
    > "$OUT/$mode.log" 2>&1 || status=$?
  cat "$OUT/$mode.log"
  docker rm -f "$CONTAINER" >/dev/null
  CONTAINER=""
  node --input-type=module - "$mode" "$status" "$OUT/$mode.log" <<'JS'
import { readFileSync } from 'node:fs';
import { readReport, verifyRun } from './packages/test-system/ci/result.mjs';
const [mode, status, log] = process.argv.slice(2);
verifyRun(mode, Number(status), readReport(readFileSync(log, 'utf8')));
console.log(`${mode}: ${mode === 'healthy' ? 'healthy scenario passed' : 'seeded durability regression caught at the expected assertion'}`);
JS
done
