# Checked seat stop (HTTP)

Read `GET /api/seat/stop-precondition/:seatRef` immediately before an operator-confirmed stop. A successful response has this shape:

```json
{"contract":"seat-stop.v1","expected":{"nodeId":"<node ID>","sessionId":"<latest session ID or null>"}}
```

Pass `expected` unchanged in the body of the existing `POST /api/seat/stop/:seatRef`, alongside `reason` and optional `operator`. The contract marker lets clients detect support. `expected` is optional; a request without it retains the existing stop behavior. A malformed explicit value returns HTTP 400. A null session ID can describe an empty seat, but stopping it returns `no_session`.

Checked stop requires the delivery guard. It refuses a changed node, latest session, binding or occupant before a terminal effect with HTTP 409 `selection_changed`. A kill failure or a failure to save stop state after a kill reports `stop_uncertain`; inspect the seat before retrying; the stop request stays recorded (see "The stop request" below). Success retains the usual `seat`, `sessionName` and `sessionId` fields.

A `selection_changed` or `stop_uncertain` response from a checked stop says how far the stop got in `stopPhase`. A refusal before the stop starts carries neither `stopPhase` nor `partialEffect`, and nothing was sent. The stop detaches the seat's clients, checks the selection again, then kills the session:

| `stopPhase` | What was sent to the seat |
| --- | --- |
| `none` | Nothing. |
| `detach_attempted` | The client detach, which may not have finished. No kill. |
| `detached` | The client detach. No kill. |
| `kill_attempted` | The kill. |

`partialEffect` is `true` whenever `stopPhase` isn't `none`, so on its own it doesn't say whether the kill went out. `selection_changed` with `stopPhase: "kill_attempted"` is a change seen after the kill, when the stop state is saved: the session was killed, so re-read the seat rather than offering the stop again.

## The stop request

Every `rig seat stop`, checked or not, records its stop request on the seat's latest session before the first step that stops anything, after the checks above and under the seat's lifecycle lease. `rig down` records it in one transaction before its first kill: on the latest session of each seat it is about to stop, and on a seat that is already down when its latest session fell (detached) or, for a seat that declares `keep_alive`, also when that session exited without a stop or is a failed relaunch's rolled-back (superseded) session. A seat without `keep_alive` whose latest session exited or was superseded gets its stop only once tmux proves the session absent. Claimed sessions and seats attached from outside are their owners' and are left out. A seat the request covers stays down: a daemon that dies in the middle of the stop, or before `rig down` reaches every seat, doesn't turn the stop into a fall.

Until the stop is confirmed the request is pending. Node inventory (`rig ps --nodes --json --full`) shows `stopRequested: true`, the seat isn't reported as exited, and its binding and skills stay. A timeout, a partial effect (`stopPhase` other than `none`), a failure to save the stop after the kill, or an error from the terminal adapter keeps the request pending, and the result says so. A request recorded on a session that already read exited or superseded is pending too: nothing has proven that session gone, so its skills stay and it isn't reported stopped. A later `rig down` checks it again and confirms it once tmux shows the session absent, and so does a `rig seat clean` or a later stop that finds the session gone; the daemon's reconcile confirms a pending request on a live or fallen session once it is gone (at its next start, for example), and never reads such a session as fallen.

Only a failure proven to have had no effect (`stopPhase: "none"`), or a session that had already ended on its own (`session_not_found`) on a seat without `keep_alive`, puts back the value this attempt replaced, on the same session while it's still recorded as live. It never clears an earlier or concurrent stop and never touches a replacement session. A later status write or observation doesn't clear the request either; an explicit start creates a new session, which starts without it.

A seat that declares `keep_alive` and carries a stop request, pending or confirmed, is never relaunched ([Keep a seat running](rig-spec.md#keep-a-seat-running-keep_alive)). For such a seat (launched by OpenRig, not claimed or attached from outside) a stop is never lost to a session that is already gone: when tmux shows the session absent, the stop is recorded instead of refused with `session_not_live` (the stop is confirmed; a failed relaunch's superseded session keeps its status), and the result carries `alreadyDown: true` with a message that the seat is now held down. When an older session of the seat is still live, or its binding points at another session, the stop is refused as before. A session that ends on its own between the check and the kill confirms the stop. Seats without `keep_alive` keep the refusal and the put-back above.
