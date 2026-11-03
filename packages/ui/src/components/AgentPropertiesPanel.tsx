import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useNodeDetail } from "../hooks/useNodeDetail.js";
import { useHostSelection } from "../hooks/useHosts.js";
import { StatusBadge } from "./ui/status-badge.js";
import { Skeleton } from "./ui/skeleton.js";
import { EmptyState } from "./ui/empty-state.js";
import { copyText } from "../lib/copy-text.js";

const ROW_CLASS = "flex items-start gap-2 py-1";
const LABEL_CLASS = "w-28 shrink-0 text-xs text-on-surface-variant";
const VALUE_CLASS = "min-w-0 flex-1 text-sm text-on-surface";

function CopyButton({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) return;
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      className="ml-2 shrink-0 font-mono text-[11px] text-on-surface-variant underline decoration-dotted hover:text-on-surface"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function AgentPropertiesPanel({
  rigId,
  logicalId,
}: {
  rigId: string;
  logicalId: string;
}) {
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const { known: hostKnown, isLocal: hostIsLocal } = useHostSelection();

  if (isLoading) {
    return (
      <section data-testid="agent-properties" aria-label="Properties" className="w-80 shrink-0 border-l bg-surface-lowest p-4">
        <h2 className="mb-3 text-sm font-semibold text-on-surface">Properties</h2>
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section data-testid="agent-properties" aria-label="Properties" className="w-80 shrink-0 border-l bg-surface-lowest p-4">
        <h2 className="mb-3 text-sm font-semibold text-on-surface">Properties</h2>
        <EmptyState
          title="Couldn't load this agent"
          label="Couldn't load this agent"
          description={(error as Error | null)?.message ?? "Unknown error"}
        />
      </section>
    );
  }

  const status = data.agentActivity?.state ?? data.sessionStatus ?? "unknown";
  const contextPct = data.contextUsage?.usedPercentage ?? null;
  const qitemCount = data.currentQitems?.length ?? 0;

  return (
    <section data-testid="agent-properties" aria-label="Properties" className="w-80 shrink-0 border-l bg-surface-lowest p-4">
      <h2 className="mb-3 text-sm font-semibold text-on-surface">Properties</h2>
      <dl>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Status</dt>
          <dd className={VALUE_CLASS}>
            <StatusBadge status={status} />
          </dd>
        </div>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Runtime</dt>
          <dd className={`${VALUE_CLASS} font-mono`}>{data.runtime ?? "—"}</dd>
        </div>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Rig</dt>
          <dd className={VALUE_CLASS}>
            <Link to="/topology/rig/$rigId" params={{ rigId }} className="text-brand hover:underline">
              {data.rigName}
            </Link>
          </dd>
        </div>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Pod</dt>
          <dd className={VALUE_CLASS}>{data.podId ?? "—"}</dd>
        </div>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Session</dt>
          <dd className={`${VALUE_CLASS} font-mono`}>
            <span className="break-all">{data.canonicalSessionName ?? "—"}</span>
            {data.canonicalSessionName && (
              <CopyButton text={data.canonicalSessionName} testId="agent-properties-copy-session" />
            )}
          </dd>
        </div>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Context used</dt>
          <dd className={VALUE_CLASS}>
            {contextPct != null ? (
              <span>
                <span>{contextPct}%</span>
                <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-surface-mid">
                  <span
                    className="block h-full rounded-full bg-brand"
                    style={{ width: `${Math.min(100, Math.max(0, contextPct))}%` }}
                  />
                </span>
              </span>
            ) : (
              "--"
            )}
          </dd>
        </div>
        <div className={ROW_CLASS}>
          <dt className={LABEL_CLASS}>Current work</dt>
          <dd className={VALUE_CLASS}>
            {qitemCount > 0 ? `${qitemCount} in progress` : "None"}
          </dd>
        </div>
        {/* tmux attach targets LOCAL sessions only — hide for remote hosts. */}
        {data.tmuxAttachCommand && (!hostKnown || hostIsLocal) && (
          <div className={ROW_CLASS}>
            <dt className={LABEL_CLASS}>Attach</dt>
            <dd className={`${VALUE_CLASS} font-mono`}>
              <span className="break-all">{data.tmuxAttachCommand}</span>
              <CopyButton text={data.tmuxAttachCommand} testId="agent-properties-copy-attach" />
            </dd>
          </div>
        )}
        {data.latestError && (
          <div className={ROW_CLASS}>
            <dt className={LABEL_CLASS}>Latest error</dt>
            <dd className={`${VALUE_CLASS} text-destructive`}>{data.latestError}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
