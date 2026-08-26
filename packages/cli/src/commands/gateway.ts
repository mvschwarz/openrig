import { Command } from "commander";
// The human registry is home-state owned by the daemon; the verb LAZY-imports the narrow
// @openrig/daemon/gateway-human-registry surface at invocation (the C3/crash-cart dep rail —
// one source, no twin). Type-only import keeps the surface off the eager cli graph.
import type { addHumanFragment as AddHumanFragment } from "@openrig/daemon/gateway-human-registry";

// `rig gateway human add` — the verb-add-only surface for the human registry (M1 A3).
// Operators NEVER hand-create the fragment YAML; the verb owns it (validate -> atomic
// write -> re-project). address is DERIVED as <entityId>@external (the registered
// convention, pinned by the schema); no-clobber unless --replace is passed explicitly.

// The --binding spec parse (kind:connectorRef:secretsRef:role[:handle=<id>], ':'-bearing
// vault-pointer secretsRef, optional handle= token) lives in the registry surface as
// parseBindingSpec — ONE source for add (here) and `set binding.<n>` (S12), lazy-imported
// with the rest of the surface so the eager CLI graph stays daemon-free.

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

/** Default queue-row half of the remove guard: non-terminal rows addressed to the human,
 *  via the daemon. ok:false carries the reason the board COULD NOT BE CHECKED. */
async function daemonQueueRows(address: string): ReturnType<HumanRowsLookup> {
  try {
    const { DaemonClient } = await import("../client.js");
    const client = new DaemonClient();
    const res = await client.get<Array<{ qitemId?: string; state?: string; summary?: string | null }>>(
      `/api/queue/list?destinationSession=${encodeURIComponent(address)}&state=pending,in-progress,blocked&limit=500&compact=1`,
    );
    const rows = (Array.isArray(res.data) ? res.data : []).map((r) => ({
      id: String(r.qitemId ?? "(unknown-id)"),
      state: String(r.state ?? "(unknown-state)"),
      ...(r.summary ? { summary: String(r.summary) } : {}),
    }));
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function gatewayCommand(deps: GatewayCommandDeps = {}): Command {
  const queueRows: HumanRowsLookup = deps.queueRows ?? daemonQueueRows;
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
      // LAZY import the narrow daemon surface at invocation (dep rail 2).
      const { addHumanFragment, parseBindingSpec } = (await import("@openrig/daemon/gateway-human-registry")) as {
        addHumanFragment: typeof AddHumanFragment;
        parseBindingSpec: (spec: string) => { ok: true; binding: Record<string, unknown> } | { ok: false; error: string };
      };
      const bindings: Record<string, unknown>[] = [];
      for (const spec of opts.binding) {
        const b = parseBindingSpec(spec);
        if (!b.ok) { console.error(`--binding: ${b.error}`); process.exitCode = 1; return; }
        bindings.push(b.binding);
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

  // ── S12 (OPR.0.5.5.12): the fragment lifecycle beyond add. Every verb operates through
  // fragments + regeneration (the registry surface); none writes the generated projection.

  human
    .command("list")
    .description("Show the configured human (single-human surface per A1/R5; several fragments render honestly with a 0.5.7 advisory)")
    .option("--json", "Complete record(s) as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { listHumans } = await import("@openrig/daemon/gateway-human-registry");
      const res = listHumans();
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      if (opts.json) { console.log(JSON.stringify({ ok: true, humans: res.humans, ...(res.advisory ? { advisory: res.advisory } : {}) })); return; }
      if (res.humans.length === 0) { console.log("no human configured yet — register one: rig gateway human add <entityId> --display-name … --binding … --delivery-class …"); return; }
      for (const h of res.humans) {
        const inbound = h.bindings.inboundResolvable ? "" : "  [outbound-only]";
        console.log(`${h.entityId}  "${h.displayName}"  class=${h.deliveryClass}  ${h.away ? "away" : "available"}  bindings=${h.bindings.count} (primary ${h.bindings.primary.kind}:${h.bindings.primary.connectorRef})${inbound}`);
      }
      if (res.advisory) console.log(`advisory: ${res.advisory}`);
    });

  human
    .command("show <entityId>")
    .description("Show the effective record: fragment values + which defaults filled the rest, with provenance")
    .option("--json", "Complete record as JSON")
    .action(async (entityId: string, opts: { json?: boolean }) => {
      const { showHuman } = await import("@openrig/daemon/gateway-human-registry");
      const res = showHuman(entityId);
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      if (opts.json) { console.log(JSON.stringify({ ok: true, record: res.record })); return; }
      const r = res.record;
      console.log(`${r.entityId} (${r.address}) — "${r.displayName}"`);
      console.log(`  fragment: ${r.fragmentPath}`);
      console.log(`  delivery-class: ${r.prefs.deliveryClass.value} (${r.prefs.deliveryClass.source})`);
      console.log(`  away: ${r.prefs.away.value} (${r.prefs.away.source})`);
      r.connectorBindings.forEach((b, i) => {
        console.log(`  binding.${i}: ${b.kind}:${b.connectorRef} role=${b.role}${b.handle ? ` handle=${b.handle}` : " [outbound-only]"}`);
      });
    });

  human
    .command("set <entityId> <field> <value>")
    .description("Edit one field through the verb (same validation as add; re-projection immediate). Fields: display-name, delivery-class, away, binding.<n>")
    .action(async (entityId: string, field: string, value: string) => {
      const { setHumanField } = await import("@openrig/daemon/gateway-human-registry");
      const res = setHumanField(entityId, field, value);
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, entityId: res.fragment.entityId, field, path: res.path }));
    });

  human
    .command("remove <entityId>")
    .description("Remove a human: refuses while open conversations or non-terminal rows exist (--force archives and records what was orphaned; the fragment is archived, never deleted)")
    .option("--force", "Archive despite KNOWN in-flight items (each is recorded as orphaned)")
    .action(async (entityId: string, opts: { force?: boolean }) => {
      const { removeHumanFragment, pendingConversationsFor, ADDRESS_DOMAIN } =
        await import("@openrig/daemon/gateway-human-registry");
      const address = `${entityId}@${ADDRESS_DOMAIN}`;
      // Guard input 1 (fs): un-Acked outbound decisions = open conversations.
      const conversations = pendingConversationsFor(entityId);
      // Guard input 2 (daemon): non-terminal rows addressed to the human. An unreachable
      // board is INDETERMINATE — remove refuses rather than fabricating an absence, and
      // --force does not apply (it overrides KNOWN in-flight work, not ignorance of it).
      const rowsRes = await queueRows(address);
      if (!rowsRes.ok) {
        console.error(
          `refused: the queue could not be checked for non-terminal rows addressed to ${address} (${rowsRes.error}) — ` +
          `remove needs a reachable daemon to prove nothing would be orphaned; --force does not override an unchecked board.`,
        );
        process.exitCode = 1;
        return;
      }
      const inflight = [
        ...conversations,
        ...rowsRes.rows.map((r) => ({
          kind: "queue-row" as const,
          id: r.id,
          detail: `${r.state} row ${r.id}${r.summary ? ` — ${r.summary}` : ""}`,
        })),
      ];
      const res = removeHumanFragment(entityId, { force: !!opts.force, inflight });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, removed: res.removed, archivedPath: res.archivedPath, ...(res.orphanRecordPath ? { orphanRecordPath: res.orphanRecordPath } : {}) }));
    });

  return cmd;
}
