#!/usr/bin/env bash
# OpenRig DEV launcher — controlled env for daemon and descendants.
#
# OPENRIG_HOME alone does NOT isolate os.homedir(), CODEX_HOME, or global
# skills installs under ~/.claude / ~/.agents. This script sets a complete
# controlled surroundings tree and execs the command under that env.
#
# Usage:
#   scripts/dev-isolated-daemon.sh probe          # print isolation status (default)
#   scripts/dev-isolated-daemon.sh fail           # non-zero exit; preserves log
#   scripts/dev-isolated-daemon.sh daemon …      # run `rig daemon …` under isolation
#   scripts/dev-isolated-daemon.sh -- <cmd> …    # run arbitrary command under isolation
#
# Never writes to the operator's real HOME configs. Failed runs keep
# OPENRIG_DEV_LOG + exit status.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-probe}"
if [ "$#" -gt 0 ]; then shift; fi

REAL_HOME="${HOME:-}"
DEV_ROOT="${OPENRIG_DEV_ROOT:-$REPO_ROOT/.openrig-dev-home/launcher}"
STATUS_PATH="${OPENRIG_DEV_STATUS:-$DEV_ROOT/status.txt}"
LOG_PATH="${OPENRIG_DEV_LOG:-$DEV_ROOT/launcher.log}"

CONTROLLED_HOME="$DEV_ROOT/home"
CONTROLLED_OPENRIG="$DEV_ROOT/openrig-home"
CONTROLLED_CODEX="$CONTROLLED_HOME/.codex"
CONTROLLED_CLAUDE="$CONTROLLED_HOME/.claude"
CONTROLLED_AGENTS="$CONTROLLED_HOME/.agents"

mkdir -p \
  "$CONTROLLED_HOME" \
  "$CONTROLLED_OPENRIG" \
  "$CONTROLLED_CODEX" \
  "$CONTROLLED_CLAUDE/skills" \
  "$CONTROLLED_AGENTS/skills" \
  "$(dirname "$STATUS_PATH")" \
  "$(dirname "$LOG_PATH")"

# Controlled env for this process and every descendant.
export HOME="$CONTROLLED_HOME"
export OPENRIG_HOME="$CONTROLLED_OPENRIG"
export CODEX_HOME="$CONTROLLED_CODEX"
export CLAUDE_CONFIG_DIR="$CONTROLLED_CLAUDE"
export XDG_CONFIG_HOME="$CONTROLLED_HOME/.config"
export XDG_STATE_HOME="$CONTROLLED_HOME/.local/state"
export XDG_DATA_HOME="$CONTROLLED_HOME/.local/share"
export XDG_CACHE_HOME="$CONTROLLED_HOME/.cache"
export OPENRIG_NO_KERNEL="${OPENRIG_NO_KERNEL:-1}"

mkdir -p \
  "$XDG_CONFIG_HOME" \
  "$XDG_STATE_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_CACHE_HOME"

{
  echo "dev-isolated-daemon controlled env"
  echo "homedir=$HOME"
  echo "openrig_home=$OPENRIG_HOME"
  echo "codex_home=$CODEX_HOME"
  echo "claude_config_dir=$CLAUDE_CONFIG_DIR"
  echo "real_home_was=${REAL_HOME}"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$STATUS_PATH"

log() {
  printf '%s\n' "$*" | tee -a "$LOG_PATH" >&2
}

run_and_preserve() {
  local exit_code=0
  # Append stdout/stderr to the durable log; preserve exit status.
  set +e
  "$@" >>"$LOG_PATH" 2>&1
  exit_code=$?
  set -e
  {
    echo "exit_status=$exit_code"
    echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >>"$STATUS_PATH"
  return "$exit_code"
}

case "$CMD" in
  probe)
    # Prove Node sees controlled homedir (not operator REAL_HOME).
    : >"$LOG_PATH"
    run_and_preserve node --input-type=module -e "
      import os from 'node:os';
      import fs from 'node:fs';
      const probe = {
        homedir: os.homedir(),
        openrigHome: process.env.OPENRIG_HOME,
        codexHome: process.env.CODEX_HOME,
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
      };
      fs.appendFileSync(process.env.OPENRIG_DEV_STATUS, '\nprobe=' + JSON.stringify(probe) + '\n');
      // Touch only controlled trees — never REAL_HOME.
      fs.writeFileSync(process.env.CODEX_HOME + '/launcher-probe.txt', 'ok\n');
      fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/skills/launcher-probe.md', '# ok\n');
      console.log(JSON.stringify(probe));
      if (probe.homedir !== process.env.HOME) process.exit(11);
      if (probe.codexHome !== process.env.CODEX_HOME) process.exit(12);
    "
    ;;
  fail)
    : >"$LOG_PATH"
    log "intentional fail for log+exit preservation"
    run_and_preserve node -e "console.error('forced-failure'); process.exit(42)"
    ;;
  daemon)
    : >"$LOG_PATH"
    RIG_BIN="${OPENRIG_DEV_RIG:-$REPO_ROOT/packages/cli/dist/bin-wrapper.js}"
    if [ ! -f "$RIG_BIN" ]; then
      RIG_BIN="$(command -v rig || true)"
    fi
    if [ -z "$RIG_BIN" ]; then
      log "rig binary not found; build packages/cli or set OPENRIG_DEV_RIG"
      echo "exit_status=127" >>"$STATUS_PATH"
      exit 127
    fi
    run_and_preserve node "$RIG_BIN" daemon "$@"
    ;;
  --)
    : >"$LOG_PATH"
    run_and_preserve "$@"
    ;;
  *)
    log "unknown command: $CMD (use probe|fail|daemon|--)"
    echo "exit_status=2" >>"$STATUS_PATH"
    exit 2
    ;;
esac
