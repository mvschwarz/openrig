import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CirclePlus,
  Clock,
  FileImage,
  GitBranch,
  History,
  MessageSquareText,
  PackageCheck,
  Route,
  Send,
  UserRound,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { VellumCard } from "../ui/vellum-card.js";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

interface Token {
  label: string;
  tone: Tone;
  icon?: LucideIcon;
}

const toneClass: Record<Tone, string> = {
  neutral: "border-stone-300 bg-white/65 text-stone-700",
  info: "border-sky-300 bg-sky-50/70 text-sky-800",
  success: "border-emerald-300 bg-emerald-50/70 text-emerald-800",
  warning: "border-amber-300 bg-amber-50/80 text-amber-800",
  danger: "border-rose-300 bg-rose-50/75 text-rose-800",
};

const eventTokens: Token[] = [
  { label: "Queue created", tone: "info", icon: CirclePlus },
  { label: "Handoff", tone: "neutral", icon: Send },
  { label: "Claimed", tone: "warning", icon: Clock },
  { label: "Completed", tone: "success", icon: CheckCircle2 },
  { label: "Human action", tone: "danger", icon: CircleAlert },
  { label: "Shipped", tone: "success", icon: PackageCheck },
];

const tagTokens: Token[] = [
  { label: "idea-ledger", tone: "neutral" },
  { label: "cycle-4", tone: "info" },
  { label: "proof", tone: "success" },
  { label: "urgent", tone: "danger" },
  { label: "human-review", tone: "warning" },
];

function Pill({ token, compact = false }: { token: Token; compact?: boolean }) {
  const Icon = token.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border font-mono uppercase tracking-[0.10em]",
        compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-1 text-[9px]",
        toneClass[token.tone],
      )}
    >
      {Icon ? <Icon className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} strokeWidth={1.6} /> : null}
      {token.label}
    </span>
  );
}

function ActorChip({
  kind,
  label,
  muted,
}: {
  kind: "human" | "agent";
  label: string;
  muted?: boolean;
}) {
  const Icon = kind === "human" ? UserRound : Bot;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px]",
        muted ? "border-stone-200 bg-white/45 text-stone-600" : "border-stone-300 bg-white/45 text-stone-800",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function DateChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 border border-stone-200 bg-white/55 px-1.5 py-0.5 font-mono text-[9px] text-stone-600">
      <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
      {label}
    </span>
  );
}

function FlowStrip() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ActorChip kind="agent" label="orch.lead@openrig-velocity" />
      <ArrowRight className="h-3.5 w-3.5 text-stone-400" strokeWidth={1.4} />
      <ActorChip kind="agent" label="driver@openrig-velocity" />
      <ArrowRight className="h-3.5 w-3.5 text-stone-400" strokeWidth={1.4} />
      <ActorChip kind="human" label="human@host" />
    </div>
  );
}

function ProofStrip() {
  return (
    <div className="grid grid-cols-3 gap-2">
      {["for-you-human-and-shipped.png", "project-overview-missions.png", "project-triage-slice.png"].map((name) => (
        <div key={name} className="border border-stone-200 bg-stone-100/80">
          <div className="flex aspect-[4/3] items-center justify-center bg-white/65 text-stone-400">
            <FileImage className="h-7 w-7" strokeWidth={1.2} />
          </div>
          <div className="truncate border-t border-stone-200 px-1 py-0.5 font-mono text-[8px] text-stone-600">
            {name}
          </div>
        </div>
      ))}
    </div>
  );
}

function CandidateCard({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <VellumCard
      as="section"
      className="bg-white/65 backdrop-blur-sm"
      header={<span className="uppercase tracking-[0.16em]">{label}</span>}
    >
      <div className="space-y-4 p-4">
        <p className="font-mono text-[10px] leading-relaxed text-stone-700">{description}</p>
        {children}
      </div>
    </VellumCard>
  );
}

function FeedTreatment({ dense = false }: { dense?: boolean }) {
  return (
    <article className={cn("border border-outline-variant bg-white/60 backdrop-blur-sm hard-shadow", dense ? "p-3" : "p-4")}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Pill token={{ label: "Action required", tone: "danger", icon: CircleAlert }} compact={dense} />
          <h3 className="font-mono text-sm text-stone-950">Review demo-seed triage proof packet</h3>
        </div>
        <DateChip label="Today 4:18 PM" />
      </div>
      <p className="mt-3 whitespace-pre-line font-mono text-[11px] leading-relaxed text-stone-700">
        Review the proof packet screenshots, confirm the shipped slice is ready, then approve or route back with notes.
      </p>
      <div className="mt-3">
        <FlowStrip />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {tagTokens.slice(0, 4).map((token) => <Pill key={token.label} token={token} compact />)}
      </div>
    </article>
  );
}

