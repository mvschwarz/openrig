import type { CommunityHarnessPreset } from "../domain/community-harness-presets.js";
import type { NodeBinding } from "../domain/runtime-adapter.js";
import { validateSessionFileFormat } from "../domain/resume-token-validation.js";
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

  /** Whether this launch's preset declares an OpenRig-aware runner, recorded on the session with the launch. */
  runner(): boolean {
    return true;
  }

  /** What its launch refuses before starting anything, checked before a handover ends the predecessor: a launch wrapper,
   *  which only built-in Pi applies. Whether the runner starts, signs in or gets ready is known only by launching it. */
  async preflightLaunch(binding: NodeBinding): Promise<{ ok: true } | { ok: false; error: string }> {
    const error = this.unsupportedLaunchWrapper(binding);
    return error ? { ok: false, error } : { ok: true };
  }

  protected override get commandName(): string | undefined {
    return this.preset.command;
  }

  protected override get resumeType(): string {
    return `community:${this.runtime}`;
  }

  protected override validateToken(rawToken: unknown): { ok: true; token: string; resumeType: string } | { ok: false; error: string } {
    const res = validateSessionFileFormat(rawToken, this.runtime);
    if (!res.ok) return res;
    return { ok: true, token: res.token, resumeType: this.resumeType };
  }
}
