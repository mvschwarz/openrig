import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CirclePlus,
  Clock,
  GitBranch,
  History,
  MessageSquareText,
  PackageCheck,
  Route,
  Send,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { proofAssetUrl } from "../../hooks/useSlices.js";
import { ActorMark, ToolMark } from "../graphics/RuntimeMark.js";

export type ProjectMetaTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ProjectToken {
  label: string;
  tone: ProjectMetaTone;
  icon?: LucideIcon;
}

const toneClass: Record<ProjectMetaTone, string> = {
  neutral: "border-stone-300 bg-white/55 text-stone-700",
  info: "border-sky-300 bg-sky-50/75 text-sky-800",
  success: "border-emerald-300 bg-emerald-50/75 text-emerald-800",
  warning: "border-amber-300 bg-amber-50/80 text-amber-800",
  danger: "border-rose-300 bg-rose-50/80 text-rose-800",
};

export function eventToken(kind: string): ProjectToken {
  const normalized = kind.toLowerCase();
  if (normalized.includes("action") || normalized.includes("human") || normalized.includes("overdue")) {
    return { label: "Human action", tone: "danger", icon: CircleAlert };
  }
  if (normalized.includes("approval")) {
    return { label: "Approval", tone: "warning", icon: CircleAlert };
  }
  if (normalized.includes("shipped")) {
    return { label: "Shipped", tone: "success", icon: PackageCheck };
  }
  if (normalized.includes("transition.done") || normalized.includes("transition.complete")) {
    return { label: "Marked done", tone: "success", icon: CheckCircle2 };
  }
  if (normalized.includes("transition.in-progress") || normalized.includes("transition.claim")) {
    return { label: "In progress", tone: "info", icon: Clock };
  }
  if (normalized.includes("transition.pending")) {
    return { label: "Pending", tone: "warning", icon: Clock };
  }
  if (normalized.includes("transition")) {
    return { label: "State change", tone: "neutral", icon: History };
  }
  if (normalized.includes("ship") || normalized.includes("done") || normalized.includes("complete")) {
    return { label: "Completed", tone: "success", icon: CheckCircle2 };
  }
  if (normalized.includes("claim")) {
    return { label: "Claimed", tone: "warning", icon: Clock };
  }
  if (normalized.includes("handoff") || normalized.includes("routed")) {
    return { label: "Handoff", tone: "neutral", icon: Send };
  }
  if (normalized.includes("created")) {
    return { label: "New queue item", tone: "info", icon: CirclePlus };
  }
  if (normalized.includes("progress")) {
    return { label: "Progress", tone: "info", icon: History };
  }
  return { label: humanizeCodeLabel(kind), tone: "neutral", icon: MessageSquareText };
}

export function scopeToken(scope: "workspace" | "mission" | "slice"): ProjectToken {
  if (scope === "workspace") return { label: "Workspace", tone: "neutral", icon: Route };
  if (scope === "mission") return { label: "Mission", tone: "info", icon: GitBranch };
  return { label: "Slice", tone: "success", icon: MessageSquareText };
}

export function stateTone(state: string | undefined): ProjectMetaTone {
  const normalized = state?.toLowerCase() ?? "";
  if (normalized.includes("done") || normalized.includes("complete") || normalized.includes("closed")) return "success";
  if (normalized.includes("fail") || normalized.includes("blocked") || normalized.includes("overdue")) return "danger";
  if (normalized.includes("pending") || normalized.includes("human") || normalized.includes("approval")) return "warning";
  if (normalized.includes("progress") || normalized.includes("claim")) return "info";
  return "neutral";
}

export function humanizeCodeLabel(value: string): string {
  return value
    .replace(/[_./-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function compactSessionLabel(session: string | undefined | null): string {
  if (!session) return "unknown";
  if (session === "human@host") return "human@host";
  const [name, rig] = session.split("@");
  if (!rig) return session;
  return `${name}@${rig}`;
}

export function formatFriendlyDate(value: string | undefined | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `Today ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function ProjectPill({
  token,
  compact = false,
  testId,
  className,
}: {
  token: ProjectToken;
  compact?: boolean;
  testId?: string;
  className?: string;
}) {
  const Icon = token.icon;
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 border font-mono uppercase tracking-[0.10em]",
        compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-1 text-[9px]",
        toneClass[token.tone],
        className,
      )}
    >
      {Icon ? <Icon className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} strokeWidth={1.6} /> : null}
      {token.label}
    </span>
  );
}

export function EventBadge({ kind, compact, testId }: { kind: string; compact?: boolean; testId?: string }) {
  return <ProjectPill token={eventToken(kind)} compact={compact} testId={testId} />;
}

export function TagPill({ tag, compact = true }: { tag: string; compact?: boolean }) {
  const tone: ProjectMetaTone =
    /urgent|blocked|human/i.test(tag) ? "danger" :
    /proof|pass|done|ship/i.test(tag) ? "success" :
    /cycle|phase|qa|review/i.test(tag) ? "info" :
    "neutral";
  return <ProjectPill token={{ label: tag, tone }} compact={compact} />;
}

export function ActorChip({
  session,
  muted,
}: {
  session: string | undefined | null;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px]",
        muted ? "border-stone-200 bg-white/35 text-stone-500" : "border-stone-300 bg-white/55 text-stone-800",
      )}
    >
      <ActorMark actor={session} size="xs" />
      <span className="truncate">{compactSessionLabel(session)}</span>
    </span>
  );
}

export function DateChip({ value }: { value: string | undefined | null }) {
  return (
    <time
      dateTime={value ?? undefined}
      className="inline-flex items-center gap-1 border border-stone-200 bg-white/45 px-1.5 py-0.5 font-mono text-[9px] text-stone-600"
    >
      <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
      {formatFriendlyDate(value)}
    </time>
  );
}

export function FlowChips({
  source,
  destination,
  muted,
}: {
  source?: string | null;
  destination?: string | null;
  muted?: boolean;
}) {
  if (!source && !destination) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ActorChip session={source ?? "unknown source"} muted={muted} />
      <ArrowRight className="h-3.5 w-3.5 text-stone-400" strokeWidth={1.4} />
      <ActorChip session={destination ?? "unresolved target"} muted={muted} />
    </div>
  );
}

export function ProofThumbnailGrid({
  sliceName,
  screenshots,
  onSelect,
  max = 4,
  testIdPrefix,
}: {
  sliceName: string;
  screenshots: string[];
  onSelect?: (relPath: string) => void;
  max?: number;
  testIdPrefix?: string;
}) {
  if (screenshots.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {screenshots.slice(0, max).map((rel) => {
        const image = (
          <img
            data-testid={testIdPrefix ? `${testIdPrefix}-${rel}` : undefined}
            src={proofAssetUrl(sliceName, rel)}
            alt={rel}
            className="h-24 w-full border border-stone-200 bg-stone-100 object-cover"
            loading="lazy"
          />
        );
        if (!onSelect) return <div key={rel}>{image}</div>;
        return (
          <button
            key={rel}
            type="button"
            onClick={() => onSelect(rel)}
            className="block w-full text-left focus:outline-none focus:ring-2 focus:ring-stone-900/20"
          >
            {image}
          </button>
        );
      })}
    </div>
  );
}

export function ProofPacketHeader({
  title,
  badge,
}: {
  title: string;
  badge: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-stone-600">
      <span className="truncate inline-flex items-center gap-1">
        <ToolMark tool="screenshot" size="xs" />
        {title}
      </span>
      <ProjectPill token={{ label: badge, tone: stateTone(badge) }} compact />
    </div>
  );
}
