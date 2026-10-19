// One recovery pass's work, shared in turn by every channel and thread it reaches.

/** The two Slack methods recovery calls; each has its own rate limit. */
export const HISTORY = "conversations.history";
export const REPLIES = "conversations.replies";

export interface RecoveryBudget { deadline: number; calls: number; entries: number }

/** Four history calls, 100 entries and 15 seconds per pass, however many sources share it. */
export function newRecoveryBudget(now: number): RecoveryBudget {
  return { deadline: now + 15_000, calls: 0, entries: 0 };
}

export function budgetLeft(budget: RecoveryBudget, now: number): boolean {
  return budget.calls < 4 && budget.entries < 100 && now < budget.deadline;
}

/** Slack rate-limits each Web API method on its own, so a Retry-After holds back only that method. */
export class MethodBackoff {
  private readonly until = new Map<string, number>();
  blocked(method: string, now: number): boolean { return (this.until.get(method) ?? 0) > now; }
  hold(method: string, at: number): void { this.until.set(method, Math.max(at, this.until.get(method) ?? 0)); }
}

/** A channel or thread a pass can take one step of. */
export interface RecoverySource {
  readonly key: string;
  /** At most one Slack call. "more": this source has more to scan now. */
  step(budget: RecoveryBudget, backoff: MethodBackoff): Promise<"more" | "done">;
}
