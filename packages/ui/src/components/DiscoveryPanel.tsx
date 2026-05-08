import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";
import { displayAgentName } from "../lib/display-name.js";
import { shortId } from "../lib/display-id.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";
import {
  useAdoptSession,
  useDiscoveredSessions,
  useDiscoveryScan,
  type DiscoveredSession,
  type DiscoveryAdoptTarget,
} from "../hooks/useDiscovery.js";

export type DiscoveryPlacementTarget =
  | {
      kind: "node";
      rigId: string;
      logicalId: string;
      eligible: boolean;
      reason?: string | null;
    }
  | {
      kind: "pod";
      rigId: string;
      podId: string;
      podNamespace: string | null;
      podLabel: string | null;
      eligible: boolean;
      reason?: string | null;
    }
  | null;

interface DiscoveryPanelProps {
  onClose: () => void;
  selectedDiscoveredId: string | null;
  onSelectDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  onClearPlacement: () => void;
}

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function attachCommand(session: DiscoveredSession): string {
  const target = session.tmuxWindow ? `${session.tmuxSession}:${session.tmuxWindow}` : session.tmuxSession;
  return `tmux attach -t ${shellQuote(target)}`;
}

function suggestMemberName(sessionName: string): string {
  const tail = sessionName.split(/[@:]/)[0] ?? sessionName;
  const segments = tail.split(/[-_.]/).filter(Boolean);
  const candidate = (segments.at(-1) ?? tail).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return candidate || "member";
}

function targetNodeLabel(logicalId: string): string {
  if (logicalId.includes(".")) {
    return displayAgentName(logicalId);
  }
  return logicalId.length > 12 ? shortId(logicalId) : logicalId;
}

function targetPodLabel(target: Extract<DiscoveryPlacementTarget, { kind: "pod" }>): string {
  return target.podLabel ?? target.podNamespace ?? shortId(target.podId);
}

function CopyActionButton({
  label,
  activeLabel,
  onClick,
  testId,
  tool,
}: {
  label: string;
  activeLabel: string;
  onClick: () => boolean | Promise<boolean>;
  testId?: string;
  tool?: string;
}) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async () => {
    const ok = await onClick();
    if (!ok) return;
    setActive(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setActive(false);
      timerRef.current = null;
    }, 900);
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={() => { void handleClick(); }}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[7px] uppercase transition-colors",
        active
          ? "bg-stone-900 text-white border-stone-900"
          : "bg-white text-stone-900 border-stone-300 hover:bg-stone-100",
      )}
    >
      {tool ? <ToolMark tool={tool} size="xs" /> : null}
      <span>{active ? activeLabel : label}</span>
    </button>
  );
}

