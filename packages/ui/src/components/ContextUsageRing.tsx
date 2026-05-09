// Token / Context Usage Surface v0 (PL-012) — small ring indicator for
// per-node context-usage tier on the topology graph header.
//
// Composes alongside PL-019's activity dot. Same dot-size + ring shape
// to read as "two parallel signals" rather than competing badges.
//
// Tiers (lockstep with daemon-side computeContextHealthSummary +
// existing RigNode big-number colors):
//   - >= 80% → red    (critical)
//   - >= 60% → amber  (warning)
//   - <  60% → green  (low / ok)
//   - unknown / no data → dotted gray
//
// The thresholds are not configurable at v0; if dogfood reveals
// operator-tunable thresholds are useful, NAMED v0+1 trigger applies.

interface ContextUsageRingProps {
  percent: number | null | undefined;
  fresh?: boolean;
  availability?: string;
  testIdSuffix?: string;
}

export type ContextUsageTier = "critical" | "warning" | "low" | "unknown";

export function deriveContextTier(
  percent: number | null | undefined,
  availability?: string,
): ContextUsageTier {
  if (availability !== "known" || typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

const TIER_BORDER_CLASS: Record<ContextUsageTier, string> = {
  critical: "border-red-500",
  warning: "border-amber-500",
  low: "border-emerald-500",
  unknown: "border-stone-400 border-dotted",
};

const TIER_TEXT_CLASS: Record<ContextUsageTier, string> = {
  critical: "text-red-600",
  warning: "text-amber-600",
  low: "text-green-700",
  unknown: "text-stone-300",
};

export function contextUsageTextClass(
  percent: number | null | undefined,
  fresh?: boolean,
  availability?: string | null,
): string {
  const tier = deriveContextTier(percent, availability ?? undefined);
  return `${TIER_TEXT_CLASS[tier]}${tier !== "unknown" && fresh === false ? " opacity-50" : ""}`;
}

export function ContextUsageRing({ percent, fresh, availability, testIdSuffix }: ContextUsageRingProps) {
  const tier = deriveContextTier(percent, availability);
  const titleParts: string[] = [];
  if (tier === "unknown") {
    titleParts.push("context: unknown");
  } else if (typeof percent === "number") {
    titleParts.push(`context: ${percent}% (${tier})`);
  }
  if (tier !== "unknown" && fresh === false) titleParts.push("stale sample");
  const title = titleParts.join(" · ");

  return (
    <span
      data-testid={testIdSuffix ? `context-ring-${testIdSuffix}` : "context-ring"}
      data-context-tier={tier}
      className={`inline-block h-2.5 w-2.5 rounded-full border-2 bg-transparent ${TIER_BORDER_CLASS[tier]}${
        tier !== "unknown" && fresh === false ? " opacity-50" : ""
      }`}
      aria-label={title || "context usage"}
      title={title || "context usage"}
    />
  );
}
