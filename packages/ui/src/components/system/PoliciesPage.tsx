// Slice 27 — Policies page wrapper.
//
// The slice 26 spec lands `/settings/policies` as the destination route for
// operator-tunable policies; slice 27 provides the first form (Claude
// auto-compaction). Until slice 26 merges, this page is reachable directly
// at /settings/policies via the route added in this slice; on integration,
// slice 26's Policies tab/explorer is expected to host the same component
// without further changes.

import { SectionHeader } from "../ui/section-header.js";
import { ClaudeCompactionPolicyForm } from "./ClaudeCompactionPolicyForm.js";

export function PoliciesPage() {
  return (
    <div data-testid="policies-page" className="mx-auto w-full max-w-[960px] px-6 py-8">
      <div className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">Settings</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-stone-900 mt-1">
          Policies
        </h1>
        <p className="mt-2 text-sm text-on-surface-variant max-w-prose">
          Opt-in policies that affect agent runtime behavior. Each policy
          ships disabled by default and can be turned on independently.
        </p>
      </div>
      <div className="flex flex-col gap-6">
        <ClaudeCompactionPolicyForm />
      </div>
    </div>
  );
}
