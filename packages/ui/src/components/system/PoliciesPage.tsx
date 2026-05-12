// Slice 26 — Policies destination page (empty scaffold).
//
// Renders an empty-state placeholder. First policy entry lands in
// slice 27 (Claude compaction policy). The scaffold ensures the
// route exists + the Explorer navigation works end-to-end before any
// policy content is added.

import { SettingsPageShell } from "./SettingsPageShell.js";
import { EmptyState } from "../ui/empty-state.js";

export function PoliciesPage() {
  return (
    <SettingsPageShell testId="settings-page-policies" title="Policies">
      <EmptyState
        label="NO POLICIES CONFIGURED"
        description="Policies control automated agent behaviors — when to compact a Claude session, how to escalate stale work, and similar runtime rules. Configured policies will be listed here and editable in place."
        variant="card"
        testId="policies-empty-state"
      />
    </SettingsPageShell>
  );
}