function StoryTreatment() {
  return (
    <article className="relative border border-outline-variant bg-white/60 p-4 hard-shadow backdrop-blur-sm">
      <div className="absolute left-5 top-12 bottom-5 w-px bg-stone-300" />
      <div className="relative space-y-5 pl-8">
        {[
          { token: eventTokens[5]!, title: "Slice shipped with proof packet", body: "The triage slice closed with screenshots, queue context, and verification notes attached." },
          { token: eventTokens[3]!, title: "Implementation completed", body: "Driver finished the UI pass and handed verification to guard and QA." },
          { token: eventTokens[1]!, title: "Work routed for review", body: "The queue item moved from driver to guard with targeted checks." },
        ].map((step) => {
          const Icon = step.token.icon ?? History;
          return (
            <div key={step.title} className="relative">
              <span className="absolute -left-[38px] top-0 flex h-5 w-5 items-center justify-center border border-stone-300 bg-white text-stone-700">
                <Icon className="h-3 w-3" strokeWidth={1.5} />
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Pill token={step.token} compact />
                <DateChip label="12 min ago" />
              </div>
              <h4 className="mt-2 font-mono text-[12px] text-stone-950">{step.title}</h4>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-stone-700">{step.body}</p>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function QueueTreatment() {
  return (
    <div className="divide-y divide-outline-variant border border-outline-variant bg-white/55 backdrop-blur-sm">
      {[
        { token: eventTokens[4]!, title: "Approval needed", body: "Review proof screenshots and approve release-readiness.", actor: "human@host" },
        { token: eventTokens[2]!, title: "Claimed by QA", body: "VM verification is in progress with current worktree source.", actor: "velocity-qa" },
        { token: eventTokens[1]!, title: "Route to guard", body: "Run narrow advisory on UI-only diff and source scans.", actor: "redo3-guard-3" },
      ].map((item) => (
        <div key={item.title} className="grid gap-3 p-3 sm:grid-cols-[auto_1fr_auto]">
          <Pill token={item.token} compact />
          <div className="min-w-0">
            <div className="font-mono text-[12px] text-stone-950">{item.title}</div>
            <div className="mt-1 font-mono text-[10px] leading-relaxed text-stone-700">{item.body}</div>
          </div>
          <ActorChip kind={item.actor.includes("human") ? "human" : "agent"} label={item.actor} muted />
        </div>
      ))}
    </div>
  );
}

export function ProjectGraphicsPreview() {
  return (
    <div className="paper-grid min-h-full p-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="border border-outline-variant bg-white/60 p-4 font-mono backdrop-blur-sm hard-shadow">
          <div className="text-[10px] uppercase tracking-[0.18em] text-stone-600">
            Project graphics package preview
          </div>
          <h1 className="mt-2 text-xl uppercase tracking-[0.14em] text-stone-950">
            Queue, story, and proof card language
          </h1>
          <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-stone-700">
            Hidden preview route for choosing metadata badges, action chips, flow arrows, and proof-card density before
            applying the system to For You, Story, Queue, and scope rollups.
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <CandidateCard
            label="A / Compact Ledger"
            description="Small pills and restrained icons. Best when density matters and queue cards need to scan like a work ledger."
          >
            <FeedTreatment dense />
            <QueueTreatment />
          </CandidateCard>

          <CandidateCard
            label="B / Narrative Rail"
            description="Story-first layout with event icons on a vertical rail. Best for showing how work moved from idea to proof."
          >
            <StoryTreatment />
            <ProofStrip />
          </CandidateCard>

          <CandidateCard
            label="C / Action Board"
            description="Bolder cards with explicit status, actors, and proof thumbnails. Best for For You and approval surfaces."
          >
            <FeedTreatment />
            <div className="flex flex-wrap gap-1.5">
              {eventTokens.map((token) => <Pill key={token.label} token={token} />)}
            </div>
          </CandidateCard>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <VellumCard as="section" className="bg-white/65 backdrop-blur-sm" header="EVENT BADGE VOCABULARY">
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {eventTokens.map((token) => (
                <div key={token.label} className="border border-outline-variant bg-white/55 p-3">
                  <Pill token={token} />
                  <div className="mt-2 font-mono text-[10px] leading-relaxed text-stone-700">
                    {token.label === "Queue created" ? "A work item entered the system." : null}
                    {token.label === "Handoff" ? "Ownership moved from one actor to another." : null}
                    {token.label === "Claimed" ? "An actor is actively working the item." : null}
                    {token.label === "Completed" ? "The assigned work item closed." : null}
                    {token.label === "Human action" ? "A person needs to approve, deny, or route." : null}
                    {token.label === "Shipped" ? "The slice closed with evidence attached." : null}
                  </div>
                </div>
              ))}
            </div>
          </VellumCard>

          <VellumCard as="section" className="bg-white/65 backdrop-blur-sm" header="SUPPORTING CHIPS">
            <div className="space-y-4 p-4">
              <div>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-stone-600">Tags</div>
                <div className="flex flex-wrap gap-1.5">
                  {tagTokens.map((token) => <Pill key={token.label} token={token} />)}
                </div>
              </div>
              <div>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-stone-600">Actors</div>
                <div className="flex flex-wrap gap-1.5">
                  <ActorChip kind="human" label="human@host" />
                  <ActorChip kind="agent" label="driver@openrig-velocity" />
                  <ActorChip kind="agent" label="guard@openrig-velocity" muted />
                </div>
              </div>
              <div>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-stone-600">Scope</div>
                <div className="flex flex-wrap gap-1.5">
                  <Pill token={{ label: "Workspace", tone: "neutral", icon: Route }} />
                  <Pill token={{ label: "Mission", tone: "info", icon: GitBranch }} />
                  <Pill token={{ label: "Slice", tone: "success", icon: MessageSquareText }} />
                </div>
              </div>
            </div>
          </VellumCard>
        </section>
      </div>
    </div>
  );
}
