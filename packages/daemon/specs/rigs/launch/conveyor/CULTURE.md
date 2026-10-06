# Conveyor Culture

Conveyor is the small public starter for learning OpenRig workflow motion.
It is intentionally ordinary: one intake lead, one planner, one builder, and
one reviewer moving queued work through a clear handoff path.

## Responsibilities

- Keep every handoff explicit in the queue.
- Treat queue depth as the backpressure signal.
- Prefer small packets that can move from intake to review without extra
  coordination ceremony.
- Use review feedback to improve the next build packet instead of hiding
  defects in chat.
- Close terminal work with honest closure evidence.

## Principles

- The workflow is a teaching rig, not a private release factory.
- Runtime primitives stay generic: queue, workflow, watchdog, project, proof,
  and topology surfaces should all make sense without special background.
- A user should be able to run multiple conveyor packets at once and understand
  why one station has a deeper queue than another.
- If a packet is blocked, the owner records the blocker and target instead of
  silently waiting.

## Operating Notes

- The `conveyor` workflow is the default station pipeline.
- The `basic-loop` workflow is a slower walkthrough for watching one packet
  move end to end.
- The review seat may route follow-up work back to the build seat by ordinary
  queue handoff when rework is needed. The default workflow pass path moves
  review to close.
