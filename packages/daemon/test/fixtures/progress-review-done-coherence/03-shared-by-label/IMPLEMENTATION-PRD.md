---
id: OPR.0.4.7.3
slice: 03-shared-by-label
mission: release-0.4.7
status: planned
stage: wip
created: 2026-07-10
---

# Slice 03 — Shared by label (Implementation PRD)

## Intent

On album cards for albums someone else shared with me, show a compact Shared by [name] label. Keep it read-only and only display it when the current user is not the album owner. I want to know whose album I am opening before I click it.

## Mini-requirements

1. On album cards for albums shared with me (I am **not** the owner), a compact `Shared by [name]` line renders above the album title.
2. Name resolution — usable display name → `Shared by [display name]`; otherwise the literal `Shared by Album owner`. An email address or account/user id is **never** shown.
3. My own (owner) album cards show **no** Shared-by line and keep their current layout.
4. The label is read-only text and appears identically in the `all` and `shared` library views.
5. A long owner name truncates to a single line with an ellipsis; the label never wraps or displaces the title/metadata.

## Proof contract

Mirrors `README.md#proof-contract`. Each item pairs with its proof via `rig proof add … --evidences <n> --media <files>`; `plannedRef` names the section of `mockups/shared-by-label.html` the delivered artifact is compared against.

- [ ] **1. Shared card label** — a non-owner album card shows `Shared by [display name]` above the title. *(plannedRef: §shared-card)*
- [ ] **2. Privacy fallback** — a card whose owner has no usable display name shows the literal `Shared by Album owner`. *(plannedRef: §fallback-card)*
- [ ] **3. No identifier leak** — the label renders no email address and no raw account/user id in any state; verified by a focused test on the resolution rule. *(plannedRef: §fallback-card)*
- [ ] **4. Owner cards unchanged** — the current user's own album cards render with no Shared-by line and no layout shift versus today. *(plannedRef: §owner-card)*
- [ ] **5. Read-only** — the label is non-interactive text; the whole card remains the single link target (no nested link/button).
- [ ] **6. Long-name truncation** — a long owner name truncates to one line with an ellipsis, preserving the `Shared by` prefix, without wrapping or displacing the title/metadata. *(plannedRef: §long-name-card)*

## Surface (confirmed by R2 trace, confidence 98%)

Minimal, bounded change across two files already read:

### 1. Read model — `actions/albums.ts` → `getAlbumsForUser()`

- Extend `AlbumSummary` with `sharedByName: string | null`.
- For the **shared** set only, batch-derive the owner's name from each album's `createdByUserId` (single batched lookup keyed by the shared albums' creator ids — do **not** N+1 per card; follow the existing `Promise.all` + `Map` batching pattern used for asset/member counts and covers).
- Resolve each name to the final string **server-side**: usable display name → that name; otherwise the literal `"Album owner"`. Never return an email or id in this field.
- Map: `owned` albums → `sharedByName: null`; `shared` albums → the resolved string.

  > The name source is the owner user record reachable from `createdByUserId`. "Usable display name" = non-empty trimmed human name; an email or opaque id counts as *not usable* → `"Album owner"`. Confirm the exact user field during build; if no human-name field exists yet, every shared card correctly falls back to `Album owner` and the slice still ships truthfully.

### 2. UI — `app/(authenticated)/app/page.tsx` → `AlbumTile`

- Add `sharedByName: string | null` to the `AlbumTile` album prop type.
- When `sharedByName` is non-null, render the eyebrow **above** the `<h3>` title:

  ```tsx
  {album.sharedByName && (
    <p className="text-xs font-medium text-muted-foreground truncate">
      Shared by {album.sharedByName}
    </p>
  )}
  ```

  - `truncate` = single line + ellipsis (matches the existing tight metadata typography; one weight lighter and muted so it reads as provenance, not stats).
  - It sits inside the existing card `<Link>`; the card stays the single click target — do **not** add a nested link/button.
  - Keep it muted on hover (do not inherit the title's blue hover). The title's `group-hover:text-[rgb(0,122,255)]` is scoped to the `<h3>`; leave the eyebrow out of that.
- Owner cards: `sharedByName` is null → nothing renders, no reserved gap.

> **Truncation gotcha (verified in the mockup):** for the eyebrow's `truncate` to actually clip, the tile must be able to shrink below its content width. The tile is a grid item and grid items default to `min-width:auto`, so a `whitespace-nowrap` eyebrow otherwise stretches the whole cell instead of ellipsizing. Add **`min-w-0`** to the `AlbumTile` `<Link>` (the grid item). Without it, proof item 6 fails and a long name blows out the column. This was caught rendering `mockups/shared-by-label.html`.

## Design contract (privacy invariant)

The UI does **no** fallback logic and never receives an email/id. All resolution happens in the read model (§1). This makes proof item 3 structurally true. See `README.md#design-contract-privacy-invariant`.

## Tests (focused)

- Resolution rule unit test: display-name present → name; blank/whitespace name → `"Album owner"`; email-only / id-only identifier → `"Album owner"`; never returns a string containing `@`.
- Read-model shape: `owned` entries have `sharedByName: null`; `shared` entries have a non-empty resolved string.

## Non-goals

Album detail header, sharing/invite flows, owner profile links, avatars/icons. See `README.md#scope`.
