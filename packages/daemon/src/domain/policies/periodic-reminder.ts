// PL-004 Phase C: periodic-reminder policy (TypeScript port of
// POC `lib/policies/periodic-reminder.mjs`).
//
// POC contract: target.session is required (top-level `target:` in
// spec_yaml). Message comes from `job.message` (top-level) OR
// `context.message`. Returns action=send unconditionally when invoked
// (the scheduler gates on interval; this policy itself is stateless).

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

interface PeriodicReminderContext {
  message?: string;
}

export const periodicReminderPolicy: Policy = {
  name: "periodic-reminder",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    if (!job.target?.session) {
      throw Object.assign(new Error("periodic-reminder: target.session is required"), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: "target.session",
      });
    }
    const context = job.context as PeriodicReminderContext;
    const message = job.message ?? context.message;
    if (!message) {
      throw Object.assign(new Error("periodic-reminder: message is required (top-level message or context.message)"), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: "message",
      });
    }
    return { action: "send", target: job.target, message };
  },
};
