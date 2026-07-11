---
id: OPR.0.4.7.3
slice: 03-shared-by-label
mission: release-0.4.7
status: planned
stage: wip
verified: 2026-07-11 — mini-requirements + proof contract + mockup authored by
  dev1.design
created: 2026-07-10
approved-spec-by: dev1-design@product-team
approved-spec-at: 2026-07-11T00:46:10.856Z
approved-by: dev1-qa@product-team
approved-at: 2026-07-11T01:49:25.159Z
---

# Slice 03 — Shared by label

## Intent

On album cards for albums someone else shared with me, show a compact Shared by [name] label. Keep it read-only and only display it when the current user is not the album owner. I want to know whose album I am opening before I click it.

## Mini-requirements

1. On album cards for albums shared with me (I am **not** the owner), a compact `Shared by [name]` line renders above the album title.
2. Name resolution — usable display name → `Shared by [display name]`; otherwise the literal `Shared by Album owner`. An email address or account/user id is **never** shown.
3. My own (owner) album cards show **no** Shared-by line and keep their current layout (no reserved gap, no shift).
4. The label is read-only text and appears identically in the `all` and `shared` library views. The album card stays the sole click target.
5. A long owner name truncates to a single line with an ellipsis; the label never wraps and never pushes the title or metadata line.

## Proof contract

Each item pairs with its proof via `rig proof add … --evidences <n> --media <files>`. `plannedRef` names the mockup section the delivered artifact is compared against (`mockups/shared-by-label.html`).

- [ ] **1. Shared card label** — a non-owner album card shows `Shared by [display name]` above the title. *(plannedRef: §shared-card)*
- [ ] **2. Privacy fallback** — a card whose owner has no usable display name shows the literal `Shared by Album owner`. *(plannedRef: §fallback-card)*
- [ ] **3. No identifier leak** — the label renders no email address and no raw account/user id in any state; verified by a focused test on the resolution rule. *(plannedRef: §fallback-card)*
- [ ] **4. Owner cards unchanged** — the current user's own album cards render with no Shared-by line and no layout shift versus today. *(plannedRef: §owner-card)*
- [ ] **5. Read-only** — the label is non-interactive text; the whole card remains the single link target (no nested link/button).
- [ ] **6. Long-name truncation** — a long owner name truncates to one line with an ellipsis, preserving the `Shared by` prefix, without wrapping or displacing the title/metadata. *(plannedRef: §long-name-card)*

## Scope

**Founder-approved behavior (exact, verbatim from founder return `qitem-20260711000531-c99c01b7`):**
- Non-owner cards: `Shared by [display name]`.
- Missing or unusable name: literal `Shared by Album owner`.
- Never display an email.
- Owner cards: omit the line.
- Read-only.

**In scope**
- Read-only `Shared by` label on album tiles in the library grid (`/app`), across the `all` and `shared` filters.
- Batched creator-name derivation added to the shared-album read path in `actions/albums.ts` (`getAlbumsForUser`).
- A **server-side resolved** `sharedByName` per shared album (see design contract below).

**Out of scope**
- The album detail page header (this slice is the library grid only).
- Any new sharing/invite functionality, owner profile page, or clickable owner link.
- Avatars, icons, or imagery — the label is type-only, matching the existing metadata style.
- Changes to owner cards beyond confirming they omit the line.

## Design contract (privacy invariant)

The read model resolves the label **server-side** and sends the UI only a finished string:

- `getAlbumsForUser()` returns, per **shared** album, a `sharedByName: string` already reduced to either the owner's usable display name **or** the literal `"Album owner"`.
- Owner albums return `sharedByName` as `null`/absent → the card renders no line.
- The UI performs **no** fallback logic and **never** receives the owner's email or id. This keeps the privacy rule in one place and makes item 3 (no identifier leak) structurally true, not just visually.
- "Usable display name" = a non-empty, trimmed human name. If the only available identifier is an email address or an opaque id, treat the name as absent → `"Album owner"`.

## Placement decision (for impl/QA — do not re-litigate)

The label is a **provenance eyebrow above the title**, between the cover image and the `<h3>` title: `text-xs`, muted (`text-muted-foreground`), single line, does not recolor on card hover.

Considered and rejected:
- *Prepend into the metadata line* (`Shared by Jane | 12 photos | …`) — flattens provenance into stats and forces the counts to wrap when the name is long.
- *Append to the metadata line* — buries the "whose album" answer last, defeating the pre-click glance goal.

## Risks

- The label must explain why the album appears in my library without disclosing private account information — mitigated by the server-side resolution contract above.
- Long/absent names must not break the tile layout — covered by proof items 4 and 6.

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md`; full flow: the `mission-slice-sop` skill. Author intent → mini-requirements + proof contract (→ mockups for UI slices) → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA visual compare → `rig proof add … --evidences --media` drops into `proof/` (never hand-place evidence without the drop) → proof-lock (`--scope delivery`). Track on PROGRESS.md; a slice is **not done** until every proof-contract item has evidence. Verify with `rig scope audit`.
