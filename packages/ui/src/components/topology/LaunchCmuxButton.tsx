// Slice 24 — LaunchCmuxButton.
//
// Rig-scope "Launch in CMUX" button. Click → POST /api/rigs/:rigId/cmux/launch
// via launchRigCmux. Renders inline status (loading / success / error)
// directly adjacent to the button rather than via a separate toast
// primitive — keeps the rig-scope tab-bar self-contained.
//
// Per README §Mobile + §Button placement: mounted in the rig-scope tab
// bar (Option C placement, persistent across all rig-scope view-mode
// tabs); hidden below the lg breakpoint via Tailwind responsive classes.

import { useEffect, useRef } from "react";
import { launchRigCmux } from "../../hooks/launchRigCmux.js";

interface LaunchCmuxButtonProps {
  rigId: string;
}

const SUCCESS_TOAST_TIMEOUT_MS = 6000;
const ERROR_TOAST_TIMEOUT_MS = 8000;

export function LaunchCmuxButton({ rigId }: LaunchCmuxButtonProps) {
  // Keep this launcher's transient state out of React rendering. The
  // topology table view can renderer-spin when this sibling button
  // schedules React state during click handling; the cmux launch is an
  // external side effect, so a tiny uncontrolled status island is safer.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLSpanElement | null>(null);
  const inFlightRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const setPendingUi = (pending: boolean) => {
    const button = buttonRef.current;
    if (!button) return;
    button.disabled = pending;
    button.setAttribute("aria-busy", pending ? "true" : "false");
    button.textContent = pending ? "Launching..." : "Launch in CMUX";
  };

  const clearStatus = () => {
    const status = statusRef.current;
    if (!status) return;
    status.hidden = true;
    status.textContent = "";
    status.removeAttribute("data-status-kind");
  };

  const showStatus = (kind: "success" | "error", message: string) => {
    const status = statusRef.current;
    if (!status) return;
    status.hidden = false;
    status.textContent = message;
    status.setAttribute("data-status-kind", kind);
    status.className =
      kind === "error"
        ? "font-mono text-[10px] text-rose-700 max-w-2xl leading-relaxed whitespace-normal break-words"
        : "font-mono text-[10px] text-emerald-700 max-w-2xl leading-relaxed whitespace-normal break-words";
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(
      clearStatus,
      kind === "success" ? SUCCESS_TOAST_TIMEOUT_MS : ERROR_TOAST_TIMEOUT_MS,
    );
  };

  const handleClick = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPendingUi(true);
    clearStatus();
    launchRigCmux({ rigId })
      .then((result) => {
        const workspaceCount = result.workspaces.length;
        const agentCount = result.workspaces.reduce((sum, w) => sum + w.agents.length, 0);
        const names = result.workspaces.map((w) => w.name).join(", ");
        showStatus(
          "success",
          workspaceCount === 1
            ? `Launched cmux workspace "${names}" with ${agentCount} agent${agentCount === 1 ? "" : "s"}.`
            : `Launched ${workspaceCount} cmux workspaces (${names}) with ${agentCount} agents total.`,
        );
      })
      .catch((err: Error) => {
        showStatus("error", err.message);
      })
      .finally(() => {
        inFlightRef.current = false;
        setPendingUi(false);
      });
  };

  return (
    <div
      data-testid="launch-cmux-wrapper"
      className="hidden lg:inline-flex items-center gap-3 ml-auto"
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="launch-cmux-button"
        onClick={handleClick}
        className="border border-stone-700 bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-100 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-stone-400"
      >
        Launch in CMUX
      </button>
      <span
        ref={statusRef}
        hidden
        data-testid="launch-cmux-status"
        role="status"
        aria-live="polite"
        className="font-mono text-[10px] text-emerald-700 max-w-2xl leading-relaxed whitespace-normal break-words"
      />
    </div>
  );
}
