// B7 (0.5.2, RULING-rig-mode-rig-policy-naming) — `rig policy`: the top-level PERMISSION-POLICY
// verb, introduced after the context-mode verb took its natural name (`rig mode`).
//
// BINDING HONESTY PIN (carried VERBATIM from setup.ts, per the ruling): OpenRig bakes NO
// allow/ask/deny permission policy — the harness-native permissions are the control surface.
// `rig policy` TEACHES and RECORDS into RigSpec (`permission_policy: builtin:<name> | none`); it
// never enforces at runtime. OpenRig records posture into RigSpec, harness-native permissions
// enforce — never runtime enforcement.
//
// v1 scope per the ruling (read-heavy + one write path):
//   rig policy list                       — built-in templates + the reserved deliberate-none
//   rig policy show <name>                — one built-in (ref form + recording semantics)
//   rig policy current --spec <path>      — the recorded ref in a rig spec + how it classifies
//   rig policy apply <name> --spec <path> — record the choice (same flow as `rig setup --policy`,
//                                           which STAYS as the setup-flow composition, not an alias)
//
// Ref semantics MIRROR the daemon's permission-policy/policy-ref.ts (the resolving side): the
// mandatory `builtin:` prefix, the reserved `none` literal, relative custom paths, absent = floor.
// This CLI surface only CLASSIFIES for display; resolution stays daemon-side at launch.

import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import {
  defaultDeps,
  recordPermissionPolicyStep,
  resolveExistingSpecPath,
  POLICY_CHOICES,
} from "./setup.js";

const HONESTY_PIN =
  "OpenRig bakes NO allow/ask/deny permission policy — the harness-native permissions are the control surface. " +
  "OpenRig records posture into RigSpec; harness-native permissions enforce — never runtime enforcement.";

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  locked: "the most restrictive packaged posture — for seats that must not touch anything unattended",
  standard: "the packaged default posture for managed working seats",
  open: "a permissive packaged posture for trusted, high-autonomy seats",
  yolo: "the operator/no-guardrails posture — everything the harness allows",
  none: "the RESERVED deliberate-none choice: recorded as permission_policy: none — posture identical to absent (the floor), but the absence is chosen and visible",
};

function refFor(name: string): string {
  return name === "none" ? "none" : `builtin:${name}`;
}

/** Classify a recorded permission_policy value for display (mirror of policy-ref semantics). */
function classifyRef(value: unknown): string {
  if (value === undefined || value === null) return "absent — the floor (honest absence; nothing recorded)";
  if (typeof value !== "string" || value.trim().length === 0) return "invalid — permission_policy must be a non-empty string ref";
  if (value === "none") return "deliberate none — recorded choice; posture identical to absent, but chosen";
  if (value.startsWith("builtin:")) {
    const name = value.slice("builtin:".length);
    return (POLICY_CHOICES as readonly string[]).includes(name) && name !== "none"
      ? `built-in template '${name}'`
      : `UNKNOWN built-in '${name}' — known set: ${POLICY_CHOICES.filter((c) => c !== "none").join(", ")} (a spec defect, resolved loudly at launch)`;
  }
  return `custom policy spec at '${value}' (resolved relative to the declaring RigSpec dir at launch)`;
}

export function policyCommand(): Command {
  const cmd = new Command("policy").description(
    `Teach and record the rig-level permission policy. ${HONESTY_PIN} (The context-mode verb formerly at this name is now: rig mode.)`,
  );

  cmd
    .command("list")
    .description(`List the built-in permission-policy templates. ${HONESTY_PIN}`)
    .option("--json", "Machine-readable output")
    .action((opts: { json?: boolean }) => {
      const rows = POLICY_CHOICES.map((name) => ({ name, ref: refFor(name), description: BUILTIN_DESCRIPTIONS[name] ?? "" }));
      if (opts.json) {
        console.log(JSON.stringify({ policies: rows, note: HONESTY_PIN }));
        return;
      }
      for (const r of rows) console.log(`${r.name.padEnd(10)} ${r.ref.padEnd(18)} ${r.description}`);
      console.log(`\n${HONESTY_PIN}`);
    });

  cmd
    .command("show <name>")
    .description("Show one built-in policy choice: its ref form and what recording it means.")
    .option("--json", "Machine-readable output")
    .action((name: string, opts: { json?: boolean }) => {
      if (!(POLICY_CHOICES as readonly string[]).includes(name)) {
        console.error(`Unknown policy '${name}'. Known set: ${POLICY_CHOICES.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      const out = {
        name,
        ref: refFor(name),
        description: BUILTIN_DESCRIPTIONS[name] ?? "",
        recordedAs: `permission_policy: ${refFor(name)}`,
        enforcement: HONESTY_PIN,
      };
      if (opts.json) console.log(JSON.stringify(out));
      else {
        console.log(`${out.name} — ${out.description}`);
        console.log(`Recorded as: ${out.recordedAs}`);
        console.log(out.enforcement);
      }
    });

  cmd
    .command("current")
    .description("Show the permission policy recorded in a rig spec and how it classifies.")
    .requiredOption("--spec <path>", "Rig spec file, or a directory containing rig.yaml/agent.yaml")
    .option("--json", "Machine-readable output")
    .action((opts: { spec: string; json?: boolean }) => {
      const deps = defaultDeps();
      const resolved = resolveExistingSpecPath(deps, opts.spec);
      if (!resolved) {
        console.error(`No rig spec found at ${opts.spec} (looked for a file, then rig.yaml/rig.yml/agent.yaml/agent.yml inside it).`);
        process.exitCode = 1;
        return;
      }
      let value: unknown;
      try {
        const doc = parseYaml(deps.readFile(resolved) ?? "") as Record<string, unknown> | null;
        value = doc?.["permission_policy"];
      } catch (err) {
        console.error(`Could not parse ${resolved}: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const out = { spec: resolved, permission_policy: value ?? null, classification: classifyRef(value), enforcement: HONESTY_PIN };
      if (opts.json) console.log(JSON.stringify(out));
      else {
        console.log(`Spec: ${out.spec}`);
        console.log(`permission_policy: ${out.permission_policy ?? "(absent)"}`);
        console.log(`Classifies as: ${out.classification}`);
        console.log(out.enforcement);
      }
    });

  cmd
    .command("apply <name>")
    .description(`Record a policy choice into an EXISTING rig spec (the same recording flow as \`rig setup --policy\`, which stays as the setup-step composition). ${HONESTY_PIN}`)
    .requiredOption("--spec <path>", "Rig spec file, or a directory containing rig.yaml/agent.yaml")
    .option("--json", "Machine-readable output")
    .action((name: string, opts: { spec: string; json?: boolean }) => {
      const step = recordPermissionPolicyStep(defaultDeps(), name, opts.spec);
      if (opts.json) console.log(JSON.stringify(step));
      else {
        console.log(step.message);
        if (step.status === "fail") {
          if (step.reason) console.log(step.reason);
          if (step.fixHint) console.log(`Fix: ${step.fixHint}`);
        }
      }
      if (step.status === "fail") process.exitCode = 1;
    });

  return cmd;
}
