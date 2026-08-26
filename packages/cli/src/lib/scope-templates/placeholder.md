---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# Slice {{slice_number}} — {{title}}

## Intent

{{intent}}

## Mini-requirements

1. [The concise one-glance requirement tier — numbered observable outcomes. For a small slice this may BE the whole plan.]

## Proof contract

- [ ] [One promised deliverable, written as an observable outcome — captured. Each item pairs with its proof via `rig proof add … --evidences` (media attached with `--media`); UI deliverables name their planned mockup.]

## Source material

- [Paths or refs]

## Intent visual

Non-visual slices: mark this section N/A.

- Intent image: ![Intent visual]({{intent_visual_image_path}})
- Durable diff: [change.diff]({{intent_visual_diff_path}})
- Regenerate preview: from `packages/ui`, run `{{intent_visual_build_command}}` to rebuild `twin-out/intent.html` (gitignored).

## Status

- TODO: [next steps]

## Dependencies

- [Cross-slice / cross-release]

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`); full flow: the `mission-slice-sop` skill. Author intent → mini-requirements + proof contract (→ mockups for UI slices) → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA visual compare → `rig proof add … --evidences --media` drops into `proof/` (never hand-place evidence without the drop) → proof-lock (`--scope delivery`). Track on PROGRESS.md; a slice is **not done** until every proof-contract item has evidence. Verify with `rig scope audit`.
