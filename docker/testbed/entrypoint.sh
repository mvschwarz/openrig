#!/usr/bin/env bash
# 51-04 testbed entrypoint — runs under tini (PID1 reaping, layer 5). Keeps the container init
# tmux-server-friendly (tini reaps the tmux server's children) and seeds the per-container
# self-host identity when the operator supplies one (plan §3 — the 51-09 OPENRIG_SELF_HOST_ID
# adopt path; N containers boot as N distinct named hosts). Then execs the container command.
set -euo pipefail

if [ -n "${OPENRIG_SELF_HOST_ID:-}" ]; then
  # Announce the adopted self-host id so `docker logs` shows which simulated host this is.
  echo "[testbed] self-host-id=${OPENRIG_SELF_HOST_ID}" >&2
fi

exec "$@"
