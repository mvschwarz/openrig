# Composable Product-Journey SDLC Implementation Plan

**Goal:** Ship a reusable, mission-composable product-journey SDLC reference and teach a base-world agent how to execute it from mission and slice YAML.

**Architecture:** The reference document is the single source of truth for component contracts and example compositions. `sdlc-conventions.md` indexes it, `mission-install.md` teaches discovery and loading through the existing SOP-to-SSOT chain, and the 0.5.7 YAML records the pilot composition without creating an execution engine.

**Tech Stack:** Markdown references, alpha mission/slice YAML, address resolution, YAML parsing, and package assembly checks.

---

### Task 1: Add the component catalog

**Files:**
- Create: `docs/reference/product-journey-sdlc.md`

**Steps:**

1. Write the component contract, stable component IDs, the doghouse/moon-base disclosure, and the `look-at-the-layer-below` depth decision.
2. Add greenfield, mission-rescue, and recurring-defect example compositions.
3. Add the blank-agent startup and YAML composition rules.
4. Read the document end to end and run `git diff --check`.

### Task 2: Add discovery from the shipped SDLC surfaces

**Files:**
- Modify: `docs/reference/sdlc-conventions.md`
- Modify: `docs/reference/mission-install.md`

**Steps:**

1. Add the product-journey catalog to the component menu and reference list.
2. Teach the shipped mission-install reference that `mission.yaml` and `slice.yaml` may select components, while Part A remains the fallback.
3. Preserve the frequently loaded `mission-slice-sop` unchanged; it already points to the conventions SSOT.
4. Verify the discovery chain by direct reads and address resolution.

### Task 3: Rebind the 0.5.7 pilot to component IDs

**Files:**
- Modify outside the repository after source integration:
  - `missions/release-0.5.7/mission.yaml`
  - `missions/release-0.5.7/slices/09-source-cleanup/slice.yaml`

**Steps:**

1. Snapshot both YAML files and record their pre-edit hashes.
2. Add the repository-root catalog address and mission-default components.
3. Record the source-cleanup pilot's actual rescue composition and explicit edges.
4. Preserve all existing evidence and candidate identity.
5. Parse both files and verify every selected component ID exists in the catalog.

### Task 4: Verify the shipped result

**Files:**
- No additional files unless a verification finding requires a minimal correction.

**Steps:**

1. Resolve representative H2 and H3 addresses with `loading-addressable-markdown`.
2. Parse the mission/slice YAML and validate every component and edge endpoint.
3. Run the package packing check and confirm `docs/reference/product-journey-sdlc.md` is present.
4. Re-read the shipped conventions, mission-install reference, and catalog from disk.
5. Run `git diff --check` and inspect the final repository/YAML diffs.

### Task 5: Integrate without runtime mutation

**Files:**
- Git refs only; no source-file changes.

**Steps:**

1. Commit the reference and reference-index changes on the documentation branch.
2. Fast-forward clean `main` only if it is still at the recorded base.
3. Update the workspace YAML after the reference is reachable from main.
4. Do not restart or adopt the daemon solely for documentation; the next normal runtime build will carry the installed references.
