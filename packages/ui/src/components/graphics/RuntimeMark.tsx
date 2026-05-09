import type { RuntimeBrandId } from "../../lib/runtime-brand.js";
import { normalizeRuntimeBrandId, runtimeBrand } from "../../lib/runtime-brand.js";
import type { ToolBrandId } from "../../lib/tool-brand.js";
import { normalizeToolBrandId, toolBrand } from "../../lib/tool-brand.js";
import { cn } from "../../lib/utils.js";

export interface RuntimeMarkProps {
  runtime: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  title?: string;
  decorative?: boolean;
}

export type OperatorMood = "cool" | "urgent" | "calm";

const sizeClass = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-9 w-9",
};

const badgeSizeClass = {
  xs: "gap-1 px-1 py-0.5 text-[8px]",
  sm: "gap-1.5 px-1.5 py-0.5 text-[9px]",
  md: "gap-2 px-2 py-1 text-[10px]",
  lg: "gap-2.5 px-2.5 py-1.5 text-[11px]",
};

const inlineSizeClass = {
  xs: "gap-1 text-[8px]",
  sm: "gap-1.5 text-[9px]",
  md: "gap-2 text-[10px]",
  lg: "gap-2.5 text-[11px]",
};

const toneClass: Record<RuntimeBrandId, string> = {
  "claude-code": "border-[#9f5f4e]/40 bg-[#b06a57]/12 text-[#62392f]",
  codex: "border-stone-400/50 bg-white/75 text-stone-950",
  terminal: "border-stone-400/45 bg-stone-900/8 text-stone-800",
  unknown: "border-stone-300 bg-white/55 text-stone-600",
};

const inlineToneClass: Record<RuntimeBrandId, string> = {
  "claude-code": "text-[#62392f]",
  codex: "text-stone-950",
  terminal: "text-stone-800",
  unknown: "text-stone-600",
};

const toolToneClass: Record<ToolBrandId, string> = {
  cmux: "border-cyan-400/45 bg-cyan-50/75 text-cyan-950",
  tmux: "border-emerald-400/45 bg-emerald-50/75 text-emerald-950",
  vscode: "border-sky-400/45 bg-sky-50/75 text-sky-950",
  screenshot: "border-amber-400/45 bg-amber-50/75 text-amber-950",
  terminal: "border-stone-400/45 bg-stone-900/8 text-stone-800",
  file: "border-stone-300 bg-white/60 text-stone-700",
  unknown: "border-stone-300 bg-white/55 text-stone-600",
};

const operatorClimberMarkSrc = "/graphics/operator-climber-monochrome.png";

function glyphA11y(title: string, decorative?: boolean) {
  return decorative ? { "aria-hidden": true } : { "aria-label": title, role: "img" as const };
}

function ClaudeGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className} shapeRendering="crispEdges">
      <rect x="3" y="2" width="10" height="8" fill="#ad6755" />
      <rect x="1" y="5" width="2" height="3" fill="#ad6755" />
      <rect x="13" y="5" width="2" height="3" fill="#ad6755" />
      <rect x="4" y="10" width="2" height="3" fill="#ad6755" />
      <rect x="7" y="10" width="2" height="3" fill="#ad6755" />
      <rect x="10" y="10" width="2" height="3" fill="#ad6755" />
      <rect x="5" y="4" width="1" height="2" fill="#181818" />
      <rect x="10" y="4" width="1" height="2" fill="#181818" />
    </svg>
  );
}

function CodexGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <circle cx="8" cy="8" r="5.7" fill="#fafaf9" stroke="#0c0a09" strokeWidth="1.25" />
      <path d="M5.8 6.35 7.25 8 5.8 9.65" fill="none" stroke="#0c0a09" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.65 9.65h2.25" fill="none" stroke="#0c0a09" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function TerminalGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <rect x="2" y="3" width="12" height="10" fill="#1c1917" />
      <path d="M4 6 6 8 4 10" fill="none" stroke="#fafaf9" strokeWidth="1.2" strokeLinecap="square" strokeLinejoin="miter" />
      <path d="M7.5 10h4" fill="none" stroke="#fafaf9" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

function CmuxGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <defs>
        <linearGradient id="cmux-preview-mark" x1="3" x2="13" y1="3" y2="13" gradientUnits="userSpaceOnUse">
          <stop stopColor="#20d5f4" />
          <stop offset="1" stopColor="#4357ff" />
        </linearGradient>
      </defs>
      <path d="M4.1 2.7 12.3 8l-8.2 5.3V9.9L7.8 8 4.1 6.1z" fill="url(#cmux-preview-mark)" />
    </svg>
  );
}

function TmuxGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <path d="M2.1 3.5c0-.8.6-1.4 1.4-1.4h9c.8 0 1.4.6 1.4 1.4v9c0 .8-.6 1.4-1.4 1.4h-9c-.8 0-1.4-.6-1.4-1.4z" fill="#3a3a39" />
      <path d="M7.5 2.1v8.7M7.5 6.3h6.4" stroke="#f8fafc" strokeWidth="0.7" />
      <path d="M2.1 11.1h11.8v1.4c0 .8-.6 1.4-1.4 1.4h-9c-.8 0-1.4-.6-1.4-1.4z" fill="#14c21a" />
    </svg>
  );
}

function VSCodeGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <path d="M12.5 2.4 6.8 6.7 3.9 4.5 2.4 5.7 5.2 8l-2.8 2.3 1.5 1.2 2.9-2.2 5.7 4.3 1.1-.5V2.9z" fill="#007acc" />
      <path d="M12.3 5.3 8.4 8l3.9 2.7z" fill="#35a9ff" opacity="0.9" />
    </svg>
  );
}

function FileGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <path d="M4 2.5h5.2L12 5.3v8.2H4z" fill="#f5f5f4" stroke="#78716c" strokeWidth="1" />
      <path d="M9.2 2.5v3h2.8" fill="none" stroke="#78716c" strokeWidth="1" />
      <path d="M5.8 8h4.4M5.8 10.1h3.5" fill="none" stroke="#57534e" strokeWidth="0.8" strokeLinecap="square" />
    </svg>
  );
}

function ScreenshotGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <rect x="2" y="3" width="12" height="10" fill="#fff7ed" stroke="#9a3412" strokeWidth="0.9" />
      <path d="M2.4 5.2h11.2" stroke="#9a3412" strokeWidth="0.9" />
      <rect x="3.8" y="6.7" width="3.1" height="2.3" fill="#fdba74" />
      <rect x="7.7" y="6.7" width="4.5" height="0.8" fill="#fed7aa" />
      <rect x="7.7" y="8.4" width="3.5" height="0.8" fill="#fed7aa" />
      <path d="M4 11.5h7.8" stroke="#ea580c" strokeWidth="0.9" strokeLinecap="square" />
      <circle cx="4" cy="4.1" r="0.35" fill="#9a3412" />
      <circle cx="5.1" cy="4.1" r="0.35" fill="#9a3412" />
    </svg>
  );
}

function OperatorGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <span
      {...glyphA11y(title, decorative)}
      title={title}
      className={cn(className, "inline-block bg-current")}
      style={{
        WebkitMaskImage: `url(${operatorClimberMarkSrc})`,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskImage: `url(${operatorClimberMarkSrc})`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
      }}
    />
  );
}

function UrgentOperatorGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <path d="M4.2 4.2c.7-1.5 2-2.2 3.8-2.2 2.3 0 4.1 1.5 4.1 3.9v3.9c0 2-1.6 3.5-3.9 3.5S4.1 11.8 4.1 9.8z" fill="#f8fafc" stroke="#111827" strokeWidth="0.75" />
      <path d="M4.3 4.1c.8-1.4 2.1-2.1 3.8-2.1 1.1 0 2.1.3 2.8.9" fill="none" stroke="#9a5b28" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M5.1 5.7h2.2M8.8 5.7h2.2" stroke="#111827" strokeWidth="0.75" strokeLinecap="round" />
      <circle cx="6.2" cy="6.6" r="0.35" fill="#111827" />
      <circle cx="9.8" cy="6.6" r="0.35" fill="#111827" />
      <rect x="6.3" y="9.2" width="3.6" height="1.3" rx="0.2" fill="#f8fafc" stroke="#111827" strokeWidth="0.65" />
      <path d="M7.1 9.2v1.3M8.1 9.2v1.3M9.1 9.2v1.3" stroke="#111827" strokeWidth="0.35" />
      <path d="M3.2 6.4c-1.1 1-1 2.4.1 3.1" fill="none" stroke="#7dd3fc" strokeWidth="0.8" strokeLinecap="round" />
      <path d="M11.8 4.2c.9.2 1.5.8 1.7 1.6" fill="none" stroke="#111827" strokeWidth="0.55" strokeLinecap="round" />
      <path d="M11.9 7.6c.9.8 1.1 1.7.5 2.6" fill="none" stroke="#38bdf8" strokeWidth="0.75" strokeLinecap="round" />
    </svg>
  );
}

function CalmOperatorGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <path d="M4.2 7.2c0-2.8 1.5-4.5 3.9-4.5s3.9 1.7 3.9 4.5v2.2c0 2.5-1.5 4-3.9 4s-3.9-1.5-3.9-4z" fill="#f8fafc" stroke="#111827" strokeWidth="0.75" />
      <path d="M5.2 5.4c.7-.6 1.7-.9 2.9-.9s2.1.3 2.8.9" fill="none" stroke="#111827" strokeWidth="0.6" strokeLinecap="round" />
      <path d="M6.2 7.2h.1M9.7 7.2h.1" stroke="#111827" strokeWidth="0.9" strokeLinecap="round" />
      <path d="M7.2 10c.7.5 1.7.5 2.4-.1" fill="none" stroke="#111827" strokeWidth="0.65" strokeLinecap="round" />
      <path d="M3.4 8.2c-.8.3-1.2.9-1.1 1.8M12.6 8.2c.8.3 1.2.9 1.1 1.8" fill="none" stroke="#111827" strokeWidth="0.55" strokeLinecap="round" />
    </svg>
  );
}

function UnknownGlyph({ className, title, decorative }: { className?: string; title: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" {...glyphA11y(title, decorative)} className={className}>
      <rect x="2" y="2" width="12" height="12" fill="#e7e5e4" stroke="#78716c" strokeWidth="1" />
      <path d="M6.2 6.2c.2-1 1-1.7 2-1.7 1.2 0 2 .7 2 1.8 0 .7-.3 1.1-.9 1.5-.6.4-.8.7-.8 1.4" fill="none" stroke="#57534e" strokeWidth="1.1" />
      <rect x="7.6" y="11" width="1" height="1" fill="#57534e" />
    </svg>
  );
}

export function RuntimeMark({ runtime, size = "sm", className, title, decorative }: RuntimeMarkProps) {
  const id = normalizeRuntimeBrandId(runtime);
  const label = title ?? runtimeBrand(runtime).label;
  const cls = cn(sizeClass[size], "shrink-0", className);
  if (id === "claude-code") return <ClaudeGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "codex") return <CodexGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "terminal") return <TerminalGlyph className={cls} title={label} decorative={decorative} />;
  return <UnknownGlyph className={cls} title={label} decorative={decorative} />;
}

