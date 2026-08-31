# Product-journey SDLC components

This is a reusable menu for building the smallest complete user outcome. A
mission or slice selects only the components its work needs and records their
order in mission/slice YAML. This is **not a mode, pipeline, topology, rig
shape, or mandatory gate set**. If no composition is present, use the light
Part A flow in `sdlc-conventions.md`.

## The doghouse and the moon base

The **doghouse** is the actual product outcome the user asked for. A
**missing door** is an implementation that may be polished internally but
cannot perform its basic user job. A **moon base** is elaborate machinery—
often guards, abstractions, proof ceremony, security theatre, or process
scaffolding—that consumes most of the effort without making the doghouse work.

Use that disclosure ladder in this order:

1. Name the doghouse in one sentence, without process vocabulary.
2. Exercise its door through the public surface before admiring internals.
3. Repair the smallest missing product seam.
4. Consider deeper machinery only when evidence shows the layer below is
   causing the visible failure.
5. Remove or decline anything that does not protect or deliver a named user
   outcome.

The same discipline works for a new mission and for rescuing one that drifted.
In a new mission, it prevents the moon base. In a rescue, it finds whether a
usable doghouse remains and separates it from machinery that should not be
carried forward.

## Component contract

Every component below states:

- **Use when** — the evidence that admits it.
- **Skip when** — the cheapest reason not to run it.
- **Input** — what the responsible agent must actually read or observe.
- **Action** — the bounded work performed.
- **Output** — the artifact or observable result handed to the next component.
- **Stop** — the boundary that prevents the component expanding itself.
- **Next** — the normal successor; YAML may choose another explicit edge.

Component IDs are stable addresses. Their prose may improve without forcing
mission YAML to change.

## Component catalog

### context.fresh-start

- **Use when:** prior context may carry stale architecture, verdicts, or
  implementation momentum.
- **Skip when:** the current agent can independently state the user outcome,
  starting candidate, and boundaries from primary sources.
- **Input:** world install, mission/slice YAML, and the addresses it names.
- **Action:** start or clear a session, load only the selected context, and
  derive current identity and source state.
- **Output:** a one-paragraph readiness statement naming role, user outcome,
  starting candidate, and boundaries.
- **Stop:** do not reconstruct old queue lore merely because it exists.
- **Next:** `intent.recover` or `journey.choose`.

### intent.recover

- **Use when:** work already exists but may have drifted from founder or user
  intent.
- **Skip when:** this is greenfield work with one current, unambiguous intent.
- **Input:** the earliest authoritative intent, later mission/slice specs,
  candidate code, and observed user behavior.
- **Action:** distinguish requirements from later planner elaboration; identify
  the smallest still-required outcomes and explicit anti-goals.
- **Output:** a concise salvage map: keep, inspect, and not-required—never a
  destructive verdict by itself.
- **Stop:** do not treat prior review intensity or sunk cost as product value.
- **Next:** `journey.probe`.

### journey.choose

- **Use when:** a new mission has intent but no proven product path yet.
- **Skip when:** `intent.recover` already names the next smallest outcome.
- **Input:** authoritative intent and current public product surface.
- **Action:** select one end-to-end user journey whose completion provides
  standalone value.
- **Output:** one observable outcome plus its smallest credible public probe.
- **Stop:** one outcome only; adjacent capability is another composition.
- **Next:** `journey.probe`.

### journey.probe

- **Use when:** always, before product code is added or rescued.
- **Skip when:** never; scale the probe down instead.
- **Input:** the public CLI, API, UI, or other surface a real user operates.
- **Action:** run the smallest disposable end-to-end journey and inspect its
  effects, not merely its exit status.
- **Output:** PASS with no code needed, or one concrete user-visible gap with
  preserved evidence.
- **Stop:** a passing journey does not authorize speculative hardening.
- **Next:** finish on PASS; otherwise `depth.look-below` or
  `build.minimal-gap`.

