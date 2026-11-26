import type { Migration } from "../migrate.js";

/** #4003: before 0.7.9, a handover OpenRig launched (fresh, fork or rebuild) registered its successor through the
 *  adoption path, so the session reads origin=claimed, and stop, restart, clean and `rig down` treat it as a session
 *  OpenRig didn't launch. From 0.7.9 such a successor is recorded as launched (#2440). This records the earlier ones the
 *  same way: the seat's latest session, origin claimed and not released (detached), whose node's last handover completed
 *  as fresh, forked or rebuilt, created no later than a minute after that handover completed. The successor is registered
 *  in the handover's own commit, so a session adopted later is newer; an unreadable time leaves the row as it is.
 *  The same rule names this case at the refusals that remain (SeatLifecycleService.earlierHandoverRefusal). Data only. */
export const sessionsEarlierHandoverOriginSchema: Migration = {
  name: "200_sessions_earlier_handover_origin.sql",
  sql: `
    UPDATE sessions SET origin = 'launched'
     WHERE origin = 'claimed' AND status != 'detached'
       AND id IN (
         SELECT s.id FROM sessions s JOIN nodes n ON n.id = s.node_id
          WHERE n.handover_result = 'complete' AND n.continuity_outcome IN ('fresh', 'forked', 'rebuilt')
            AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)
            AND julianday(s.created_at) <= julianday(n.handover_at) + 60.0 / 86400.0
       );
  `,
};
