import { PiRuntimeAdapter } from "./pi-runtime-adapter.js";

/** OMP shares the Pi runner and seat-sidecar protocol, but selects OMP's own
 * CLI, isolated state root, approval semantics, and resume-token type. */
export class OmpRuntimeAdapter extends PiRuntimeAdapter {
  override readonly runtime = "omp" as const;
}
