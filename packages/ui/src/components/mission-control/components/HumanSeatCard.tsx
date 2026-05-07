// PL-005 Phase A: first-class human-seat rendering.
//
// Per founder Q3 (2026-05-03): human queues are first-class product
// concepts, NOT invisible config-layer convention. Mission Control
// renders the operator's human seat (default `human-wrandom@kernel`)
// with its own card showing identity + load + capabilities.
//
// V1 attempt-3 Phase 5 P5-8: refactored to compose VellumCard primitive
// (Phase 1) — replaces the ad-hoc `border border-stone-300 bg-stone-50`
// chrome with the canonical vellum aesthetic (cream paper background +
// 1px outline-variant border + RegistrationMarks + hard-shadow). Aligns
// HumanSeatCard with the V1 tactical-dossier visual language for the
// design-reviewer "professional grade met" V1 ship gate verdict.

import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { StatusPip } from "../../ui/status-pip.js";
import type { CompactStatusRow } from "../hooks/useMissionControlView.js";

export interface HumanSeatCardProps {
  /** Canonical session label, e.g., `human-wrandom@kernel`. */
  session: string;
  /** Pending human-gate items (for load indication). */
  rows: CompactStatusRow[];
  /** Optional capabilities label (which verbs this seat can fire). */
  capabilities?: string[];
}

export function HumanSeatCard({
  session,
  rows,
  capabilities = ["approve", "deny", "route", "annotate", "hold", "drop", "handoff"],
}: HumanSeatCardProps) {
  const pendingCount = rows.filter(
    (r) => r.state === "idle" || r.state === "attention" || r.state === "blocked",
  ).length;
  const blockedCount = rows.filter((r) => r.state === "blocked").length;
  // Reflect attention level via the same StatusPip taxonomy used elsewhere
  // (warning for blocked, info for plain pending). Keeps the card's
  // semantic palette aligned with the rest of V1.
  const pendingTone =
    blockedCount > 0 ? "warning" : pendingCount > 0 ? "info" : "active";
  return (
    <VellumCard
      testId="mc-human-seat-card"
      data-session={session}
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <SectionHeader tone="muted">Human seat</SectionHeader>
            <div
              data-testid="mc-human-seat-session"
              className="mt-1 font-mono text-sm text-stone-900 truncate"
            >
              {session}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div
              data-testid="mc-human-seat-pending"
              className="font-mono text-2xl font-bold text-stone-900 leading-none"
            >
              {pendingCount}
            </div>
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant mt-1">
              pending
            </div>
          </div>
        </div>
        {blockedCount > 0 ? (
          <div className="mt-3 flex items-center gap-2">
            <StatusPip
              status="warning"
              label={`${blockedCount} blocked`}
              variant="pill"
              testId="mc-human-seat-blocked"
            />
          </div>
        ) : (
          <div className="mt-3">
            <StatusPip
              status={pendingTone}
              label={pendingCount === 0 ? "all clear" : `${pendingCount} pending`}
              variant="pill"
            />
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-1">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="border border-outline-variant px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-on-surface-variant bg-white/30"
            >
              {cap}
            </span>
          ))}
        </div>
      </div>
    </VellumCard>
  );
}
