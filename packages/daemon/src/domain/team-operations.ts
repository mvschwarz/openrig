import { BUILD_INFO, type BuildInfo } from "../build-info.js";
import { TEAM_OPERATIONS_CONTRACT, type Support } from "./connection-contract.js";

export { TEAM_OPERATIONS_CONTRACT };

/** A team-operations capability: supported, not-supported or unknown; an absent key reads unknown. The contract an app
 *  reads before relying on a job's fields is one version with per-job capabilities, distinct from the build label. */
export type CapabilityValue = Support;

/** needs-me: see what needs me, answer as me, follow it through. This build reads it (what needs the person, each
 *  request's revision and what it's about, the answers returned to it, and a snapshot watermark). Answering under this
 *  contract (a stable answer identity) and following a request through to its result aren't in it yet; the existing
 *  answer paths keep working outside it. */
export const TEAM_OPERATIONS_CAPABILITIES: Record<string, CapabilityValue> = {
  "needs-me.read": "supported",
  "needs-me.answer": "not-supported",
  "needs-me.follow": "not-supported",
};

export function teamOperationsCapabilities(info: BuildInfo = BUILD_INFO) {
  return {
    contract: TEAM_OPERATIONS_CONTRACT,
    capabilities: TEAM_OPERATIONS_CAPABILITIES,
    // A source run has null build fields rather than an invented version.
    build: { semver: info.semver, commit: info.commit },
  };
}
