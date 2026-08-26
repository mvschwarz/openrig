import { Command } from "commander";
// The human registry is home-state owned by the daemon; the verb LAZY-imports the narrow
// @openrig/daemon/gateway-human-registry surface at invocation (the C3/crash-cart dep rail —
// one source, no twin). Type-only import keeps the surface off the eager cli graph.
import type { addHumanFragment as AddHumanFragment } from "@openrig/daemon/gateway-human-registry";

// `rig gateway human add` — the verb-add-only surface for the human registry (M1 A3).
// Operators NEVER hand-create the fragment YAML; the verb owns it (validate -> atomic
// write -> re-project). address is DERIVED as <entityId>@external (the registered
// convention, pinned by the schema); no-clobber unless --replace is passed explicitly.

interface BindingSpec {
  kind: string;
  connectorRef: string;
  secretsRef: string;
  role: string;
  handle?: string;
}

/** --binding kind:connectorRef:secretsRef:role[:handle=<id>]. secretsRef is a vault POINTER and
 *  may itself contain ':' (e.g. "vault://slack/mike"), so kind/connectorRef are the first two
 *  fields, role is the LAST positional, and secretsRef is everything between (colons intact).
 *  A6 v3: an OPTIONAL `handle=<id>` token (the human's platform id, e.g. Slack user id) may appear
 *  anywhere; it is extracted first so it never disturbs the positional parse. A handle-less binding
 *  is outbound-only (not inbound-resolvable). */
function parseBinding(spec: string): BindingSpec | { error: string } {
  const all = spec.split(":");
  const handleTokens = all.filter((p) => p.startsWith("handle="));
  if (handleTokens.length > 1) {
    return { error: `--binding must carry at most one handle= token (got "${spec}")` };
  }
  const handle = handleTokens.length === 1 ? handleTokens[0]!.slice("handle=".length) : undefined;
  if (handle !== undefined && handle.length === 0) {
    return { error: `--binding handle= must be non-empty (got "${spec}")` };
  }
  const parts = all.filter((p) => !p.startsWith("handle="));
  if (parts.length < 4) {
    return { error: `--binding must be kind:connectorRef:secretsRef:role[:handle=<id>] (got "${spec}")` };
  }
  const kind = parts[0]!;
  const connectorRef = parts[1]!;
  const role = parts[parts.length - 1]!;
  const secretsRef = parts.slice(2, -1).join(":");
  if (!kind || !connectorRef || !secretsRef || !role) {
    return { error: `--binding fields must be non-empty: kind:connectorRef:secretsRef:role[:handle=<id>] (got "${spec}")` };
  }
  return handle !== undefined ? { kind, connectorRef, secretsRef, role, handle } : { kind, connectorRef, secretsRef, role };
}

// ── S12 (OPR.0.5.5.12): the queue-row half of the remove guard, injectable so verb tests
// never need a live daemon. ok:false = the source COULD NOT BE CHECKED (unreachable daemon)
// — an indeterminate, never evidence of an empty board.
export interface HumanRowRef {
  id: string;
  state: string;
  summary?: string;
}
export type HumanRowsLookup = (address: string) => Promise<
  | { ok: true; rows: HumanRowRef[] }
  | { ok: false; error: string }
>;

export interface GatewayCommandDeps {
  queueRows?: HumanRowsLookup;
}

export function gatewayCommand(deps: GatewayCommandDeps = {}): Command {
  void deps; // S12 RED: lifecycle verbs unwired; deps consumed by the GREEN implementation.
  const cmd = new Command("gateway").description("Gateway: the human registry + connector surfaces");
  const human = cmd.command("human").description("Manage human specs (file-per-human fragments under gateway/humans/)");

  human
    .command("add <entityId>")
    .description("Add a human fragment (verb-add-only; the fragment is truth, the registry is a GENERATED projection)")
    .requiredOption("--display-name <name>", "Human-readable display name")
    .requiredOption(
      "--binding <kind:connectorRef:secretsRef:role[:handle=<id>]>",
      "Connector binding (repeatable); role primary|secondary, EXACTLY ONE primary. Optional handle=<platform id> makes the binding inbound-resolvable (unique per kind); omit it for outbound-only.",
      (v: string, acc: string[] = []) => { acc.push(v); return acc; },
    )
    .requiredOption("--delivery-class <A|B|C|D>", "Notification loudness class (the notifications register selection)")
    .option("--away", "Set the AWAY preset")
    .option("--replace", "Explicitly replace an existing human (no silent overwrite)")
    .action(async (entityId: string, opts: { displayName: string; binding: string[]; deliveryClass: string; away?: boolean; replace?: boolean }) => {
      const bindings: BindingSpec[] = [];
      for (const spec of opts.binding) {
        const b = parseBinding(spec);
        if ("error" in b) { console.error(b.error); process.exitCode = 1; return; }
        bindings.push(b);
      }
      const fragment: Record<string, unknown> = {
        entityId,
        class: "human",
        displayName: opts.displayName,
        address: `${entityId}@external`,
        connectorBindings: bindings,
        prefs: { deliveryClass: opts.deliveryClass, ...(opts.away ? { away: true } : {}) },
      };
      // LAZY import the narrow daemon surface at invocation (dep rail 2).
      const { addHumanFragment } = (await import("@openrig/daemon/gateway-human-registry")) as { addHumanFragment: typeof AddHumanFragment };
      const res = addHumanFragment(fragment, undefined, { replace: !!opts.replace });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, entityId: res.fragment.entityId, path: res.path }));
    });

  return cmd;
}
