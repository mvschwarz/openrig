# Composable Product-Journey SDLC Design

## Goal

Graduate the successful 0.5.7 salvage method into reusable SDLC components that a
fresh agent can assemble from mission and slice YAML. The same components must work
for a mission that drifted into a "moon base" and for a new mission that has intent
but no implementation.

## Problem

The existing SDLC reference says that missions choose components, but the 0.5.7
pilot's useful composition exists only in its mission YAML and conversation history.
A base-world agent cannot currently discover or reproduce it.

The pilot also exposed a balance problem. Starting with the public user journey keeps
the work grounded, but a purely surface-first repair can leave a shared, load-bearing
seam broken. Starting with an unrestricted root-cause investigation creates the
opposite failure: the investigation becomes a platform project before the user path
works.

## Design

### Canonical reference

Add `docs/reference/product-journey-sdlc.md` as the reusable component catalog. It is
installed with the existing reference set and is linked from
`docs/reference/sdlc-conventions.md`.

The catalog defines small components with stable IDs. Each component states when to
use or skip it, its inputs, responsible role, observable output, stop conditions, and
permitted next components. Missions select components; they do not inherit a fixed
mode.

### Component families

1. **Orientation and scope** — fresh-context start, recover intent from raw sources,
   or turn greenfield intent into the first complete user journey.
2. **Evidence** — exercise the public journey before implementation and distinguish
   product failure from housekeeping or runtime mismatch.
3. **Depth judgment** — `look-at-the-layer-below`, an optional one-level causal
   inspection when a surface repair would duplicate logic or leave a shared seam
   broken.
4. **Delivery** — build only the demonstrated gap, verify through the public surface,
   and independently review user value, readability, and unnecessary machinery.
5. **Integration** — integrate one complete outcome, adopt it into the disposable
   runtime when useful, and repeat the installed journey.
6. **Research** — stop build-shaped work when the intent depends on an unanswered
   product question; return evidence and a decision-ready gap instead.

### Look at the layer below

The component begins with a reproduced user failure and permits exactly one causal
descent. It is justified when multiple surfaces consume the same seam, a surface fix
would fork truth, or an adjacent consumer is predictably left broken. It is not
justified by possible future reuse, aesthetic architecture, or the opportunity to
create a framework.

Its output is a short depth decision:

> Descend one layer because X and Y consume the broken seam Z. Repair Z and retest X
> and Y.

or:

> Stay at the surface because the defect is local, the repair is complete, and no
> sibling consumes the behavior.

Another descent requires a new decision. This prevents both symptom patching and
open-ended root-cause excavation.

### Blank-agent entry

The existing `mission-slice-sop` skill remains the base-world entry point. It gains a
short section teaching a fresh agent to:

1. derive identity;
2. load `mission.yaml`, then the active `slice.yaml` if present;
3. state its role, user outcome, starting candidate, and boundaries;
4. load only the addressed references selected by the composition;
5. execute the selected components without treating old queue narrative as authority.

If no YAML composition exists, the current lightweight Part A remains the default.
The skill points to the reference; it does not duplicate the component definitions.

### YAML composition

`mission.yaml` selects mission defaults and declares the repository-relative catalog.
`slice.yaml` can select, omit, or order components for one outcome. Edges are explicit.
The YAML is an authored address map and dashboard prototype, not an enforcement engine.

Three example compositions ship in the reference:

- **Greenfield:** intent → first journey → optional depth decision → build → QA →
  review → integration.
- **Rescue:** recover intent → exercise the doghouse → salvage useful code → optional
  depth decision → restore one outcome at a time.
- **Recurring defect:** reproduce → inspect one layer below when earned → repair →
  retest the original and adjacent consumers.

### Pilot rebind

The 0.5.7 mission and source-cleanup slice gain component IDs matching what the pilot
actually did. Their existing prose and evidence remain; the YAML becomes the reusable,
machine-readable arrangement.

## Boundaries

- No new daemon workflow engine, schema, or enforcement gate.
- No new SDLC "mode" tied to a rig or topology.
- No duplicated reference content inside the skill or mission.
- No automatic descent toward a presumed root cause.
- No requirement that every mission use every component.
- No claim that the alpha YAML schema is already consumed automatically.

## Verification

- The new reference is included in package packing output.
- The base `mission-slice-sop` skill points to it and retains its retrieval budget.
- Addressed H2/H3 sections resolve with the existing Markdown resolver.
- The updated 0.5.7 YAML parses and names only component IDs defined in the catalog.
- The existing mission-slice skill tests and package packing checks pass.
