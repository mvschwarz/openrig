// V1 attempt-3 Phase 3 — AuthorAgentTag stub per agent-chat-surface.md L96–L100.
//
// Phase 3 lays the click handler stub; Phase 4 wires actual cmux launcher
// + topology seat navigation.

import { Link } from "@tanstack/react-router";

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

  // V1: route to topology seat detail. V2 wires right-drawer web terminal.
  // If we can't resolve a rigId, just show the tag without a link.
  if (!targetRigId) {
    return (
      <span
        data-testid={testId ?? "author-agent-tag"}
        className={className ?? "font-mono text-[10px] text-on-surface-variant"}
      >
        {authorSession}
      </span>
    );
  }

  return (
    <Link
      to="/topology/seat/$rigId/$logicalId"
      params={{ rigId: targetRigId, logicalId: encodeURIComponent(parsed.logicalId) }}
      data-testid={testId ?? "author-agent-tag"}
      className={
        className ??
        "font-mono text-[10px] text-on-surface-variant hover:text-stone-900 hover:underline"
      }
    >
      {authorSession}
    </Link>
  );
}
