# L1 — PTY allocation (docker run -t + tmux capture returns real bytes; resize propagates)

**Runs host-side, after L0 + a build.** Proves the image gives a real PTY and that tmux inside it
produces genuine captured bytes — the TUI-spike fixed-viewport pattern, reused. Never assert the
observable from memory; verdict against the captured bytes.

## Setup

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
docker image inspect "${IMAGE}" >/dev/null   # built by scripts/build-testbed-image.sh (FAIL loudly if absent)
NAME="orig-l1-${GIT_SHA:0:8}"
```

## L1.1 — allocate a PTY + start a tmux session inside

```bash
# -t allocates a PTY; the entrypoint (tini) holds the container. Detached, fixed 80x24 viewport.
docker run -d -t --name "${NAME}" "${IMAGE}"
docker exec "${NAME}" tmux new-session -d -s l1 -x 80 -y 24
docker exec "${NAME}" tmux send-keys -t l1 'printf "PTY-OK:%s\n" "$TERM"; tty' Enter
sleep 1
docker exec "${NAME}" tmux capture-pane -p -t l1 | tee "${EVID}/L1-capture.txt"
```

**PASS:** the capture contains a real `PTY-OK:` line and `tty` prints a real pts device
(`/dev/pts/...`), not "not a tty". **FAIL:** "not a tty" / empty capture.

## L1.2 — resize propagates

```bash
docker exec "${NAME}" tmux resize-window -t l1 -x 120 -y 40
docker exec "${NAME}" tmux display-message -p -t l1 '#{window_width}x#{window_height}' | tee "${EVID}/L1-resize.txt"
```

**PASS:** reports `120x40` (the resize propagated to the in-container tmux). **FAIL:** stays `80x24`.

## Teardown + evidence

```bash
docker rm -f "${NAME}" >/dev/null
{ grep -q 'PTY-OK:' "${EVID}/L1-capture.txt" && grep -q '/dev/pts/' "${EVID}/L1-capture.txt" && grep -q '120x40' "${EVID}/L1-resize.txt" \
  && echo "VERDICT: PASS — PTY allocated, real capture bytes, resize propagated" \
  || echo "VERDICT: FAIL — see L1-capture.txt / L1-resize.txt"; } | tee "${EVID}/L1-verdict.txt"
```

**Fence:** no `-v` HOME/workspace mounts; the container is disposable (fresh HOME).
