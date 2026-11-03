// Slice 26 — Settings destination page shell.
//
// Common chrome for every Settings sub-route: /settings,
// /settings/policies, /settings/log, /settings/status. Renders a
// sentence-case PageHeader (C14d) plus the page content slot.

import type { ReactNode } from "react";
import { PageHeader } from "../ui/page-header.js";

interface SettingsPageShellProps {
  /** Stable testid for the entire page wrapper (e.g., "settings-page-policies"). */
  testId: string;
  /** Display name shown as the page title — "Settings" / "Policies" / "Log" / "Status". */
  title: string;
  /** One-sentence description of what the page is for. */
  description: string;
  children: ReactNode;
}

export function SettingsPageShell({ testId, title, description, children }: SettingsPageShellProps) {
  return (
    <div
      data-testid={testId}
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <PageHeader title={title} description={description} />
      {children}
    </div>
  );
}
