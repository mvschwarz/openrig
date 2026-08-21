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
//   rig policy list [--spec]              — built-ins + the reserved deliberate-none + CUSTOM
//                                           policies visible in the given spec context
//   rig policy show <name-or-ref> [--spec]— one built-in OR a custom policy spec (validated)
//   rig policy current --spec <path>      — the effective recorded policy + WHAT WOULD APPLY,
//                                           through the AUTHORITATIVE validator/resolver
//   rig policy apply <name> --spec <path> — record the choice (same flow as `rig setup --policy`,
//                                           which STAYS as the setup-flow composition, not an alias)
//
// AUTHORITATIVE SEMANTICS, NOT A PRIVATE CLASSIFIER (r2 HIGH-2): every ref this verb reports runs
// through validatePermissionPolicyRef + resolvePermissionPolicyAttachment — byte-equivalent CLI
// twins of the daemon's permission-policy modules (lib/permission-policy/*, lib/path-safety.ts;
// pinned by permission-policy-parity.test.ts). An invalid ref exits 1 with the authoritative error
// — this surface must never bless a spec defect the daemon's own validation refuses.

import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import fs from "node:fs";
import path from "node:path";
import {
  defaultDeps,
  recordPermissionPolicyStep,
  resolveExistingSpecPath,
  POLICY_CHOICES,
} from "./setup.js";
import {
  BUILTIN_POLICY_NAMES,
  validatePermissionPolicyRef,
  resolvePermissionPolicyAttachment,
  type ResolvedPolicyAttachment,
} from "../lib/permission-policy/policy-ref.js";
import { parsePolicySpec, validatePolicySpec } from "../lib/permission-policy/policy-spec.js";

const HONESTY_PIN =
  "OpenRig bakes NO allow/ask/deny permission policy — the harness-native permissions are the control surface. " +
  "OpenRig records posture into RigSpec; harness-native permissions enforce — never runtime enforcement.";

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  locked: "the most restrictive packaged posture — for seats that must not touch anything unattended",
  standard: "the packaged default posture for managed working seats",
  open: "a permissive packaged posture for trusted, high-autonomy seats",
  yolo: "the operator/no-guardrails posture — everything the harness allows (launch posture: full_bypass)",
  none: "the RESERVED deliberate-none choice: recorded as permission_policy: none — posture identical to absent (the floor), but the absence is chosen and visible",
};

function refFor(name: string): string {
  return name === "none" ? "none" : `builtin:${name}`;
}

const readFileDep = { readFile: (p: string) => fs.readFileSync(p, "utf-8") };

interface SpecRefSite {
  site: string; // "rig" | "pods[i].members[j] (<logical id>)"
  /** The RAW declared value: undefined = the key is truly absent; anything else (including a
   *  non-string YAML value) is PRESENT and goes to the authoritative validator — a present
   *  non-string must surface as INVALID, never quietly become "absent → floor" (r2 round 3). */
  ref: unknown;
}

/** Collect every permission_policy declaration site in a parsed rig spec (rig level + members).
 *  Presence is keyed on the KEY existing, not on the value being a string. */
function collectRefSites(doc: Record<string, unknown>): SpecRefSite[] {
  const sites: SpecRefSite[] = [{
    site: "rig",
    ref: Object.prototype.hasOwnProperty.call(doc, "permission_policy") ? doc["permission_policy"] : undefined,
  }];
  const pods = Array.isArray(doc["pods"]) ? (doc["pods"] as Array<Record<string, unknown>>) : [];
  pods.forEach((pod, pi) => {
    const members = Array.isArray(pod["members"]) ? (pod["members"] as Array<Record<string, unknown>>) : [];
    members.forEach((member, mi) => {
      if (member && typeof member === "object" && Object.prototype.hasOwnProperty.call(member, "permission_policy")) {
        const id = [pod["id"], member["id"]].filter(Boolean).join(".");
        sites.push({ site: `pods[${pi}].members[${mi}]${id ? ` (${id})` : ""}`, ref: member["permission_policy"] });
      }
    });
  });
  return sites;
}

function loadSpec(specPath: string): { resolved: string; doc: Record<string, unknown> } | { error: string } {
  const resolved = resolveExistingSpecPath(defaultDeps(), specPath);
  if (!resolved) {
    return { error: `No rig spec found at ${specPath} (looked for a file, then rig.yaml/rig.yml/agent.yaml/agent.yml inside it).` };
  }
  try {
    const doc = (parseYaml(fs.readFileSync(resolved, "utf-8")) ?? {}) as Record<string, unknown>;
    return { resolved, doc };
  } catch (err) {
    return { error: `Could not parse ${resolved}: ${(err as Error).message}` };
  }
}

