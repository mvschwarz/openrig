// Slice 26 — Policies destination page; slice 27 — first policy entry
// (Claude auto-compaction form) ships inside the shared SettingsPageShell.

import { SettingsPageShell } from "./SettingsPageShell.js";
import { ClaudeCompactionPolicyForm } from "./ClaudeCompactionPolicyForm.js";

export function PoliciesPage() {
  return (
    <SettingsPageShell testId="settings-page-policies" title="Policies">
      <p className="mb-6 text-sm text-on-surface-variant max-w-prose">
        Opt-in policies that affect agent runtime behavior. Each policy ships
        disabled by default and can be turned on independently.
      </p>
      <div className="flex flex-col gap-6">
        <ClaudeCompactionPolicyForm />
      </div>
    </SettingsPageShell>
  );
}
