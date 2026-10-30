import type { CommunityHarnessPreset } from "../domain/community-harness-presets.js";
import { PiRuntimeAdapter, type PiRuntimeAdapterDeps } from "./pi-runtime-adapter.js";

/**
 * A community harness that speaks Pi's RPC protocol (e.g. OmO Native on senpi, Prime Agent, or other Pi forks).
 * Runs through OpenRig's Pi runner inside the seat's pane with full structured activity, typed RPC prompt/steer,
 * session file tracking, and resume capabilities.
 */
export class PiCommunityRuntimeAdapter extends PiRuntimeAdapter {
  override readonly runtime: string;
  readonly communityHarness: string;
  readonly preset: CommunityHarnessPreset;

  constructor(
    runtime: string,
    preset: CommunityHarnessPreset,
    deps: PiRuntimeAdapterDeps,
  ) {
    super(deps);
    this.runtime = runtime;
    this.communityHarness = runtime;
    this.preset = preset;
  }

  static fromPiAdapter(pi: PiRuntimeAdapter, runtime: string, preset: CommunityHarnessPreset): PiCommunityRuntimeAdapter {
    return new PiCommunityRuntimeAdapter(runtime, preset, pi.getCommunityDeps());
  }

  protected override get commandName(): string | undefined {
    return this.preset.command;
  }

  protected override get resumeType(): string {
    return `community:${this.runtime}`;
  }
}
