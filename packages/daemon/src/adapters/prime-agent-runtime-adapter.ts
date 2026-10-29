import { PiRuntimeAdapter } from "./pi-runtime-adapter.js";

/** prime-agent is a pi fork (@earendil-works/pi-coding-agent) with intact
 *  --mode rpc; it rides the shared runner. project() writes skills into the
 *  seat agent dir, which the runner pins as PI_CODING_AGENT_DIR — prime-agent
 *  reads the same layout. */
export class PrimeAgentRuntimeAdapter extends PiRuntimeAdapter {
  override readonly runtime = "prime-agent" as const;
}