export function DiscoveryPanel({
  onClose,
  selectedDiscoveredId,
  onSelectDiscoveredId,
  placementTarget,
  onClearPlacement,
}: DiscoveryPanelProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentRigId = parseCurrentRigId(pathname);
  const { data: sessions = [] } = useDiscoveredSessions({
    status: "active",
    runtimeHint: ["claude-code", "codex"],
    minConfidence: "medium",
  });
  const scanMutation = useDiscoveryScan();
  const adoptMutation = useAdoptSession();
  const selectedSession = sessions.find((session) => session.id === selectedDiscoveredId) ?? null;
  const [memberName, setMemberName] = useState("");

  useEffect(() => {
    if (selectedSession && placementTarget?.kind === "pod") {
      setMemberName((current) => current || suggestMemberName(selectedSession.tmuxSession));
      return;
    }
    if (!selectedSession || !placementTarget || placementTarget.kind !== "pod") {
      setMemberName("");
    }
  }, [selectedSession, placementTarget]);

  const selectedCardStatus = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    if (!currentRigId) {
      return "Select a rig in the explorer to place the selected session.";
    }

    if (!placementTarget) {
      return `Selected ${selectedSession.tmuxSession}. Click an available node to bind it, or click a pod to add it there.`;
    }

    if (!placementTarget.eligible) {
      return placementTarget.reason ?? "That target cannot receive the selected session.";
    }

    if (placementTarget.kind === "node") {
      return `Bind ${selectedSession.tmuxSession} to ${targetNodeLabel(placementTarget.logicalId)}.`;
    }

    return `Add ${selectedSession.tmuxSession} to ${targetPodLabel(placementTarget)} pod.`;
  }, [currentRigId, placementTarget, selectedSession]);

  const handleConfirm = () => {
    if (!selectedSession || !currentRigId || !placementTarget || !placementTarget.eligible) return;

    let target: DiscoveryAdoptTarget;
    if (placementTarget.kind === "node") {
      target = { kind: "node", logicalId: placementTarget.logicalId };
    } else {
      if (!placementTarget.podNamespace) return;
      target = {
        kind: "pod",
        podId: placementTarget.podId,
        podNamespace: placementTarget.podNamespace,
        memberName: memberName.trim(),
      };
    }

    adoptMutation.mutate(
      { discoveredId: selectedSession.id, rigId: currentRigId, target },
      {
        onSuccess: () => {
          onSelectDiscoveredId(null);
          onClearPlacement();
        },
      },
    );
  };

  return (
    <aside
      data-testid="discovery-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-stone-300/25 bg-[rgba(250,249,245,0.035)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-300/35 shrink-0">
        <h2 className="min-w-0 font-mono text-xs font-bold text-stone-900 truncate">discovery</h2>
        <button
          data-testid="discovery-close"
          onClick={onClose}
          className="text-stone-400 hover:text-stone-900 text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="border-b border-stone-300/35 px-4 py-3 shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-stone-500">Inventory</div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="discovery-scan-now"
            disabled={scanMutation.isPending}
            onClick={() => scanMutation.mutate()}
          >
            {scanMutation.isPending ? "SCANNING..." : "SCAN NOW"}
          </Button>
        </div>
        <Link
          to="/discovery/inventory"
          data-testid="discovery-open-inventory"
          onClick={onClose}
          className="inline-flex items-center border border-stone-300 bg-white px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-[0.12em] text-stone-700 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          Legacy Inventory Page
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {sessions.length === 0 ? (
          <div data-testid="discovery-empty" className="font-mono text-[10px] text-stone-500">
            No running Claude or Codex sessions are currently visible.
          </div>
        ) : (
          sessions.map((session) => {
            const selected = session.id === selectedDiscoveredId;
            return (
              <div
                key={session.id}
                data-testid={`discovery-session-${session.id}`}
                className={cn(
                  "border border-stone-200 bg-white/60 px-3 py-3",
                  selected && "border-emerald-500 shadow-[0_10px_24px_rgba(34,197,94,0.16)]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <RuntimeBadge runtime={session.runtimeHint} size="xs" compact className="bg-white/45" />
                      <div className="font-mono text-[10px] text-stone-900 truncate" title={session.tmuxSession}>
                        {session.tmuxSession}
                      </div>
                    </div>
                    {session.cwd ? (
                      <div className="mt-1 font-mono text-[9px] text-stone-500 truncate" title={session.cwd}>
                        {session.cwd}
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant={selected ? "tactical" : "ghost"}
                    size="sm"
                    data-testid={`discovery-select-${session.id}`}
                    onClick={() => onSelectDiscoveredId(selected ? null : session.id)}
                  >
                    {selected ? "SELECTED" : "SELECT"}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <CopyActionButton
                    label="copy tmux"
                    activeLabel="copied"
                    testId={`discovery-copy-tmux-${session.id}`}
                    tool="tmux"
                    onClick={async () => copyText(attachCommand(session))}
                  />
                  {session.cwd ? (
                    <CopyActionButton
                      label="copy cwd"
                      activeLabel="copied"
                      testId={`discovery-copy-cwd-${session.id}`}
                      onClick={async () => copyText(session.cwd ?? "")}
                    />
                  ) : null}
                </div>
                {selected ? (
                  <div className="mt-3 space-y-2 border-t border-emerald-200/80 pt-3">
                    {selectedCardStatus ? (
                      <div
                        data-testid="discovery-selected-session-status"
                        className="border border-emerald-300/80 bg-white/70 px-2.5 py-2 font-mono text-[10px] leading-5 text-stone-900"
                      >
                        {selectedCardStatus}
                      </div>
                    ) : null}

                    {placementTarget && !placementTarget.eligible ? (
                      <div
                        data-testid="discovery-target-error"
                        className="border border-red-200 bg-red-50/80 px-2.5 py-2 font-mono text-[9px] text-red-700"
                      >
                        {placementTarget.reason ?? "That destination is not available."}
                      </div>
                    ) : null}

                    {placementTarget?.eligible ? (
                      <div className="space-y-2 border border-emerald-300/80 bg-white/70 px-3 py-2" data-testid="discovery-target-card">
                        <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-emerald-800">Target</div>
                        <div data-testid="discovery-target-summary" className="font-mono text-[10px] text-stone-900">
                          {placementTarget.kind === "node"
                            ? `${targetNodeLabel(placementTarget.logicalId)} selected`
                            : `${targetPodLabel(placementTarget)} pod selected`}
                        </div>
                        {placementTarget.kind === "pod" ? (
                          <div className="space-y-1">
                            <label className="font-mono text-[8px] uppercase tracking-[0.16em] text-emerald-800" htmlFor="discovery-member-name">
                              Member name
                            </label>
                            <input
                              id="discovery-member-name"
                              data-testid="discovery-member-name-input"
                              value={memberName}
                              onChange={(event) => setMemberName(event.target.value)}
                              className="w-full bg-transparent border-b border-emerald-300 py-1 font-mono text-[10px] text-stone-900 focus:outline-none focus:border-emerald-700"
                            />
                          </div>
                        ) : null}
                        {adoptMutation.isError ? (
                          <div data-testid="discovery-adopt-error" className="font-mono text-[9px] text-red-600">
                            {adoptMutation.error.message}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <Button
                            variant="tactical"
                            size="sm"
                            data-testid="discovery-confirm-adopt"
                            disabled={adoptMutation.isPending || (placementTarget.kind === "pod" && !memberName.trim())}
                            onClick={handleConfirm}
                          >
                            {adoptMutation.isPending ? "ADOPTING..." : "ADOPT"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="discovery-clear-target"
                            onClick={onClearPlacement}
                          >
                            CLEAR
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
