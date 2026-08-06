import { Command } from "commander";
import { addHumanFragment } from "../gateway/human-registry.js";

// `rig gateway human add` — the verb-add-only surface for the human registry (M1 A3).
// Operators NEVER hand-create the fragment YAML; the verb owns it (validate -> atomic
// write -> re-project). address is DERIVED as <entityId>@external (the registered
// convention, pinned by the schema); no-clobber unless --replace is passed explicitly.

interface BindingSpec {
  kind: string;
  connectorRef: string;
  secretsRef: string;
  role: string;
}

/** --binding kind:connectorRef:secretsRef:role. secretsRef is a vault POINTER and may
 *  itself contain ':' (e.g. "vault://slack/mike"), so kind/connectorRef are the first
 *  two fields, role is the LAST, and secretsRef is everything between (colons intact). */
function parseBinding(spec: string): BindingSpec | { error: string } {
  const parts = spec.split(":");
  if (parts.length < 4) {
    return { error: `--binding must be kind:connectorRef:secretsRef:role (got "${spec}")` };
  }
  const kind = parts[0]!;
  const connectorRef = parts[1]!;
  const role = parts[parts.length - 1]!;
  const secretsRef = parts.slice(2, -1).join(":");
  if (!kind || !connectorRef || !secretsRef || !role) {
    return { error: `--binding fields must be non-empty: kind:connectorRef:secretsRef:role (got "${spec}")` };
  }
  return { kind, connectorRef, secretsRef, role };
}

export function gatewayCommand(): Command {
  const cmd = new Command("gateway").description("Gateway: the human registry + connector surfaces");
  const human = cmd.command("human").description("Manage human specs (file-per-human fragments under gateway/humans/)");

  human
    .command("add <entityId>")
    .description("Add a human fragment (verb-add-only; the fragment is truth, the registry is a GENERATED projection)")
    .requiredOption("--display-name <name>", "Human-readable display name")
    .requiredOption(
      "--binding <kind:connectorRef:secretsRef:role>",
      "Connector binding (repeatable); role primary|secondary, EXACTLY ONE primary",
      (v: string, acc: string[] = []) => { acc.push(v); return acc; },
    )
    .requiredOption("--delivery-class <A|B|C|D>", "Notification loudness class (the notifications register selection)")
    .option("--away", "Set the AWAY preset")
    .option("--replace", "Explicitly replace an existing human (no silent overwrite)")
    .action((entityId: string, opts: { displayName: string; binding: string[]; deliveryClass: string; away?: boolean; replace?: boolean }) => {
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
      const res = addHumanFragment(fragment, undefined, { replace: !!opts.replace });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, entityId: res.fragment.entityId, path: res.path }));
    });

  return cmd;
}
