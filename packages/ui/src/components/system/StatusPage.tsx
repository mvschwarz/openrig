// Slice 26 — Status destination page (route-driven).
//
// Lifts the SettingsSystemStatusPanel that used to live inside
// SettingsCenter's inline tab. Mounted at /settings/status via its
// own page.

import { SettingsPageShell } from "./SettingsPageShell.js";
import { SettingsSystemStatusPanel } from "./SettingsSystemStatusPanel.js";

export function StatusPage() {
  return (
    <SettingsPageShell
      testId="settings-page-status"
      title="Status"
      description="Daemon reachability, adapter availability, and rig counts at a glance."
    >
      <SettingsSystemStatusPanel />
    </SettingsPageShell>
  );
}
