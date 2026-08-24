import type { EvalProvider, EvalRunResult } from "./eval-provider.js";

/** A live seat session backing the persistent provider mode (Test-A). The
 *  implementation is the non-author's live wiring (spawn via the rig CLI,
 *  capture via the transport); this interface is the seam the orchestration
 *  is proven against. */
export interface RigSeatSession {
  /** Stable identity of the live seat GENERATION backing this session — the
   *  persistence proof compares it across phases. */
  generation: string;
  sendPrompt(prompt: string): Promise<void>;
  /** Capture the pane/transcript content produced since `prompt` was sent.
   *  Implementations return RAW capture; the provider owns the input-echo
   *  contamination control. */
  captureSince(prompt: string): Promise<string>;
  retire(): Promise<void>;
}

export interface RigSeatProviderOptions {
  /** Config-resolved packs root the spawned seat pulls from (Track A: OPENRIG_CONTEXT_PACKS_ROOT). */
  packsRoot: string;
  /** Seat spec / model to fork for the eval, when the non-author wires this live. */
  seatSpec?: string;
  /** Test-A (row 782b467a): SESSION-PERSISTENT mode — one seat/generation
   *  across baseline -> WALK -> GET -> post. Spawn is called lazily ONCE; every
   *  run() reuses the same session until dispose(). */
  session?: { spawn: () => Promise<RigSeatSession> };
}

/**
 * slice-07 R6 — the LIVE-SEAT provider: the proof-contract PULL-WORKS / AGENT-DRIVEN door.
 *
 * Two modes behind the ONE EvalProvider seam (Test-A completes the deferred live leg, it does
 * not redesign the harness):
 *
 * - SESSION-PERSISTENT (Test-A): `session.spawn` provides a live RigSeatSession; the provider
 *   spawns lazily once, reuses the same seat/generation for every run() (the baseline -> WALK ->
 *   GET -> post phases are successive run() calls from the driver), and owns the INPUT-ECHO
 *   contamination control: the LEADING echo of the prompt (the pane's echoed input) is stripped
 *   from the returned transcript so the deterministic door can never pass by matching the
 *   prompt's own text — while a genuine later quotation by the seat is kept (stripping every
 *   occurrence would falsify real output). dispose() retires the seat exactly once; run() after
 *   dispose refuses loud.
 *
 * - LEGACY (no session deps): THROWS — rather than returning a plausible empty transcript — so a
 *   live run can never read as a false green before the wiring exists. Run the harness with
 *   --provider fake instead.
 */
export class RigSeatProvider implements EvalProvider {
  readonly name = "rig-seat";
  private session: RigSeatSession | null = null;
  private disposed = false;

  constructor(private readonly opts: RigSeatProviderOptions) {}

  async run(prompt: string): Promise<EvalRunResult> {
    if (!this.opts.session) {
      throw new Error(
        "RigSeatProvider is the live proof-contract door and is not yet driven. The non-author wires " +
          "seat spawn (packs root = OPENRIG_CONTEXT_PACKS_ROOT), natural-prompt send, and transcript " +
          "capture here, then verifies live. Until then, run the harness with --provider fake. See " +
          "packages/test-system/evals/README.md.",
      );
    }
    if (this.disposed) {
      throw new Error("RigSeatProvider session is retired/disposed — a new provider (and seat) is required for further runs.");
    }
    if (!this.session) {
      this.session = await this.opts.session.spawn();
    }
    const started = Date.now();
    await this.session.sendPrompt(prompt);
    const raw = await this.session.captureSince(prompt);
    return { transcript: stripLeadingEcho(raw, prompt), durationMs: Date.now() - started };
  }

  /** Retire the persistent seat. Idempotent; only the first call retires. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.session) {
      await this.session.retire();
      this.session = null;
    }
  }
}

/** The input-echo contamination control: remove the LEADING occurrence of the
 *  prompt (the pane's echoed input line(s)) from a raw capture. Only the
 *  leading echo — a seat that later QUOTES the prompt produced that text
 *  itself, and stripping it would falsify genuine output. */
function stripLeadingEcho(raw: string, prompt: string): string {
  let out = raw;
  if (out.startsWith(prompt)) {
    out = out.slice(prompt.length);
    if (out.startsWith("\n")) out = out.slice(1);
  }
  return out;
}