### depth.look-below

- **Use when:** the public failure recurs, crosses a component boundary, is
  contradicted by lower-level state, or a surface patch would duplicate logic
  already owned below.
- **Skip when:** the failure is local, understood, and repairable at the public
  seam without duplication; also skip when the only argument is “more robust.”
- **Input:** one observed public failure and the immediately responsible seam.
- **Action:** descend **one layer only**; state the causal hypothesis, name the
  lower-layer observation that would falsify it, and inspect or probe that
  layer.
- **Output:** one of three depth decisions:
  - `LOCAL` — repair the public seam;
  - `BELOW` — repair the named load-bearing seam and replay the public journey;
  - `HOUSEKEEPING` — repair environment/data/topology hygiene before changing
    product code.
- **Stop:** one descent per admission. A second descent requires new evidence
  and a newly stated hypothesis. “While here,” generalized prevention, and
  unrelated cleanup are out of scope.
- **Next:** `build.minimal-gap`, `research.before-build`, or housekeeping.

This component is the balance point. Refusing ever to look below produces
surface patches and recurring defects. Looking below without an evidence gate
produces a moon base. The aim is the first load-bearing seam, not the deepest
possible explanation.

### research.before-build

- **Use when:** the causal hypothesis depends on an unstable external fact or
  a product contract that cannot be derived locally.
- **Skip when:** source, runtime state, and the public probe already establish
  the mechanism.
- **Input:** one answerable uncertainty and its decision consequence.
- **Action:** acquire only enough primary evidence to decide the implementation
  shape.
- **Output:** decision, citations, and remaining uncertainty.
- **Stop:** research ends when the implementation decision is supported.
- **Next:** `build.minimal-gap`.

### build.minimal-gap

- **Use when:** a failed journey and causal seam are established.
- **Skip when:** `journey.probe` passed or the finding is housekeeping rather
  than code.
- **Input:** the user-visible gap, depth decision, existing seam, and explicit
  boundaries.
- **Action:** add the shortest readable change that completes the journey,
  reusing the existing product seam.
- **Output:** one clean candidate and focused evidence of the failure changing
  for the stated reason.
- **Stop:** no new framework, security layer, schema, abstraction, or adjacent
  verb unless the outcome cannot work without it.
- **Next:** `qa.public-journey`.

### qa.public-journey

- **Use when:** a candidate claims a complete user outcome.
- **Skip when:** never before integration; it may be held by the builder on a
  tiny change only when independence was not selected.
- **Input:** exact candidate, original public probe, and boundaries.
- **Action:** run the journey from the user surface in a disposable context;
  inspect resulting state and partial-failure behavior.
- **Output:** CLEAR or one concrete mismatch.
- **Stop:** QA does not redesign the product or demand unselected ceremony.
- **Next:** `review.scope-maintainability` or back to `build.minimal-gap`.

### review.scope-maintainability

- **Use when:** independent review is selected for the outcome.
- **Skip when:** the composition deliberately keeps a low-risk change within
  the light single-agent path.
- **Input:** exact candidate, intent, public QA evidence, and base diff.
- **Action:** judge correctness, readability, necessity, reuse of existing
  seams, and whether the public journey—not an internal proxy—works.
- **Output:** CLEAR or a bounded source/product finding.
- **Stop:** a reviewer may not ratchet rigor merely because prior review found
  something; review the product, not the ceremony.
- **Next:** `integrate.one-outcome` or back to `build.minimal-gap`.

### integrate.one-outcome

- **Use when:** the selected evidence for one outcome is complete.
- **Skip when:** the candidate is not clear or its base moved incompatibly.
- **Input:** exact candidate identity and selected QA/review results.
- **Action:** integrate the smallest coherent outcome and keep unrelated
  candidates separate.
- **Output:** clean canonical source containing one additional user outcome.
- **Stop:** do not batch unrelated salvage because it shares a release label.
- **Next:** `runtime.adopt` or the next `journey.choose`.

