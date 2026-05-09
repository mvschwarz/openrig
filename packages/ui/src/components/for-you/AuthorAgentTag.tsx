// V1 attempt-3 Phase 4 — AuthorAgentTag with cmux launcher wired.
//
// Per agent-chat-surface.md L13–L21 V1 default: click → topology seat
// detail with cmux launcher button. Phase 3 stubbed the navigation;
// Phase 4 wires the cmux launcher itself via useCmuxLaunch (POST to
// /api/rigs/$rigId/nodes/$logicalId/focus — existing pre-Phase-2
// endpoint per architecture.md L88; no new daemon endpoint).
//
// Click semantics: Tag click → cmux launches (foregrounds the seat
// in cmux). The label stays a Link so right-click / cmd-click still
// open the seat detail page (URL preserved).

import { Link } from "@tanstack/react-router";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { ActorMark, isHumanActor } from "../graphics/RuntimeMark.js";

interface AuthorAgentTagProps {
  authorSession: string;
  rigId?: string;
  className?: string;
  testId?: string;
}

function parseSeat(authorSession: string): { logicalId: string; rigId: string | null } {
  const at = authorSession.indexOf("@");
  if (at === -1) return { logicalId: authorSession, rigId: null };
  return {
    logicalId: authorSession.slice(0, at),
    rigId: authorSession.slice(at + 1),
  };
}

export function AuthorAgentTag({ authorSession, rigId, className, testId }: AuthorAgentTagProps) {
  const parsed = parseSeat(authorSession);
  const targetRigId = rigId ?? parsed.rigId;
  const cmuxLaunch = useCmuxLaunch();
  const humanActor = isHumanActor(authorSession);

  // If we can't resolve a rigId, just show the tag without a link.
  if (!targetRigId) {
    return (
      <span
        data-testid={testId ?? "author-agent-tag"}
        className={className ?? "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant"}
      >
        {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
        <span>{authorSession}</span>
      </span>
    );
  }

  return (
    <Link
      to="/topology/seat/$rigId/$logicalId"
      params={{ rigId: targetRigId, logicalId: encodeURIComponent(parsed.logicalId) }}
      data-testid={testId ?? "author-agent-tag"}
      onClick={(e) => {
        // Cmd/Ctrl-click or right-click → standard Link behavior (open seat detail).
        // Plain click → fire cmux launcher AND let Link navigate.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        cmuxLaunch.mutate({ rigId: targetRigId, logicalId: parsed.logicalId });
      }}
      className={
        className ??
        "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant hover:text-stone-900 hover:underline"
      }
    >
      {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
      <span>{authorSession}</span>
    </Link>
  );
}
