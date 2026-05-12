// Slice 24 — LaunchCmuxButton.
//
// Rig-scope "Launch in CMUX" button. Click → POST /api/rigs/:rigId/cmux/launch
// via useRigCmuxLaunch. Renders inline status (loading / success / error)
// directly adjacent to the button rather than via a separate toast
// primitive — keeps the rig-scope tab-bar self-contained.
//
// Per README §Mobile + §Button placement: mounted in the rig-scope tab
// bar (Option C placement, persistent across all rig-scope view-mode
// tabs); hidden below the lg breakpoint via Tailwind responsive classes.

import { useEffect, useState } from "react";
import { useRigCmuxLaunch } from "../../hooks/useRigCmuxLaunch.js";

interface LaunchCmuxButtonProps {
  rigId: string;
}

type StatusKind = "idle" | "loading" | "success" | "error";

interface StatusState {
  kind: StatusKind;
  message?: string;
}

const SUCCESS_TOAST_TIMEOUT_MS = 6000;
const ERROR_TOAST_TIMEOUT_MS = 8000;

export function LaunchCmuxButton({ rigId }: LaunchCmuxButtonProps) {
  const mutation = useRigCmuxLaunch();
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  useEffect(() => {
    if (status.kind === "idle" || status.kind === "loading") return;
    const timeout = status.kind === "success" ? SUCCESS_TOAST_TIMEOUT_MS : ERROR_TOAST_TIMEOUT_MS;
    const t = window.setTimeout(() => setStatus({ kind: "idle" }), timeout);
    return () => window.clearTimeout(t);
  }, [status]);

  const handleClick = () => {
    if (mutation.isPending) return;
    setStatus({ kind: "loading" });
    mutation
      .mutateAsync({ rigId })
      .then((result) => {
        const workspaceCount = result.workspaces.length;
        const agentCount = result.workspaces.reduce((sum, w) => sum + w.agents.length, 0);
        const names = result.workspaces.map((w) => w.name).join(", ");
        setStatus({
          kind: "success",
          message:
            workspaceCount === 1
              ? `Launched cmux workspace "${names}" with ${agentCount} agent${agentCount === 1 ? "" : "s"}.`
              : `Launched ${workspaceCount} cmux workspaces (${names}) with ${agentCount} agents total.`,
        });
      })
      .catch((err: Error) => {
        setStatus({ kind: "error", message: err.message });
      });
  };

  const buttonLabel = mutation.isPending ? "Launching…" : "Launch in CMUX";

  return (
    <div
      data-testid="launch-cmux-wrapper"
      className="hidden lg:inline-flex items-center gap-3 ml-auto"
    >
      <button
        type="button"
        data-testid="launch-cmux-button"
        onClick={handleClick}
        disabled={mutation.isPending}
        className="border border-stone-700 bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-100 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-stone-400"
      >
        {buttonLabel}
      </button>
      {status.kind !== "idle" && status.message ? (
        <span
          data-testid="launch-cmux-status"
          data-status-kind={status.kind}
          role="status"
          aria-live="polite"
          className={
            // Slice 24.D repair (velocity-guard BLOCKING-CONCERN):
            // do NOT truncate the daemon's honest 3-part error
            // messages. Operator must see the action phrase
            // (e.g., "cmux ping", "rig up <name>") to recover.
            // Width-bound the wrapper instead and let text wrap
            // naturally onto multiple lines.
            status.kind === "error"
              ? "font-mono text-[10px] text-rose-700 max-w-2xl leading-relaxed whitespace-normal break-words"
              : "font-mono text-[10px] text-emerald-700 max-w-2xl leading-relaxed whitespace-normal break-words"
          }
        >
          {status.message}
        </span>
      ) : null}
    </div>
  );
}
