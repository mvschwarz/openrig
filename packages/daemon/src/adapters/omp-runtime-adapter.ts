import nodePath from "node:path";
import { PiRuntimeAdapter } from "./pi-runtime-adapter.js";
import { piSeatPaths } from "./pi-runner-protocol.js";

/** OMP shares the Pi runner and seat-sidecar protocol, but selects OMP's own
 * CLI, isolated state root, approval semantics, and resume-token type. */
export class OmpRuntimeAdapter extends PiRuntimeAdapter {
  override readonly runtime = "omp" as const;

  /** project() writes skills into the seat agent dir, which the runner pins as
   *  OMP's PI_CODING_AGENT_DIR; a Claude copy in a shared cwd is not this seat's. */
  skillTargetPath(tmuxSession: string | null, effectiveId: string): string | null {
    if (!tmuxSession) return null;
    return nodePath.join(piSeatPaths(this.stateRoot, tmuxSession).agentDir, "skills", effectiveId, "SKILL.md");
  }

  /** #875: OMP keeps its guidance in the repository AGENTS.md. Pi's agent-folder loading was shown natively; OMP's wasn't. */
  override guidanceFileFor(): { file: string | null; note?: string } {
    return { file: null };
  }
}
