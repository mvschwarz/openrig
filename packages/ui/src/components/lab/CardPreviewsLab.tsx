// V0.3.1 slice 21 onboarding-conveyor.
//
// /lab/card-previews — visual gallery of all for-you card kind
// variants with sample data. Doubles as a designer reference + a
// regression surface (the live feed and this gallery render the
// same card components, so visual divergence is immediately visible).
//
// Mirrors the `/lab/project-graphics-preview` pattern + uses
// VellumCard for the gallery section frames so the lab page itself
// looks like a curated specimen book.

import { VellumCard } from "../ui/vellum-card.js";
import {
  ApprovalCard,
  ConceptCard,
  IncidentCard,
  ProgressCard,
  ShippedCard,
} from "../feed/cards/storytelling-cards.js";
import { EmptyState } from "../ui/empty-state.js";

export function CardPreviewsLab() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-10" data-testid="card-previews-lab">
      <header className="space-y-2">
        <h1 className="font-mono text-[12px] uppercase tracking-[0.18em] text-stone-500">
          /lab/card-previews
        </h1>
        <p className="font-mono text-[11px] text-stone-700">
          Visual gallery of for-you card kind variants. Each section renders the
          same card component the live feed uses, with sample data. Use this
          surface to verify card variants render at intended visual weight
          without seeding a live feed.
        </p>
      </header>

      <VellumCard className="space-y-3 p-5">
        <SectionHeader title="Shipped" description="A slice merged + summary view. Used when a slice closes successfully and the feed surfaces it to operators downstream." />
        <ShippedCard
          source={{
            sliceId: "first-conveyor-run",
            title: "First Conveyor Run — shipped",
            oneLiner: "Slice merged at b71cddf. 4 commits + 1 proof packet.",
            sections: [
              { number: 1, heading: "Lint parses + validates entries", summary: "12 tests pass; UTF-8 edge cases handled." },
              { number: 2, heading: "Reviewer accepted with one concern", summary: "Combining-character edge addressed mid-flight." },
              { number: 3, heading: "Proof packet captured", summary: "CLI output screenshot + diff render." },
            ],
          }}
        />
      </VellumCard>

      <VellumCard className="space-y-3 p-5">
        <SectionHeader title="Incident / Action Required" description="A timeline-shaped surface for an in-flight or recent incident. Use status='warning' or 'danger' to surface attention; 'info' for informational; 'muted' for resolved." />
        <IncidentCard
          source={{
            sliceId: "auth-bearer-tailscale-trust",
            title: "Auth bearer tailscale trust — concerning",
            oneLiner: "Reviewer flagged loopback-only default at fix-1; remediated at fix-2.",
            status: "warning",
            recentEntries: [
              { time: "13:42", title: "Reviewer BLOCKING-CONCERN raised", status: "danger" },
              { time: "14:01", title: "Driver forward-fix scoped", status: "info" },
              { time: "14:38", title: "Forward-fix landed; gates green", status: "success" },
            ],
          }}
        />
      </VellumCard>

      <VellumCard className="space-y-3 p-5">
        <SectionHeader title="Progress" description="A mission-level progress card with percent + active-slice context. Used during a mission lifecycle to keep operators informed without requiring them to open the mission page." />
        <ProgressCard
          source={{
            missionId: "release-0.3.1",
            title: "Release 0.3.1 — in flight",
            oneLiner: "Wave 3a + 3b dispatches; multiple slices in review.",
            percent: 62,
            nextStep: "design-reviewer audit on slice 21 narrative voice",
            activeSlice: {
              id: "slice-21-onboarding-conveyor",
              label: "slice-21-onboarding-conveyor",
              status: "in-progress",
            },
          }}
        />
      </VellumCard>

      <VellumCard className="space-y-3 p-5">
        <SectionHeader title="Approval / Action Required" description="An operator-decision-needed surface. Renders the qitem context + the two action paths (Approve / Deny) the operator picks between." />
        <ApprovalCard
          source={{
            qitemId: "qitem-20260511201234-abcdef01",
            title: "Auth bearer tailscale trust — approve merge?",
            oneLiner: "All gates green; merge requires operator sign-off.",
            bodyPreview: "Triple-guard CLEAR. velocity-qa VM walk PASS. Ready for merge to main.",
            drillInHref: "/project/slice/auth-bearer-tailscale-trust",
            onApprove: () => {},
            onDeny: () => {},
          }}
        />
      </VellumCard>

      <VellumCard className="space-y-3 p-5">
        <SectionHeader title="Concept / Observation" description="A discovery / lab / scratch-pad surface. Used for not-yet-actionable observations, draft ideas, or comparison previews." />
        <ConceptCard
          source={{
            sliceId: "concept-storytelling-primitives",
            title: "Storytelling primitives — concept",
            oneLiner: "Could replace one-off card components with kind-frame primitives.",
            comparePreview: [
              { label: "Card kinds", valueOld: "5 components", valueNew: "1 kind-frame + 5 sources" },
              { label: "Visual variance", valueOld: "drift over time", valueNew: "centralized accent tokens" },
              { label: "Maintenance", valueOld: "edit each component", valueNew: "edit kind-frame once" },
            ],
          }}
        />
      </VellumCard>

      <VellumCard className="space-y-3 p-5">
        <SectionHeader title="Empty state" description="What the for-you feed shows when no events qualify. Reusable across surfaces; the EmptyState primitive is the canonical pattern." />
        <EmptyState
          label="ALL CAUGHT UP"
          description="No new events. Spin up a rig or declare a slice to populate this feed."
          variant="card"
          testId="card-previews-empty-state"
        />
      </VellumCard>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1 border-b border-stone-200 pb-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-900">{title}</h2>
      <p className="font-mono text-[10px] text-stone-600">{description}</p>
    </div>
  );
}
