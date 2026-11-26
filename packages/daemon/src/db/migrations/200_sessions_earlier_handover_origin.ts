import type { Migration } from "../migrate.js";

/** The pre-0.7.9 successor registration and its handover tenure were written together. A timestamp window alone is not
 *  identity: a later adoption can be inside it. Require the current handover tenure, one uniquely matching registration
 *  at its SQLite boot timestamp, and the completed launched handover. Missing, unreadable or ambiguous evidence proves
 *  nothing. Keep this SELECT shared with the explanation for an earlier successor that was subsequently released.
 *  A registration crossing a SQLite second boundary is deliberately not repaired without an exact retained link. */
export const earlierHandoverSuccessorQuery = `
  SELECT s.id AS session_id, n.id AS node_id, n.continuity_outcome, n.handover_at
    FROM nodes n JOIN sessions s ON s.node_id = n.id
    JOIN occupant_tenures t ON t.node_id = n.id
   WHERE n.handover_result = 'complete' AND n.continuity_outcome IN ('fresh', 'forked', 'rebuilt')
     AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
     AND t.generation_ordinal = (SELECT MAX(t2.generation_ordinal) FROM occupant_tenures t2 WHERE t2.node_id = n.id)
     AND t.kind = 'handover'
     -- These are retained instants, not SQLite relative values such as 'now'.
     AND s.created_at GLOB '????-??-??[ T]??:??:??*'
     AND t.boot_at GLOB '????-??-??[ T]??:??:??*'
     AND n.handover_at GLOB '????-??-??[ T]??:??:??*'
     AND julianday(s.created_at) = julianday(t.boot_at)
     -- handover_at has milliseconds; SQLite's registration/boot timestamps truncate to seconds.
     AND julianday(t.boot_at) BETWEEN julianday(n.handover_at) - 1.0 / 86400.0 AND julianday(n.handover_at) + 60.0 / 86400.0
     AND NOT EXISTS (SELECT 1 FROM sessions other WHERE other.node_id = n.id AND other.id != s.id
       AND julianday(other.created_at) = julianday(t.boot_at))
`;

/** #4003: apply #2440's launched origin to the earlier successors its own records establish. Data only, once by full
 *  migration name. A genuinely adopted session, or one whose origin cannot be established, keeps origin=claimed. */
export const sessionsEarlierHandoverOriginSchema: Migration = {
  name: "200_sessions_earlier_handover_origin.sql",
  sql: `
    UPDATE sessions SET origin = 'launched'
     WHERE origin = 'claimed' AND status != 'detached'
       AND id IN (SELECT session_id FROM (${earlierHandoverSuccessorQuery}));
  `,
};
