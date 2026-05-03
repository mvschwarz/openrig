// PL-004 Phase C: periodic-reminder policy (TypeScript port of
// POC `lib/policies/periodic-reminder.mjs`, 15 lines).
//
// Contract: explicit context.target.session and context.message both
// required. Throws for missing either (hard contract violation).
// Returns action=send unconditionally when invoked (the scheduler
// gates on interval; this policy itself is stateless).

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

interface PeriodicReminderContext {
  target?: { session?: string };
  message?: string;
}

export const periodicReminderPolicy: Policy = {
  name: "periodic-reminder",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    const context = job.context as PeriodicReminderContext;
    const targetSession = context.target?.session;
    const message = context.message;
    if (!targetSession) {
      throw Object.assign(new Error("periodic-reminder requires context.target.session"), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: "context.target.session",
      });
    }
    if (!message) {
      throw Object.assign(new Error("periodic-reminder requires context.message"), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: "context.message",
      });
    }
    return { action: "send", target: targetSession, message };
  },
};
