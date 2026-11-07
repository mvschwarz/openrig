// Slice 26 — Policies destination page; slice 27 — first policy entry
// (Claude auto-compaction form) ships inside the shared SettingsPageShell.

import { SettingsPageShell } from "./SettingsPageShell.js";
import { ClaudeCompactionPolicyForm } from "./ClaudeCompactionPolicyForm.js";

export function PoliciesPage() {
  return (
    <SettingsPageShell
      testId="settings-page-policies"
      title="Policies"
      description="Opt-in runtime policies for your agents. Each policy is off by default and can be turned on independently."
    >
      <div className="flex flex-col gap-6">
        <ClaudeCompactionPolicyForm />
      </div>
    </SettingsPageShell>
  );
}