### runtime.adopt

- **Use when:** the outcome needs installed-runtime or migration proof.
- **Skip when:** source-level proof is sufficient and no live behavior changed.
- **Input:** clean canonical commit, rollback boundary, and runtime SOP.
- **Action:** build/package/install the exact commit, switch atomically, and
  verify health plus continuity.
- **Output:** exact live version and preserved rollback point.
- **Stop:** adoption is deployment, not permission to change topology or data.
- **Next:** `qa.installed-smoke`.

### qa.installed-smoke

- **Use when:** `runtime.adopt` ran or packaging/path resolution is part of the
  product claim.
- **Skip when:** no installed artifact or runtime behavior is in scope.
- **Input:** exact live version and disposable public journey.
- **Action:** exercise the installed command path and verify effects and
  cleanup.
- **Output:** installed-runtime CLEAR or one concrete mismatch.
- **Stop:** do not convert a smoke test into fleet-wide monitoring.
- **Next:** finish the outcome or return to `build.minimal-gap`.

## Composition rules

1. `mission.yaml` may declare the catalog and mission defaults.
2. `slice.yaml` selects or overrides the components for that slice.
3. Edges are explicit data. Array order is presentation, not dependency.
4. Select the fewest components that honestly fit the work.
5. A component may be held by the same seat as its neighbor unless independence
   is an intentional property of the composition.
6. YAML describes the work; it is not an enforcement engine and creates no
   automatic gates.

Repository-address example:

```yaml
sdlc:
  catalog:
    root: repository
    address: docs/reference/product-journey-sdlc.md#component-catalog
  components:
    - id: journey.choose
      owner: planner
    - id: journey.probe
      owner: qa
    - id: depth.look-below
      owner: builder
      admission: evidence-gated
    - id: build.minimal-gap
      owner: builder
    - id: qa.public-journey
      owner: qa
  edges:
    - from: journey.choose
      to: journey.probe
    - from: journey.probe
      to: depth.look-below
      when: public failure needs causal discrimination
    - from: journey.probe
      to: build.minimal-gap
      when: local gap is already established
    - from: depth.look-below
      to: build.minimal-gap
      when: decision is LOCAL or BELOW
    - from: build.minimal-gap
      to: qa.public-journey
```

Resolve repository addresses from `git rev-parse --show-toplevel`. Use the
`loading-addressable-markdown` skill for `path#h2-slug` and
`path#h2-slug/h3-slug` addresses outside the context library.

## Example compositions

### Greenfield product journey

`context.fresh-start → journey.choose → journey.probe →
build.minimal-gap → qa.public-journey → review.scope-maintainability →
integrate.one-outcome`

Add `depth.look-below` only when the probe meets its admission rule. A new
mission does not need rescue archaeology.

### Drifted-mission rescue

`context.fresh-start → intent.recover → journey.probe →
depth.look-below? → build.minimal-gap → qa.public-journey →
review.scope-maintainability → integrate.one-outcome`

The question is not “which old commits pass review?” It is “which required
user outcome works, what prevents the next one, and how little code completes
it?”

### Recurring cross-layer defect

`journey.probe → depth.look-below → research.before-build? →
build.minimal-gap → qa.public-journey → qa.installed-smoke?`

The recurrence admits one causal descent. It does not authorize a general
platform rewrite.

## Blank-agent start

An agent with only the base world install should:

1. Read `mission.yaml`, then the active `slice.yaml`.
2. Resolve the catalog address and only the additional addresses those files
   name.
3. State: **my role; the user outcome; the starting candidate; the
   boundaries**.
4. Follow the selected component edges and their stop conditions.
5. If no composition exists, use Part A in `mission-slice-sop`.
6. If current reality contradicts the YAML, stop treating the YAML as fact,
   record the discrepancy, and re-derive from the public journey and source.
