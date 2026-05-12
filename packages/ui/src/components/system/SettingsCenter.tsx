// Slice 26 — Settings destination root page (route-driven; was 3-tab).
//
// Previously a CENTER workspace with 3 inline tabs (settings / log /
// status). Per slice 26 release-0.3.1, Settings becomes a 4-destination
// Explorer peer to Topology / Project / Library / For-You: the
// Explorer sidebar holds the 4 destinations (Settings / Policies / Log
// / Status) and each is its own route. SettingsCenter now renders just
// the /settings index — the config keys form (SettingsTab) wrapped in
// the shared SettingsPageShell chrome. LogPage / StatusPage /
// PoliciesPage are siblings under /settings/* routes.

import { SettingsPageShell } from "./SettingsPageShell.js";
import { SettingsTab } from "./SettingsTab.js";

export function SettingsCenter() {
  return (
    <SettingsPageShell testId="settings-center" title="Settings">
      <SettingsTab />
    </SettingsPageShell>
  );
}
