---
capability_delta: capability-delta-v{{release_version}}
release: {{release_version}}
taxonomy: world
binding_target:
  sha: "<exact cut commit>"
  dirty: "<true|false>"
audience: "<who must consume this delta>"
review_status: "<draft|reviewed and by whom>"
expiry:
  event: "canon header names capability-delta-v{{release_version}} and successor delta exists"
  canon_path: "<path to capability canon>"
  successor_path: "<path to successor delta>"
---

# CAPABILITY DELTA — <previous version> → {{release_version}}

Bind this delta to the exact published cut in `binding_target`; never bind it to
an uncut branch or omit the dirty-state observation.

## What you can now do (situation-keyed)

1. **<Capability stated as an observable new truth>.**
   **REACH FOR IT WHEN:** <the situation that should trigger this capability>.

## Landed, not yet drivable

| Landed surface | Missing live door | Honest current action |
|---|---|---|
| <surface> | <what cannot yet be exercised> | <what to do instead> |

## What to STOP doing

1. **<Retired workaround or belief>.**
   - **Correct before:** <the prior release truth that justified it>.
   - **Wrong now:** <the new release truth and the replacement action>.

## Selection probes

- **P-A — <negative or present-to-absent case>:** <prompt and expected first answer>.
- **P-B — <positive case>:** <prompt and expected first answer>.

**DELTA-ONLY QUALIFICATION:** grade the seat's first stated answer before it runs
or reads anything. A probe qualifies only when the baseline misses the changed
truth and the delta-trained answer gets it; already-known behavior is not delta
evidence.

## Canon patch

- **Already present — do not duplicate:** <canon content that already teaches the truth>.
- **Patch:** <the smallest missing canon change, with its exact destination path>.
- **Expiry marker:** when absorption is complete, put
  `capability-delta-v{{release_version}}` in the named canon file's header and
  create the successor delta at `expiry.successor_path`. The advisory audit then
  reports this delta as citable no more.

---

> Procedure and conventions live at `docs/reference/sdlc-conventions.md`
> (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`). This artifact holds
> release-specific facts only; do not copy the release-boundary SOP into it.
