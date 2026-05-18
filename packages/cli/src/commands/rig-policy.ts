// Slice 09 (OPR.0.3.2.9) — `rig policy` CLI: operator-context-mode
// surface. Pairs with the daemon's typed-primitive store.
//
// Subcommands:
//   rig policy set <mode> [--scope ...] [--qualifier ...] [--<field> ...]
//                         [--evidence ...] [--confirm]
//                         → restate-and-confirm; PUT only when --confirm
//   rig policy show       → list all bindings (defaults to JSON-when-piped)
//   rig policy effective  → resolve effective for a read context
//   rig policy cite       → emit the citation line per convention §Component 5
//   rig policy unset <scope> [qualifier]
//                         → DELETE one binding (operator-only)
//   rig policy defaults   → recommended 6×7 + per-mode scope + stale rule
//
// HG-4 / HG-7 anchored here:
//   - `set` never silently applies. Without `--confirm` it echoes the
//     proposed binding (mode + scope + key settings) and exits with
//     `exit 2` so scripts cannot accidentally apply. `--confirm` is the
//     explicit operator action.
//   - Mode invocation: bare word OR `mode:<mode>` prefix; both normalize
//     via disambiguateModeInvocation().
//   - Citation format: short-prose per convention §Component 5 +
//     §Citation Rules.

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface RigPolicyDeps extends StatusDeps {}

// Mirror of daemon enums + structure. We keep these inline so the CLI
// doesn't grow a build-time dep on the daemon package; the validator
// at the daemon edge is the source of truth, and the CLI sends the
// record through unchanged.
const MODES = ["sleep", "desk", "mobile", "away", "focus", "debug"] as const;
type Mode = (typeof MODES)[number];

const SCOPES = ["global_host", "rig", "workstream", "qitem"] as const;
type Scope = (typeof SCOPES)[number];

// Convention §Component 4 — bare-word disambiguation. A bare reserved
// mode word, or `mode:<word>`, becomes an invocation; embedded-in-
// sentence does not (the latter is a CLI input error here since the
// CLI takes a single-positional <mode> argument).
function disambiguateModeInvocation(raw: string): Mode | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.startsWith("mode:") ? trimmed.slice("mode:".length).trim() : trimmed;
  if (stripped.split(/\s+/).length !== 1) return null;
  return (MODES as readonly string[]).includes(stripped) ? (stripped as Mode) : null;
}

interface RecommendedDefaultsResponse {
  recommendedModeDefaults: Record<Mode, {
    autonomy_scope: string;
    heartbeat_cadence: string;
    inspection_depth: string;
    update_detail: string;
    escalation_threshold: string;
    concurrency_limit: string;
    permission_prompt_posture: string;
  }>;
  recommendedDefaultScope: Record<Mode, Scope>;
  defaultStaleRule: string;
}

interface BindingResponse {
  binding: {
    id: string;
    mode: Mode;
    record: Record<string, string>;
    qualifier: string | null;
    setAt: string;
    setBy: string;
  };
}

interface ListResponse {
  bindings: Array<BindingResponse["binding"]>;
}

interface EffectiveResponse {
  effective: { binding: BindingResponse["binding"]; resolvedScope: Scope } | null;
  posture: "known" | "unknown_posture";
  hint?: string;
}

async function withClient<T>(
  deps: RigPolicyDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) {
    console.error("Daemon not running. Start it with: rig daemon start");
    process.exitCode = 1;
    return undefined;
  }
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

function emitRecord(label: string, record: Record<string, string>): void {
  console.log(label);
  for (const [k, v] of Object.entries(record)) {
    console.log(`  ${k}: ${v}`);
  }
}

/**
 * Mirror of the daemon route's parseScopeAndQualifier semantics on the
 * CLI side. The CLI is the operator's authoring surface; the convention's
 * scope rule applies at invocation, NOT only at raw HTTP URL parsing.
 *
 * Reject:
 *   - explicit qualifier with global_host (BLOCKING re-verify finding from
 *     guard qitem-20260518044650): operators who type
 *     `--scope global_host --qualifier <id>` get an error and the daemon
 *     is never contacted. The CLI does NOT silently drop the qualifier.
 *   - missing qualifier for any non-global scope.
 */
