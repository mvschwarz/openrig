// V1 attempt-3 Phase 4 — AuthorAgentTag with cmux launcher wired.
//
// Per agent-chat-surface.md L13–L21 V1 default: click → topology seat
// detail with cmux launcher button. Phase 3 stubbed the navigation;
// Phase 4 wires the cmux launcher itself via useCmuxLaunch (POST to
// /api/rigs/$rigId/nodes/$logicalId/open-cmux — open-or-focus cmux
// surface semantics).
//
// Click semantics: Tag click → cmux launches (foregrounds the seat
// in cmux). The label stays a Link so right-click / cmd-click still
// open the seat detail page (URL preserved).

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { ActorMark, isHumanActor } from "../graphics/RuntimeMark.js";
import { parseSessionName } from "../../lib/session-name.js";
import { buildTopologySessionIndex, resolveTopologySession } from "../../lib/topology-activity.js";

interface AuthorAgentTagProps {
  authorSession: string;
  rigId?: string;
  className?: string;
  testId?: string;
}

/** The seat a canonical session names, resolved against its rig's own node inventory. A session's local part is
 *  `{pod}-{member}` and doesn't split back into a logical id (`dev-impl@my-rig` is `dev.impl`), and it names its rig
 *  while the seat page and the cmux launcher take the rig's id. Null until it resolves, or when it doesn't (a name
 *  that matches no rig or several, or no node). */
function useSessionSeat(authorSession: string, cardRigId: string | undefined): { rigId: string; logicalId: string } | null {
  const parsed = parseSessionName(authorSession);
  const rigName = parsed.kind === "canonical" ? parsed.rig : null;
  const rigs = usePsEntries();
  const named = rigName && !cardRigId ? (rigs.data ?? []).filter((rig) => rig.name === rigName) : [];
  const rigId = rigName ? cardRigId ?? (named.length === 1 ? named[0]!.rigId : null) : null;
  const nodes = useNodeInventory(rigId);
  return useMemo(() => {
    if (!rigId || !nodes.data) return null;
    const index = buildTopologySessionIndex(nodes.data.map((node) => ({
      nodeId: `${node.rigId}::${node.logicalId}`,
      rigId: node.rigId,
      rigName: node.rigName,
      logicalId: node.logicalId,
      canonicalSessionName: node.canonicalSessionName,
    })));
    const seat = resolveTopologySession(index, authorSession);
    return seat?.logicalId ? { rigId, logicalId: seat.logicalId } : null;
  }, [rigId, nodes.data, authorSession]);
}

export function AuthorAgentTag({ authorSession, rigId, className, testId }: AuthorAgentTagProps) {
  const seat = useSessionSeat(authorSession, rigId);
  const cmuxLaunch = useCmuxLaunch();
  const humanActor = isHumanActor(authorSession);

  // Until the seat resolves, show the tag without a link: a guessed id would open the wrong seat or none.
  if (!seat) {
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
      params={{ rigId: seat.rigId, logicalId: encodeURIComponent(seat.logicalId) }}
      data-testid={testId ?? "author-agent-tag"}
      onClick={(e) => {
        // Cmd/Ctrl-click or right-click → standard Link behavior (open seat detail).
        // Plain click → fire cmux launcher AND let Link navigate.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        cmuxLaunch.mutate({ rigId: seat.rigId, logicalId: seat.logicalId });
      }}
      className={
        className ??
        "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant hover:text-on-surface hover:underline"
      }
    >
      {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
      <span>{authorSession}</span>
    </Link>
  );
}
