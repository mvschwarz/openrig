// OPR.0.3.3.20 + OPR.0.4.0.24 — For-You card-level drill into the source/
// author seat's LIVE terminal (manage-by-exception, video B6).
//
// Session-NAME keyed only: the drill reuses TerminalPreviewPopover which
// mounts FocusedTerminal (a live xterm/WebSocket terminal). It performs
// NO rigId/logicalId/agentActivity topology resolution — the card's already-
// resolved source session string is the whole address.
//
// Honesty: when the live terminal cannot connect, FocusedTerminal surfaces
// an honest unavailable/disconnected state. When no session resolves for
// the card, the drill renders DISABLED with an honest title.

import { TerminalPreviewPopover } from "../topology/TerminalPreviewPopover.js";

const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";

interface FeedCardTerminalDrillProps {
  cardId: string;
  sessionName: string | undefined;
}

export function FeedCardTerminalDrill({ cardId, sessionName }: FeedCardTerminalDrillProps) {
  if (!sessionName) {
    return (
      <button
        type="button"
        disabled
        data-testid={`feed-card-drill-${cardId}`}
        title="No session resolved for this card — live terminal unavailable"
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stone-400 cursor-not-allowed"
      >
        live terminal
      </button>
    );
  }

  const previewKey = `${cardId}:${sessionName}`;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(TERMINAL_PREVIEW_EVENT, { detail: { key: previewKey } }));
  };

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        data-testid={`feed-card-drill-${cardId}`}
        onClick={openPreview}
        title={`Open live terminal for ${sessionName}`}
        className="font-mono text-[10px] uppercase tracking-wide text-stone-700 hover:text-stone-900 underline"
      >
        live terminal
      </button>
      <TerminalPreviewPopover
        rigId={cardId}
        logicalId={sessionName}
        sessionName={sessionName}
        renderTrigger={false}
        testIdPrefix={`feed-card-drill-${cardId}`}
      />
    </span>
  );
}