/** Render "what would apply" for one resolved attachment. */
function describeAttachment(a: ResolvedPolicyAttachment): string {
  const parts = [
    `origin=${a.origin}`,
    a.builtinName ? `builtin=${a.builtinName}` : null,
    a.resolvedTarget ? `target=${a.resolvedTarget}` : null,
    a.surface ? `surface=${a.surface}` : null,
    `launch_posture=${a.launchPosture}`,
    `content_resolved=${a.contentResolved}`,
  ].filter(Boolean);
  const advisory = a.origin === "custom" && !a.contentResolved
    ? " — UNRESOLVED custom content: the advisory FLOOR applies until the policy spec reads + validates"
    : "";
  return parts.join(" · ") + advisory;
}

export function policyCommand(): Command {
  const cmd = new Command("policy").description(
    `Teach and record the rig-level permission policy. ${HONESTY_PIN} (The context-mode verb formerly at this name is now: rig mode.)`,
  );

  cmd
    .command("list")
    .description(`List the built-in permission-policy templates, plus the custom policies visible in a spec context. ${HONESTY_PIN}`)
    .option("--spec <path>", "Rig spec (file or directory) defining the custom-policy context")
    .option("--json", "Machine-readable output")
    .action((opts: { spec?: string; json?: boolean }) => {
      const builtins = POLICY_CHOICES.map((name) => ({ name, ref: refFor(name), origin: name === "none" ? "deliberate_none" : "builtin", description: BUILTIN_DESCRIPTIONS[name] ?? "" }));
      const custom: Array<Record<string, unknown>> = [];
      let specError: string | null = null;
      if (opts.spec) {
        const loaded = loadSpec(opts.spec);
        if ("error" in loaded) {
          specError = loaded.error;
        } else {
          const declaringDir = path.dirname(loaded.resolved);
          for (const { site, ref } of collectRefSites(loaded.doc)) {
            if (ref === undefined) continue; // truly absent
            if (typeof ref === "string" && (ref === "none" || ref.startsWith("builtin:"))) continue;
            const invalid = validatePermissionPolicyRef(ref, `${site}.permission_policy`);
            if (invalid) {
              custom.push({ site, ref, invalid });
              continue;
            }
            const a = resolvePermissionPolicyAttachment(ref as string, declaringDir, readFileDep);
            custom.push({ site, ref, resolvedTarget: a.resolvedTarget, surface: a.surface ?? null, launchPosture: a.launchPosture, contentResolved: a.contentResolved });
          }
        }
      }
      if (opts.json) {
        console.log(JSON.stringify({ policies: builtins, custom, ...(specError ? { specError } : {}), note: HONESTY_PIN }));
      } else {
        for (const r of builtins) console.log(`${r.name.padEnd(10)} ${r.ref.padEnd(18)} ${r.description}`);
        if (opts.spec && !specError) {
          console.log(custom.length > 0 ? "\nCustom policies in the spec set:" : "\n(no custom policies referenced in the spec set)");
          for (const c of custom) {
            console.log(c.invalid
              ? `  ${String(c.site).padEnd(28)} ${c.ref} — INVALID: ${c.invalid}`
              : `  ${String(c.site).padEnd(28)} ${c.ref} → ${c.resolvedTarget} (surface=${c.surface ?? "?"}, launch_posture=${c.launchPosture}, content_resolved=${c.contentResolved})`);
          }
        }
        if (specError) console.error(specError);
        console.log(`\n${HONESTY_PIN}`);
      }
      if (specError) process.exitCode = 1;
    });

  cmd
    .command("show <nameOrRef>")
    .description("Show one built-in policy choice, or validate + open a CUSTOM policy spec by ref (relative to --spec's directory, else cwd).")
    .option("--spec <path>", "Rig spec (file or directory) whose directory anchors a custom ref")
    .option("--json", "Machine-readable output")
    .action((nameOrRef: string, opts: { spec?: string; json?: boolean }) => {
      if ((POLICY_CHOICES as readonly string[]).includes(nameOrRef)) {
        const out = {
          name: nameOrRef,
          ref: refFor(nameOrRef),
          origin: nameOrRef === "none" ? "deliberate_none" : "builtin",
          description: BUILTIN_DESCRIPTIONS[nameOrRef] ?? "",
          recordedAs: `permission_policy: ${refFor(nameOrRef)}`,
          launchPosture: nameOrRef === "yolo" ? "full_bypass" : "floor",
          enforcement: HONESTY_PIN,
        };
        if (opts.json) console.log(JSON.stringify(out));
        else {
          console.log(`${out.name} — ${out.description}`);
          console.log(`Recorded as: ${out.recordedAs} (launch_posture: ${out.launchPosture})`);
          console.log(out.enforcement);
        }
        return;
      }
      // Custom ref path — AUTHORITATIVE validation first; an invalid ref is a loud refusal.
      const ref = nameOrRef.startsWith("builtin:") ? nameOrRef : nameOrRef;
      const invalid = validatePermissionPolicyRef(ref, "policy ref");
      if (invalid) {
        console.error(invalid);
        console.error(`Known built-ins: ${POLICY_CHOICES.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      let declaringDir = process.cwd();
      let anchor = "cwd";
      if (opts.spec) {
        const loaded = loadSpec(opts.spec);
        if ("error" in loaded) {
          console.error(loaded.error);
          process.exitCode = 1;
          return;
        }
        declaringDir = path.dirname(loaded.resolved);
        anchor = loaded.resolved;
      }
      const resolvedTarget = path.resolve(declaringDir, ref);
      let raw: string;
      try {
        raw = fs.readFileSync(resolvedTarget, "utf-8");
      } catch {
        console.error(`Custom policy '${ref}' does not resolve: ${resolvedTarget} is missing or unreadable (anchored at ${anchor}). The advisory FLOOR would apply.`);
        process.exitCode = 1;
        return;
      }
      const parsed = parsePolicySpec(raw);
      if ("error" in parsed) {
        console.error(`Custom policy '${ref}' at ${resolvedTarget} is INVALID: ${parsed.error}`);
        process.exitCode = 1;
        return;
      }
      const contract = validatePolicySpec(parsed.frontmatter);
      const attachment = resolvePermissionPolicyAttachment(ref, declaringDir, readFileDep);
      const out = {
        ref,
        origin: "custom",
        resolvedTarget,
        declaringDir,
        surface: attachment.surface ?? null,
        launchPosture: attachment.launchPosture,
        contentResolved: attachment.contentResolved,
        contractValid: contract.ok,
        contractErrors: contract.errors,
        enforcement: HONESTY_PIN,
      };
      if (opts.json) console.log(JSON.stringify(out));
      else {
        console.log(`${ref} → ${resolvedTarget}`);
        console.log(describeAttachment(attachment));
        if (!contract.ok) for (const e of contract.errors) console.log(`  contract: ${e}`);
        console.log(HONESTY_PIN);
      }
      if (!contract.ok) process.exitCode = 1;
    });

  cmd
    .command("current")
    .description("Show the EFFECTIVE permission policy for a rig spec and what would apply, per site (rig + member overrides), through the authoritative validator/resolver.")
    .requiredOption("--spec <path>", "Rig spec file, or a directory containing rig.yaml/agent.yaml")
    .option("--json", "Machine-readable output")
    .action((opts: { spec: string; json?: boolean }) => {
      const loaded = loadSpec(opts.spec);
      if ("error" in loaded) {
        console.error(loaded.error);
        process.exitCode = 1;
        return;
      }
      const declaringDir = path.dirname(loaded.resolved);
      const sites = collectRefSites(loaded.doc);
      const rigRef = sites[0]!.ref;
      let anyInvalid = false;
      const report = sites.map(({ site, ref }) => {
        // member > rig precedence on PRESENCE (a present member value overrides, even an invalid one —
        // it must surface as ITS OWN defect, never silently disappear behind the rig ref).
        const effective = site === "rig" ? ref : (ref !== undefined ? ref : rigRef);
        if (effective === undefined) {
          return { site, ref: null, effective: null, applies: "absent — the floor (honest absence; nothing recorded)" };
        }
        const invalid = validatePermissionPolicyRef(effective, `${site}.permission_policy`);
        if (invalid) {
          anyInvalid = true;
          return { site, ref: ref ?? null, effective, invalid };
        }
        const a = resolvePermissionPolicyAttachment(effective as string, declaringDir, readFileDep);
        return { site, ref: ref ?? null, effective, applies: describeAttachment(a), attachment: a };
      });
      const out = { spec: loaded.resolved, sites: report, enforcement: HONESTY_PIN };
      if (opts.json) console.log(JSON.stringify(out));
      else {
        console.log(`Spec: ${loaded.resolved}`);
        for (const r of report) {
          if ("invalid" in r && r.invalid) console.log(`${r.site}: ${r.effective} — INVALID: ${r.invalid}`);
          else console.log(`${r.site}: ${r.effective ?? "(absent)"} — ${String((r as { applies?: string }).applies)}`);
        }
        console.log(HONESTY_PIN);
      }
      // An invalid ref is a spec DEFECT (the daemon's own validation refuses it) — never exit 0.
      if (anyInvalid) process.exitCode = 1;
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

// Re-exported so the parity test can assert the twin surface without deep-importing.
export { BUILTIN_POLICY_NAMES };
