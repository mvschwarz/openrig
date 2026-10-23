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

type ReminderSpec = { message?: string | null; context: Record<string, unknown> };
const reminderMessage = (spec: ReminderSpec) => spec.message ?? (spec.context as PeriodicReminderContext).message;

/** What the spec lacks to be evaluated, or null. A job update checks a new spec with this too. */
export function periodicReminderSpecProblem(spec: ReminderSpec): { field: string; message: string } | null {
  return reminderMessage(spec)
    ? null : { field: "message", message: "periodic-reminder: message is required (top-level message or context.message)" };
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
    const problem = periodicReminderSpecProblem(job);
    if (problem) {
      throw Object.assign(new Error(problem.message), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: problem.field,
      });
    }
    return { action: "send", target: job.target, message: reminderMessage(job)! };
  },
};
