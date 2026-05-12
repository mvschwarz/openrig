// Slice 26 — Settings destination page shell.
//
// Common chrome (eyebrow + heading + content slot) for every Settings
// sub-route: /settings, /settings/policies, /settings/log,
// /settings/status. Replaces the in-place tab navigation that the old
// SettingsCenter used; the Explorer sidebar now handles destination
// switching, and each route mounts its own page-level component.

import type { ReactNode } from "react";
import { SectionHeader } from "../ui/section-header.js";

interface SettingsPageShellProps {
  /** Stable testid for the entire page wrapper (e.g., "settings-page-policies"). */
  testId: string;
  /** Display name shown as the page title — "Settings" / "Policies" / "Log" / "Status". */
  title: string;
  children: ReactNode;
}

export function SettingsPageShell({ testId, title, children }: SettingsPageShellProps) {
  return (
    <div
      data-testid={testId}
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Configuration</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          {title}
        </h1>
      </header>
      {children}
    </div>
  );
}
