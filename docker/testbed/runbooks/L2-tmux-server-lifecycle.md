# L2 — tmux server lifecycle (detach-survive, multi-pane, send-keys + capture round-trip)

**Runs host-side, after L1.** Proves the tmux server — the substrate the whole product rides —
behaves in-container: sessions survive client detach, multiple panes coexist, and a send-keys →
capture round-trip returns the exact bytes.

## Setup

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l2-${GIT_SHA:0:8}"; docker run -d -t --name "${NAME}" "${IMAGE}"
```

## L2.1 — server survives detach

```bash
docker exec "${NAME}" tmux new-session -d -s l2 -x 80 -y 24
docker exec "${NAME}" tmux send-keys -t l2 'echo persist-marker-$$ > /tmp/l2.marker' Enter
sleep 1
# A detached session is the default with -d; confirm the server + session still list after a beat.
docker exec "${NAME}" tmux ls | tee "${EVID}/L2-sessions.txt"
docker exec "${NAME}" cat /tmp/l2.marker | tee "${EVID}/L2-marker.txt"
```

**PASS:** `tmux ls` shows `l2` still alive; the marker file exists. **FAIL:** "no server running" / no `l2`.

## L2.2 — multiple panes

```bash
docker exec "${NAME}" tmux split-window -t l2 -h
docker exec "${NAME}" tmux list-panes -t l2 -F '#{pane_index}' | tee "${EVID}/L2-panes.txt"
```

**PASS:** at least two pane indices (`0`,`1`). **FAIL:** one pane / error.

## L2.3 — send-keys + capture round-trip (exact bytes)

```bash
TOKEN="roundtrip-$(date +%s 2>/dev/null || echo fixed)-marker"
docker exec "${NAME}" tmux send-keys -t l2.0 "printf '%s\n' '${TOKEN}'" Enter
sleep 1
docker exec "${NAME}" tmux capture-pane -p -t l2.0 | tee "${EVID}/L2-roundtrip.txt"
```

**PASS:** the capture contains `${TOKEN}` verbatim (the exact bytes round-tripped through the server).
**FAIL:** token absent / garbled.

## Teardown + evidence

```bash
docker rm -f "${NAME}" >/dev/null
{ grep -q 'l2' "${EVID}/L2-sessions.txt" && [ "$(wc -l < "${EVID}/L2-panes.txt")" -ge 2 ] && grep -q "${TOKEN}" "${EVID}/L2-roundtrip.txt" \
  && echo "VERDICT: PASS — server survives detach, multi-pane, exact round-trip" \
  || echo "VERDICT: FAIL — see L2-*.txt"; } | tee "${EVID}/L2-verdict.txt"
```
