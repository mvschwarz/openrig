# Conveyor Starter

Conveyor is the OpenRig 0.3.0 starter rig for learning queue handoffs and
workflow instances.

## Run

```bash
rig up conveyor
```

## Workflows

- `conveyor`: station pipeline. Multiple packets can be active at once.
- `basic-loop`: single-work-item walkthrough for watching one packet move
  through the same seats.

## Sample Objective

Use this as a first packet:

```text
Draft a tiny release-readiness checklist for a command-line tool. Keep it to
five checks and include one verification command.
```

Expected motion:

1. `intake-lead@conveyor` clarifies the packet and hands it to planning.
2. `plan-planner@conveyor` turns it into a small plan.
3. `build-builder@conveyor` drafts the checklist.
4. `review-reviewer@conveyor` checks the result.
5. `intake-lead@conveyor` closes the packet with evidence.
