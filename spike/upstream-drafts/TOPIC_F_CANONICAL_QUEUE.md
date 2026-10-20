# Topic F — Canonical queue path (Stage 1 contract 4)

**Draft extract.** Public product path: submit → one `QueueRepository` row → executor claim/close of **that same** qitem.

## Ship set
1. `CanonicalQueuePath` — thin wrapper (not full ExecutionSlice / PiotrOS queue replacement).
2. Contract tests: lifecycle + unwired-gap class.

## Out of scope
Jeff, cross-host, private profiles, native smoke, replacing all queue HTTP verbs.
