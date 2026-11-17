/**
 * Shared seat card pieces for the rig graph and topology cards: the runtime and provider line,
 * the model line, and a thin context bar.
 */
import { runtimeBrand } from "../lib/runtime-brand.js";
import { cn } from "../lib/utils.js";
import { RuntimeBadge } from "./graphics/RuntimeMark.js";

/** A model id split for display: "nvidia/google/gemma-4" gives provider "nvidia" and name "gemma-4". */
export interface SplitModelId {
  provider: string | null;
  name: string | null;
}

/** Split "provider/model-id" into its provider and its last path segment. A bare id has no provider. */
export function splitModelId(model: string | null | undefined): SplitModelId {
  if (!model) return { provider: null, name: null };
  const parts = model.split("/");
  if (parts.length < 2) return { provider: null, name: model };
  return { provider: parts[0] || null, name: parts[parts.length - 1] || model };
}

/**
 * Font size in px that keeps a model name on one line of `widthPx`: a monospace character is about
 * 0.6em wide. Never larger than 10px (the normal size) or smaller than 7px: below that the text stops
 * being readable, so a name longer than about 34 characters at 144px is cut with an ellipsis instead
 * and the full id stays in the hover title.
 */
export function fitModelFontSize(name: string, widthPx: number): number {
  return Math.max(7, Math.min(10, widthPx / (0.6 * Math.max(name.length, 1))));
}

/**
 * Two card lines: the runtime (icon and name) with the provider on the right, then the model alone.
 * With `fitWidthPx`, a long model name shrinks to fit that width, down to the 7px floor.
 */
export function SeatEngine({
  runtime,
  model,
  fitWidthPx,
}: {
  runtime: string | null | undefined;
  model: string | null | undefined;
  fitWidthPx?: number;
}) {
  const { provider, name } = splitModelId(model);
  const isTerminal = runtimeBrand(runtime).id === "terminal";
  const fontSize = name && fitWidthPx ? fitModelFontSize(name, fitWidthPx) : 10;
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <RuntimeBadge runtime={runtime} size="xs" compact variant="inline" className="min-w-0" />
        {provider ? (
          <span
            className="truncate font-mono text-[8px] uppercase tracking-[0.08em] text-on-surface-variant"
            data-testid="seat-provider"
          >
            {provider}
          </span>
        ) : null}
      </div>
      {name ? (
        <div
          className="truncate font-mono font-semibold leading-tight text-on-surface"
          style={{ fontSize: `${fontSize}px` }}
          data-testid="seat-model"
          title={model ?? undefined}
        >
          {name}
        </div>
      ) : isTerminal ? (
        // A terminal node has no model: say what it is instead of leaving a gap.
        <div className="truncate font-mono text-[10px] leading-tight text-on-surface-variant" data-testid="seat-model">
          shell · no agent
        </div>
      ) : null}
    </>
  );
}

/** A thin bar of the context used, in the same green, amber and red tiers as the percentage. */
export function ContextBar({
  percent,
  availability,
  fresh,
}: {
  percent: number | null | undefined;
  availability: string | undefined;
  fresh: boolean | undefined;
}) {
  const known = availability === "known" && typeof percent === "number";
  const state = !known ? "unknown" : fresh ? "fresh" : "stale";
  // Unknown context draws a dashed outline instead of an empty track, so it never reads as 0% used.
  return (
    <div
      className={cn("h-[3px]", known ? "bg-on-surface/10" : "border border-dashed border-outline-variant")}
      data-testid="context-bar"
      data-state={state}
      title={state === "unknown" ? "Context usage unknown" : state === "stale" ? "Context usage (stale sample)" : "Context usage (fresh)"}
    >
      {known ? (
        <div
          className={cn(
            "h-full",
            percent >= 80 ? "bg-red-600" : percent >= 60 ? "bg-amber-600" : "bg-green-700",
            fresh ? "" : "opacity-50",
          )}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      ) : null}
    </div>
  );
}