export function RuntimeBadge({
  runtime,
  model,
  size = "sm",
  className,
  compact = false,
  variant = "badge",
}: {
  runtime: string | null | undefined;
  model?: string | null;
  size?: RuntimeMarkProps["size"];
  className?: string;
  compact?: boolean;
  variant?: "badge" | "inline";
}) {
  const id = normalizeRuntimeBrandId(runtime);
  const brand = runtimeBrand(runtime);
  const isInline = variant === "inline";
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center font-mono uppercase tracking-[0.10em]",
        isInline ? inlineSizeClass[size ?? "sm"] : badgeSizeClass[size ?? "sm"],
        isInline ? inlineToneClass[id] : cn("border", toneClass[id]),
        className,
      )}
      title={model ? `${brand.label} / ${model}` : brand.label}
    >
      <RuntimeMark runtime={runtime} size={size} />
      <span className="truncate">{compact ? brand.shortLabel : brand.label}</span>
      {model && !compact ? <span className="truncate text-current/60">{model}</span> : null}
    </span>
  );
}

export function ToolMark({
  tool,
  size = "sm",
  className,
  title,
  decorative,
}: {
  tool: string | null | undefined;
  size?: RuntimeMarkProps["size"];
  className?: string;
  title?: string;
  decorative?: boolean;
}) {
  const id = normalizeToolBrandId(tool);
  const label = title ?? toolBrand(tool).label;
  const cls = cn(sizeClass[size], "shrink-0", className);
  if (id === "cmux") return <CmuxGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "tmux") return <TmuxGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "vscode") return <VSCodeGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "terminal") return <TerminalGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "file") return <FileGlyph className={cls} title={label} decorative={decorative} />;
  if (id === "screenshot") return <ScreenshotGlyph className={cls} title={label} decorative={decorative} />;
  return <UnknownGlyph className={cls} title={label} decorative={decorative} />;
}

export function ToolBadge({
  tool,
  size = "sm",
  className,
  compact = false,
}: {
  tool: string | null | undefined;
  size?: RuntimeMarkProps["size"];
  className?: string;
  compact?: boolean;
}) {
  const id = normalizeToolBrandId(tool);
  const brand = toolBrand(tool);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center border font-mono uppercase tracking-[0.10em]",
        badgeSizeClass[size ?? "sm"],
        toolToneClass[id],
        className,
      )}
      title={brand.actionLabel}
    >
      <ToolMark tool={tool} size={size} />
      <span className="truncate">{compact ? brand.shortLabel : brand.label}</span>
    </span>
  );
}

export function isHumanActor(actor: string | null | undefined): boolean {
  const normalized = actor?.toLowerCase().trim() ?? "";
  return (
    normalized === "human" ||
    normalized.includes("human@") ||
    normalized.includes("human-") ||
    normalized.includes("operator") ||
    normalized.includes("host")
  );
}

export function ActorMark({
  actor,
  size = "sm",
  className,
  title,
  decorative,
}: {
  actor: string | null | undefined;
  size?: RuntimeMarkProps["size"];
  className?: string;
  title?: string;
  decorative?: boolean;
}) {
  const label = title ?? (actor ? actor : "Operator");
  const cls = cn(sizeClass[size], "shrink-0", className);
  if (isHumanActor(actor)) return <OperatorGlyph className={cls} title={label} decorative={decorative} />;
  if (normalizeRuntimeBrandId(actor) !== "unknown") {
    return <RuntimeMark runtime={actor} size={size} className={className} title={title} decorative={decorative} />;
  }
  return <TerminalGlyph className={cls} title={label} decorative={decorative} />;
}

export function OperatorMoodMark({
  mood,
  size = "sm",
  className,
  title,
}: {
  mood: OperatorMood;
  size?: RuntimeMarkProps["size"];
  className?: string;
  title?: string;
}) {
  const cls = cn(sizeClass[size], "shrink-0", className);
  if (mood === "urgent") return <UrgentOperatorGlyph className={cls} title={title ?? "Urgent operator"} />;
  if (mood === "calm") return <CalmOperatorGlyph className={cls} title={title ?? "Calm operator"} />;
  return <OperatorGlyph className={cls} title={title ?? "Cool operator"} />;
}
