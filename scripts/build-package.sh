#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
DAEMON_DIR="$REPO_ROOT/packages/daemon"
UI_DIR="$REPO_ROOT/packages/ui"

echo "=== OpenRig Package Build ==="
echo "Repo root: $REPO_ROOT"
echo ""

# 1. Clean previous build artifacts
echo "[1/5] Cleaning previous artifacts..."
rm -rf "$CLI_DIR/daemon" "$CLI_DIR/ui"

# 2. Build daemon
echo "[2/5] Building daemon..."
(cd "$DAEMON_DIR" && npm run build)

# 3. Build UI
echo "[3/5] Building UI..."
(cd "$UI_DIR" && npm run build)

# 4. Build CLI
echo "[4/5] Building CLI..."
(cd "$CLI_DIR" && npm run build)

# 5. Assemble: copy daemon + UI into CLI package
echo "[5/5] Assembling package..."

# Daemon: dist + assets + specs
mkdir -p "$CLI_DIR/daemon/dist"
cp -r "$DAEMON_DIR/dist/"* "$CLI_DIR/daemon/dist/"

if [ -d "$DAEMON_DIR/assets" ]; then
  cp -r "$DAEMON_DIR/assets" "$CLI_DIR/daemon/assets"
fi

if [ -d "$DAEMON_DIR/specs" ]; then
  cp -r "$DAEMON_DIR/specs" "$CLI_DIR/daemon/specs"
fi

if [ -d "$DAEMON_DIR/docs" ]; then
  cp -r "$DAEMON_DIR/docs" "$CLI_DIR/daemon/docs"
fi

# UI: dist
mkdir -p "$CLI_DIR/ui/dist"
cp -r "$UI_DIR/dist/"* "$CLI_DIR/ui/dist/"

# Report
echo ""
echo "=== Package Assembled ==="
echo "CLI dist:        $(find "$CLI_DIR/dist" -name '*.js' | wc -l | tr -d ' ') JS files"
echo "Daemon dist:     $(find "$CLI_DIR/daemon/dist" -name '*.js' | wc -l | tr -d ' ') JS files"
echo "Daemon assets:   $(find "$CLI_DIR/daemon/assets" -type f 2>/dev/null | wc -l | tr -d ' ') files"
echo "Daemon specs:    $(find "$CLI_DIR/daemon/specs" -type f 2>/dev/null | wc -l | tr -d ' ') files"
echo "Daemon docs:     $(find "$CLI_DIR/daemon/docs" -type f 2>/dev/null | wc -l | tr -d ' ') files"
echo "UI dist:         $(find "$CLI_DIR/ui/dist" -type f | wc -l | tr -d ' ') files"
echo ""
echo "Ready to publish: cd packages/cli && npm publish --access public"
