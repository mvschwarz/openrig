// V1 attempt-3 Phase 3 — refactored in place from Phase 2 shell-and-stub
// (DRIFT P2-C resolution) to the For You feed render shape per
// for-you-feed.md. The component name persists for backward compat;
// the body renders the Feed (5 card types + lens chips + client-synthesize
// SHIPPED per SC-17 — NO new daemon event types per SC-29).

import { Feed } from "../for-you/Feed.js";

export function MissionControlSurface() {
  return <Feed />;
}
