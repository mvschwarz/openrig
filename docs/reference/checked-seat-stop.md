# Checked seat stop (HTTP)

Read `GET /api/seat/stop-precondition/:seatRef` immediately before an operator-confirmed stop. A successful response has this shape:

```json
{"contract":"seat-stop.v1","expected":{"nodeId":"<node ID>","sessionId":"<latest session ID or null>"}}
```

Pass `expected` unchanged in the body of the existing `POST /api/seat/stop/:seatRef`, alongside `reason` and optional `operator`. The contract marker lets clients detect support. `expected` is optional; a request without it retains the existing stop behavior. A malformed explicit value returns HTTP 400. A null session ID can describe an empty seat, but stopping it returns `no_session`.

Checked stop requires the delivery guard. It refuses a changed node, latest session, binding or occupant before a terminal effect with HTTP 409 `selection_changed`. If the selection changes after client detach, the response reports `partialEffect: true` and no kill is sent. A kill failure or a failure to save stop state after a kill reports `stop_uncertain`; inspect the seat before retrying. Success retains the usual `seat`, `sessionName` and `sessionId` fields.
