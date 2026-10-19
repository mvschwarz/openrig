import type Database from "better-sqlite3";
import type { WorkflowSpec } from "./workflow-types.js";
import type { LifecycleGraphSource } from "./project-lifecycle-compiler.js";
import { exceptionPolicy, resolveExceptionRoute, type ExceptionRouteInput } from "./workflow-exception-router.js";
import { WorkflowHumanDestinationError } from "./workflow-human-destination.js";
import { isRigRelativeTarget } from "./workflow-rig-placeholder.js";
import { rigMemberExists, roleResolutionContext, tryResolveRoleByCapability } from "./workflow-role-context.js";

/** The configuration owner, not a generated cached spec or every source mirror. */
export function exceptionConfigurationSource(sourcePath: string, graph?: LifecycleGraphSource): string {
  if (graph?.mode === "project-profile" || graph?.mode === "mission-extend")
    return `${graph.profileSource}.workflow.exception_routing`;
  if (graph?.mode === "legacy-slices") return `${sourcePath}#lifecycle.workflow.exception_routing`;
  return `${graph?.missionSource ?? `${sourcePath}#workflow`}.exception_routing`;
}

export interface ExceptionReadiness {
  scope: "future-occurrences";
  posture: "advisory";
  selection: { state: "missing" | "selected" | "undeclared"; role: string | null; source: string; entryRole: string | null };
  routes: Array<{
    exceptionClass: string; state: string; roleResolution: string; destinationSession: string | null;
    position: string | null; resolvedVia: string | null; identity: string; message: string;
  }>;
  nextAction: string;
}

/** Read the same lazy resolver as detection. Failed reads stay unavailable;
 * inspection never writes, routes work, or imposes an admission gate. */
export function inspectExceptionReadiness(input: {
  db: Database.Database; spec: WorkflowSpec; source: string; boundRig?: string | null;
  hostDefault: () => ExceptionRouteInput["hostDialDefault"];
  humanFallbackSeat?: ExceptionRouteInput["humanFallbackSeat"];
  instanceId?: string;
}): ExceptionReadiness {
  const { spec } = input;
  const role = spec.exception_routing?.orchestrator_role ?? null;
  const selected = role === null ? "missing" : Object.hasOwn(spec.roles, role) ? "selected" : "undeclared";
  const selection = { state: selected, role, source: input.source + ".orchestrator_role", entryRole: spec.entry?.role ?? null } as ExceptionReadiness["selection"];
  const ctx = roleResolutionContext(input.db, input.boundRig ?? spec.target?.rig);
  const routes: ExceptionReadiness["routes"] = [];
  // These are the two admitted exception classes. Human gates already carry
  // their own explicit decision obligation and do not mint another exception.
  for (const exceptionClass of ["unmapped_failed", "stuck_overdue"] as const) {
    let roleResolution = "not-needed";
    let position: string | null = null, resolvedVia: string | null = null;
    let destinationSession: string | null = null;
    try {
      const hostDialDefault = input.hostDefault();
      ({ position, resolvedVia } = exceptionPolicy({ spec, exceptionClass, hostDialDefault }));
      if (position === "orchestrator" && selected !== "selected") roleResolution = selected + "-selection";
      const route = resolveExceptionRoute({ spec, exceptionClass, hostDialDefault, humanFallbackSeat: input.humanFallbackSeat,
        resolveRoleTarget: name => {
          const preferred = spec.roles[name]?.preferred_targets?.[0];
          if (preferred) { roleResolution = "preferred-target"; return preferred; }
          roleResolution = "unavailable";
          const target = tryResolveRoleByCapability(ctx, name);
          roleResolution = target ? "capability-match" : ctx ? "no-match" : "unbound";
          return target;
        },
      });
      position = route.position;
      destinationSession = route.destinationSession;
      // Authored preferred targets are the existing route policy. Verify their
      // declared identity separately; never turn an advisory read into fallback.
      let identity = route.humanRouted ? "registered-human" : "declared-agent";
      // An unbound read still holds the literal member@{rig}; no rig is declared for it yet.
      const rigRelative = roleResolution === "preferred-target" && isRigRelativeTarget(destinationSession);
      if (roleResolution === "preferred-target") {
        const rig = destinationSession.split("@")[1];
        identity = rig && rigMemberExists(input.db, rig, destinationSession) ? "declared-member" : "unregistered";
      }
      routes.push({ exceptionClass, state: identity === "unregistered" ? "unregistered" : "ready", roleResolution,
        destinationSession, position, resolvedVia, identity,
        message: identity === "unregistered" && rigRelative ? `The authored target ${destinationSession} needs a bound rig (--rig) or a literal rig name to resolve; it is checked once an instance is bound.`
          : identity === "unregistered" ? "The authored target is not a declared rig member. Check rig ps --nodes --json and correct the selected role's preferred_targets."
          : route.position === "fallback" ? `Registered-human fallback; agent resolution: ${roleResolution}.`
          : "Current evidence resolves this route; it is re-read when an occurrence is admitted." });
    } catch (error) {
      const state = error instanceof WorkflowHumanDestinationError ? error.details.state : "unavailable";
      routes.push({ exceptionClass, state, roleResolution, destinationSession, position, resolvedVia, identity: "unverified",
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  const correction = routes.every(route => route.position === "human_only")
    ? `The selected policy routes directly to a registered human; no orchestrator selection is required. Inspect ${input.source}.`
    : selected === "missing"
    ? `A defined entry/ordinary role does not select exception ownership. Select the intended declared role at ${selection.source}.`
    : selected === "undeclared" ? `Declare the intended role, or correct ${selection.source}; ${role} is not declared.`
      : `Inspect the selected routing contract at ${input.source}.`;
  return { scope: "future-occurrences", posture: "advisory", selection, routes,
    nextAction: correction + (input.instanceId
      ? ` After a source correction, inspect rig workflow revise ${input.instanceId} and deliberately apply its compatible proposal. Editing a file does not change the running owner. Existing exception obligations keep their owners.`
      : " Compile again after correction. This is a pre-failure advisory. At detection, a required resolution read that fails blocks that occurrence; ordinary work is not gated by this inspection.") };
}
