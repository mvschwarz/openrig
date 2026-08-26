---
id: {{id}}
mission: {{mission}}
release: {{release_version}}
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# Release {{release_version}} — {{title}}

## Intent

{{intent}}

## Scope

[What ships in v{{release_version}} vs what waits]

## Slices

[Ordering + dependencies; PROGRESS.md tracks state]

## Acceptance

[Release-level done definition]

---

> Work from this `SPEC.md`; keep durable acceptance state in `PROGRESS.md`
> and context that does not belong in the contract in `NOTES.md`. Load the
> `mission-slice-sop` skill for the operating procedure. Conventions SSOT:
> `docs/reference/sdlc-conventions.md` (installed:
> `$OPENRIG_HOME/reference/sdlc-conventions.md`).