type NormalizedScope = { ok: true; qualifier: string | null } | { ok: false; message: string };
function normalizeScopeQualifier(scope: Scope, explicitQualifier: string | undefined): NormalizedScope {
  if (scope === "global_host") {
    if (explicitQualifier !== undefined && explicitQualifier !== "") {
      return {
        ok: false,
        message: `Global-host bindings cannot carry a qualifier (got "${explicitQualifier}"). Either drop --qualifier OR change --scope to rig / workstream / qitem.`,
      };
    }
    return { ok: true, qualifier: null };
  }
  if (explicitQualifier === undefined || explicitQualifier === "") {
    return {
      ok: false,
      message: `Scope ${scope} requires a qualifier (rigId / workstreamId / qitemId). Pass --qualifier <id>.`,
    };
  }
  return { ok: true, qualifier: explicitQualifier };
}

function formatCitation(b: BindingResponse["binding"]): string {
  const qualifierPart = b.qualifier ? `:${b.qualifier}` : "";
  const scope = b.record.scope as Scope;
  return `Operating in \`${b.mode}\` mode at \`${scope}${qualifierPart}\` per operator (set_at ${b.setAt})`;
}

export function rigPolicyCommand(depsOverride?: RigPolicyDeps): Command {
  const cmd = new Command("policy").description(
    "Slice 09 — operator-context-mode bindings (sleep/desk/mobile/away/focus/debug × global_host/rig/workstream/qitem).",
  );

  const getDeps = (): RigPolicyDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  // -- set ---------------------------------------------------------------
  cmd
    .command("set <mode>")
    .description(
      "Propose a mode binding. Without --confirm, restates the proposed binding and exits 2 (no daemon write). With --confirm, sets it.",
    )
    .option("--scope <scope>", `Scope: ${SCOPES.join(" | ")} (default: per-mode recommendation)`)
    .option("--qualifier <id>", "Required for rig / workstream / qitem scopes; omit for global_host")
    .option("--autonomy-scope <v>")
    .option("--heartbeat-cadence <v>")
    .option("--inspection-depth <v>")
    .option("--update-detail <v>")
    .option("--escalation-threshold <v>")
    .option("--concurrency-limit <v>")
    .option("--permission-prompt-posture <v>", "One of: normal | batch_for_human | do_not_prompt_unless_blocked (auto_accept is FORBIDDEN by convention).")
    .option("--expiry-or-stale-rule <v>")
    .option("--evidence <citation>", "Free-text citation (operator message id, file pointer, chatroom topic, etc.).")
    .option("--confirm", "Confirm the proposed binding and apply it. Without this flag, set is restate-only.")
    .option("--bearer <token>", "Operator bearer token (or set OPENRIG_AUTH_BEARER_TOKEN env).")
    .option("--json", "JSON output for agents")
    .action(async (
      modeArg: string,
      opts: {
        scope?: string;
        qualifier?: string;
        autonomyScope?: string;
        heartbeatCadence?: string;
        inspectionDepth?: string;
        updateDetail?: string;
        escalationThreshold?: string;
        concurrencyLimit?: string;
        permissionPromptPosture?: string;
        expiryOrStaleRule?: string;
        evidence?: string;
        confirm?: boolean;
        bearer?: string;
        json?: boolean;
      },
    ) => {
      const mode = disambiguateModeInvocation(modeArg);
      if (!mode) {
        console.error(`Unknown mode '${modeArg}'. Allowed: ${MODES.join(", ")} (or 'mode:<name>' prefix).`);
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const defaultsRes = await client.get<RecommendedDefaultsResponse>("/api/rig-policy/defaults");
        if (defaultsRes.status >= 400) {
          console.error(JSON.stringify(defaultsRes.data, null, 2));
          process.exitCode = 1;
          return;
        }
        const defaults = defaultsRes.data;
        const scope = (opts.scope as Scope | undefined) ?? defaults.recommendedDefaultScope[mode];
        if (!(SCOPES as readonly string[]).includes(scope)) {
          console.error(`Unknown scope '${scope}'. Allowed: ${SCOPES.join(", ")}.`);
          process.exitCode = 1;
          return;
        }
        // BLOCKING re-verify (qitem-20260518044650): never silently drop
        // an explicit operator-supplied qualifier on global_host. Reject
        // BEFORE the proposed-binding restate so the operator sees the
        // input error rather than a misleading proposed binding.
        const normalized = normalizeScopeQualifier(scope, opts.qualifier);
        if (!normalized.ok) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: "qualifier_invalid", hint: normalized.message }, null, 2));
          } else {
            console.error(normalized.message);
          }
          process.exitCode = 1;
          return;
        }
        const qualifier = normalized.qualifier;
        const perMode = defaults.recommendedModeDefaults[mode];
        // Component 3 — exactly the 10 settings fields. `mode` is the
        // binding's identity (Component 2) and lives at the top level
        // of the PUT body, NOT inside the record.
        const record = {
          autonomy_scope: opts.autonomyScope ?? perMode.autonomy_scope,
          heartbeat_cadence: opts.heartbeatCadence ?? perMode.heartbeat_cadence,
          inspection_depth: opts.inspectionDepth ?? perMode.inspection_depth,
          update_detail: opts.updateDetail ?? perMode.update_detail,
          escalation_threshold: opts.escalationThreshold ?? perMode.escalation_threshold,
          concurrency_limit: opts.concurrencyLimit ?? perMode.concurrency_limit,
          permission_prompt_posture: opts.permissionPromptPosture ?? perMode.permission_prompt_posture,
          scope,
          expiry_or_stale_rule: opts.expiryOrStaleRule ?? defaults.defaultStaleRule,
          evidence_citation: opts.evidence ?? `operator confirmed ${mode}`,
        };

        if (!opts.confirm) {
          // Restate-and-confirm (HG-7). No daemon write.
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, proposed: { mode, scope, qualifier, record }, confirm_required: true }, null, 2));
          } else {
            console.log(`Proposed binding (restate-and-confirm — NOT applied):`);
            console.log(`  mode:      ${mode}`);
            console.log(`  scope:     ${scope}${qualifier ? ` (${qualifier})` : ""}`);
            emitRecord(`  record:`, record);
            console.log(`\nRe-run with --confirm to apply.`);
          }
          process.exitCode = 2;
          return;
        }

        const headers: Record<string, string> = {};
        const bearer = opts.bearer ?? process.env.OPENRIG_AUTH_BEARER_TOKEN;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const qualifierPath = qualifier ? `/${encodeURIComponent(qualifier)}` : "";
        const res = await client.put<BindingResponse | { error: string; errors?: string[] }>(
          `/api/rig-policy/bindings/${scope}${qualifierPath}`,
          { mode, record },
          { headers },
        );
        if (res.status === 401) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: "unauthorized", hint: "Daemon requires operator bearer. Pass --bearer <token> or set OPENRIG_AUTH_BEARER_TOKEN." }, null, 2));
          } else {
            console.error("Unauthorized. Daemon requires an operator bearer token.");
            console.error("Pass --bearer <token> or export OPENRIG_AUTH_BEARER_TOKEN before re-running.");
          }
          process.exitCode = 1;
          return;
        }
        if (res.status >= 400) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, ...(res.data as object) }, null, 2));
          } else {
            console.error(`Error setting binding (HTTP ${res.status}):`);
            console.error(JSON.stringify(res.data, null, 2));
          }
          process.exitCode = 1;
          return;
        }
        const body = res.data as BindingResponse;
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, binding: body.binding }, null, 2));
        } else {
          console.log(`Set: ${body.binding.id}`);
          console.log(`  mode:    ${body.binding.mode}`);
          emitRecord(`  record:`, body.binding.record);
          console.log(`  set_by:  ${body.binding.setBy}`);
          console.log(`  set_at:  ${body.binding.setAt}`);
          console.log(`\n${formatCitation(body.binding)}`);
        }
      });
    });

  // -- show --------------------------------------------------------------
  cmd
    .command("show")
    .description("List all operator-context-mode bindings.")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<ListResponse>("/api/rig-policy/bindings");
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (res.data.bindings.length === 0) {
          console.log("No operator-context-mode bindings set.");
          return;
        }
        for (const b of res.data.bindings) {
          console.log(`${b.id}  [${b.mode}]  set_at=${b.setAt}`);
        }
      });
    });

  // -- effective ---------------------------------------------------------
  cmd
    .command("effective")
    .description("Resolve the effective mode for a (rig, workstream, qitem) read context. Q6 unknown_posture surfaced when no binding matches.")
    .option("--rig <id>")
    .option("--workstream <id>")
    .option("--qitem <id>")
    .option("--json", "JSON output for agents")
    .action(async (opts: { rig?: string; workstream?: string; qitem?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const qs = new URLSearchParams();
        if (opts.rig) qs.set("rig", opts.rig);
        if (opts.workstream) qs.set("workstream", opts.workstream);
        if (opts.qitem) qs.set("qitem", opts.qitem);
        const path = qs.toString() ? `/api/rig-policy/effective?${qs.toString()}` : "/api/rig-policy/effective";
        const res = await client.get<EffectiveResponse>(path);
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (res.data.posture === "unknown_posture" || !res.data.effective) {
          console.log("unknown_posture: no binding matches this read context.");
          if (res.data.hint) console.log(res.data.hint);
          return;
        }
        const b = res.data.effective.binding;
        console.log(`Effective: ${b.mode} (resolved scope: ${res.data.effective.resolvedScope})`);
        emitRecord(`  record:`, b.record);
        console.log(`  set_by:  ${b.setBy}`);
        console.log(`  set_at:  ${b.setAt}`);
      });
    });

  // -- cite --------------------------------------------------------------
  cmd
    .command("cite")
    .description("Emit a citation line for the effective mode at a read context. Per convention §Citation Rules.")
    .option("--rig <id>")
    .option("--workstream <id>")
    .option("--qitem <id>")
    .action(async (opts: { rig?: string; workstream?: string; qitem?: string }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const qs = new URLSearchParams();
        if (opts.rig) qs.set("rig", opts.rig);
        if (opts.workstream) qs.set("workstream", opts.workstream);
        if (opts.qitem) qs.set("qitem", opts.qitem);
        const path = qs.toString() ? `/api/rig-policy/effective?${qs.toString()}` : "/api/rig-policy/effective";
        const res = await client.get<EffectiveResponse>(path);
        if (res.status >= 400 || !res.data.effective) {
          console.log("Operating without an explicit operator-context-mode binding (unknown_posture).");
          return;
        }
        console.log(formatCitation(res.data.effective.binding));
      });
    });

  // -- unset -------------------------------------------------------------
  cmd
    .command("unset <scope> [qualifier]")
    .description("Delete one binding (operator-only). Scope: global_host | rig | workstream | qitem.")
    .option("--bearer <token>")
    .option("--json", "JSON output for agents")
    .action(async (
      scopeArg: string,
      qualifierArg: string | undefined,
      opts: { bearer?: string; json?: boolean },
    ) => {
      if (!(SCOPES as readonly string[]).includes(scopeArg)) {
        console.error(`Unknown scope '${scopeArg}'. Allowed: ${SCOPES.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      const scope = scopeArg as Scope;
      // BLOCKING re-verify (qitem-20260518044650): never silently drop
      // an explicit operator-supplied qualifier on global_host on unset.
      // Same hazard class as set; same shared helper.
      const normalized = normalizeScopeQualifier(scope, qualifierArg);
      if (!normalized.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: "qualifier_invalid", hint: normalized.message }, null, 2));
        } else {
          console.error(normalized.message);
        }
        process.exitCode = 1;
        return;
      }
      const qualifier = normalized.qualifier;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const qualifierPath = qualifier ? `/${encodeURIComponent(qualifier)}` : "";
        const headers: Record<string, string> = {};
        const bearer = opts.bearer ?? process.env.OPENRIG_AUTH_BEARER_TOKEN;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const res = await client.delete<{ removed: boolean }>(`/api/rig-policy/bindings/${scope}${qualifierPath}`, { headers });
        if (res.status >= 400) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, ...(res.data as object) }, null, 2));
          } else {
            console.error(JSON.stringify(res.data, null, 2));
          }
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, removed: res.data.removed }, null, 2));
        } else {
          console.log(res.data.removed ? `Removed ${scope}${qualifier ? `:${qualifier}` : ""}` : "Nothing to remove.");
        }
      });
    });

  // -- defaults ----------------------------------------------------------
  cmd
    .command("defaults")
    .description("Print the recommended per-mode 6×7 + default-scope + stale rule.")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<RecommendedDefaultsResponse>("/api/rig-policy/defaults");
        if (res.status >= 400) {
          console.error(JSON.stringify(res.data, null, 2));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        for (const mode of MODES) {
          console.log(`${mode}  (default scope: ${res.data.recommendedDefaultScope[mode]})`);
          emitRecord("  ", res.data.recommendedModeDefaults[mode] as unknown as Record<string, string>);
        }
        console.log(`\ndefault stale rule: ${res.data.defaultStaleRule}`);
      });
    });

  return cmd;
}

// Re-export for unit-testability of pure helpers.
export const __test__ = { disambiguateModeInvocation, formatCitation, normalizeScopeQualifier };
