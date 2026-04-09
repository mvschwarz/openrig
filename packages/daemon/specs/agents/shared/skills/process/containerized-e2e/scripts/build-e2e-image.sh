#!/bin/bash
# Build the OpenRig containerized E2E testing image.
#
# Usage: ./build-e2e-image.sh [repo-root]
#   repo-root defaults to the current directory.
#
# Produces: Docker image tagged openrig-e2e:latest

set -euo pipefail

REPO_ROOT="${1:-.}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_CTX="/tmp/openrig-e2e-build"

echo "=== Building OpenRig packages ==="
cd "$REPO_ROOT"
npm run build --workspace @openrig/daemon
npm run build --workspace @openrig/ui
npm run build --workspace @openrig/cli
bash scripts/build-package.sh

echo "=== Packing CLI tarball ==="
mkdir -p "$BUILD_CTX"
cd "$REPO_ROOT/packages/cli"
npm pack --pack-destination "$BUILD_CTX"

echo "=== Preparing Docker build context ==="
cp "$SKILL_DIR/scripts/Dockerfile" "$BUILD_CTX/Dockerfile"
# Rename tarball to a stable name
mv "$BUILD_CTX"/openrig-cli-*.tgz "$BUILD_CTX/openrig-cli.tgz"

echo "=== Building Docker image ==="
cd "$BUILD_CTX"
docker build -t openrig-e2e:latest .

echo "=== Done ==="
echo "Run: docker run -it --rm --shm-size=1g -v /tmp/openrig-e2e-artifacts:/artifacts openrig-e2e"
