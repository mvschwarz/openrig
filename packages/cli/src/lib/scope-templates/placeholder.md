---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
---

# Slice {{slice_number}} — {{title}}

## Goal

[1-2 sentence goal.]

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

## Acceptance

- [3-5 bullets]

---

> **How you work this slice (SOP):** track on PROGRESS.md, prove on PROOF.md (+ `proof/`), carry state in the mission's MISSION_NOTES.md, and hand off via `rig queue`. A slice is **not done until PROOF.md exists** and every acceptance bullet has evidence. The full operating procedure lives in the mission README's Mission/Slice SOP section and the `mission-slice-sop` skill. Verify with `rig scope audit`.
