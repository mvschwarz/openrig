/**
 * slice-07 R6 — the eval PROVIDER seam. The runner drives cases through this interface, so the
 * live-model executor (spawn a real seat, send the natural prompt, capture what it ran) stays
 * behind one boundary and its execution is optional/deferred (API-gated), per the desk ruling.
 * The FakeProvider makes the harness runnable end-to-end deterministically (CI + unit tests)
 * without any model access.
 */

export interface EvalRunResult {
  /** What the agent produced — the captured transcript the grader reads. */
  transcript: string;
  durationMs?: number;
  /** Transport/execution failure (distinct from a graded FAIL). */
  error?: string;
}

export interface EvalProvider {
  name: string;
  /** Run one natural prompt (optionally with injected context) and return the captured transcript. */
  run(prompt: string, context?: string): Promise<EvalRunResult>;
}

/** A deterministic provider backed by canned transcripts keyed by prompt. */
export class FakeProvider implements EvalProvider {
  readonly name = "fake";
  constructor(private readonly transcripts: Record<string, string>) {}

  async run(prompt: string): Promise<EvalRunResult> {
    const transcript = this.transcripts[prompt];
    if (transcript === undefined) {
      return { transcript: "", error: `FakeProvider: no canned transcript for prompt ${JSON.stringify(prompt)}` };
    }
    return { transcript };
  }
}
