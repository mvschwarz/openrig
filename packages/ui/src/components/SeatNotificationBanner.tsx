// V0.3.1 slice 25 follow-on — Seat detail notification banner.
//
// Renders detailed activity / attention messages ABOVE the
// SeatOverviewTable on the Overview tab so operators see them
// immediately. Hidden when no active message exists; takes no space.
//
// Source-of-truth fields on NodeDetailData:
//   - latestError (string | null) — surfaces failed startup error
//     text and any other runtime errors the daemon has cached.
//   - recoveryGuidance ({summary, commands[], notes[]} | null) — the
//     daemon-curated guidance block for getting the seat unstuck.
//   - startupStatus ("attention_required" | "failed" | ...) — the
//     attention/failed states drive the visual variant + headline.
//
// The same data is also rendered (in fuller form) by StatusSection
// in the Details tab; this banner is a slim, front-and-center
// surfacing of the headline-grade information for the Overview tab.
// Both surfaces read from the SAME NodeDetailData fields — no
// parallel pipeline.

import { Alert, AlertDescription, AlertTitle } from "./ui/alert.js";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";

interface SeatNotificationBannerProps {
  data: NodeDetailData;
}

function headlineFor(data: NodeDetailData): string | null {
  if (data.startupStatus === "failed") return "Startup failed";
  if (data.startupStatus === "attention_required") return "Attention required";
  if (data.latestError) return "Error";
  return null;
}

function variantFor(data: NodeDetailData): "default" | "destructive" {
  if (data.startupStatus === "failed") return "destructive";
  if (data.latestError && data.startupStatus !== "attention_required") return "destructive";
  return "default";
}

export function SeatNotificationBanner({ data }: SeatNotificationBannerProps) {
  const headline = headlineFor(data);
  const hasError = !!data.latestError;
  const hasGuidance = !!data.recoveryGuidance;

  // Nothing to surface — render nothing (takes no space).
  if (!headline && !hasError && !hasGuidance) return null;

  return (
    <Alert
      data-testid="seat-notification-banner"
      data-startup-status={data.startupStatus ?? "unknown"}
      variant={variantFor(data)}
    >
      {headline ? (
        <AlertTitle data-testid="seat-notification-headline" className="font-mono text-[11px] uppercase tracking-[0.08em]">
          {headline}
        </AlertTitle>
      ) : null}
      {hasError ? (
        <AlertDescription
          data-testid="seat-notification-error"
          className="font-mono text-[10px]"
        >
          {data.latestError}
        </AlertDescription>
      ) : null}
      {hasGuidance && data.recoveryGuidance ? (
        <AlertDescription
          data-testid="seat-notification-guidance"
          className="mt-1 font-mono text-[10px] text-stone-700"
        >
          {data.recoveryGuidance.summary}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}
