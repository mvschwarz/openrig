import { readFileSync } from "node:fs";
import { Command } from "commander";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
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
  humanReadiness?: HumanReadinessLookup;
  humanQuiet?: HumanQuietLookup;
}

/** A person's quiet hours as the daemon resolves them: the window (null when none) and whether it's on now. */
export interface HumanQuietView {
  window: null | { kind: "daily" | "until"; timezone: string; start?: string; end?: string; until?: string; source: string;
    revision: number; setBy: string; setAt: string; ended?: { occurrence: string; by: string; at: string } };
  state: { active: boolean; occurrence?: string; revision?: number; nextBoundary: null | { kind: "start" | "end"; at: string } };
}

export type HumanQuietLookup = (entityId: string) => Promise<{ ok: true; quiet: HumanQuietView } | { ok: false; reason: string }>;

export async function daemonHumanQuiet(entityId: string): ReturnType<HumanQuietLookup> {
  try {
    const { DaemonClient } = await import("../client.js");
    const response = await new DaemonClient().get<HumanQuietView & { ok?: boolean; error?: string; message?: string }>(
      `/api/gateway/human/${encodeURIComponent(entityId)}/quiet`);
    if (response.status !== 200 || response.data?.ok !== true || !response.data.state) {
      const detail = [response.data?.error, response.data?.message].filter((value) => typeof value === "string").join(": ");
      return { ok: false, reason: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true, quiet: { window: response.data.window ?? null, state: response.data.state } };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** One line for a person's quiet hours: the rule, where it came from, whether it's on, and the next boundary. */
export function describeQuiet(view: HumanQuietView): string {
  const w = view.window;
  if (!w) return "quiet: none set";
  const rule = w.kind === "daily" ? `every day ${w.start}-${w.end} ${w.timezone}` : `until ${w.until} (${w.timezone})`;
  const next = view.state.nextBoundary;
  const nextText = next ? `; ${next.kind === "end" ? "ends" : "next starts"} ${next.at}` : "";
  // Name the occurrence that was ended, from the stored record: a daily one by its start date (it stays recorded until the
  // next revision, so it may not be tonight's); an until-time window has just the one.
  const endedWhich = w.ended?.occurrence === "until" ? "ended" : `the ${w.ended?.occurrence} occurrence ended`;
  const ended = w.ended && !view.state.active ? `; ${endedWhich} early by ${w.ended.by}` : "";
  return `quiet: ${view.state.active ? "on" : "off"} (${rule}; set by ${w.setBy}, ${w.source}, revision ${w.revision}${nextText}${ended})`;
}

export interface HumanReadinessView {
  state: "ready" | "not-ready" | "indeterminate";
  configured: boolean | null;
  enabled: boolean | null;
  active: boolean | null;
  ready: boolean;
  connector?: { kind: string; ref: string };
  reason: string;
  nextAction: string | null;
  checkedAt?: string;
}

export type HumanReadinessLookup = (entityId: string) => Promise<HumanReadinessView>;

export async function daemonHumanReadiness(entityId: string): Promise<HumanReadinessView> {
  try {
    const { DaemonClient } = await import("../client.js");
    const response = await new DaemonClient().get<{ ok?: boolean; readiness?: HumanReadinessView; error?: unknown; message?: unknown }>(
      `/api/gateway/human/${encodeURIComponent(entityId)}/readiness`,
    );
    if (response.status !== 200) {
      const detail = [response.data?.error, response.data?.message].filter((value) => typeof value === "string").join(": ");
      throw new Error(`HTTP ${response.status}: ${detail || "readiness request refused"}`);
    }
    const readiness = response.data?.readiness;
    if (response.data?.ok !== true || !readiness
      || !["ready", "not-ready", "indeterminate"].includes(readiness.state)
      || [readiness.configured, readiness.enabled, readiness.active].some((value) => value !== null && typeof value !== "boolean")
      || readiness.ready !== (readiness.state === "ready")
      || typeof readiness.reason !== "string" || !readiness.reason.trim()
      || (readiness.nextAction !== null && typeof readiness.nextAction !== "string")
      || (readiness.connector !== undefined && (!readiness.connector || typeof readiness.connector.kind !== "string" || typeof readiness.connector.ref !== "string"))
      || (readiness.checkedAt !== undefined && typeof readiness.checkedAt !== "string")) {
      throw new Error("HTTP 200: malformed delivery readiness response");
    }
    return readiness;
  } catch (error) {
    return {
      state: "indeterminate",
      configured: null,
      enabled: null,
      active: null,
      ready: false,
      reason: `delivery readiness could not be read from the daemon: ${(error as Error).message}`,
      nextAction: "rig status",
    };
  }
}

/** Default queue-row half of the remove guard: non-terminal rows addressed to the human,
 *  via the daemon. ok:false carries the reason the board COULD NOT BE CHECKED. */
export async function daemonQueueRows(address: string): ReturnType<HumanRowsLookup> {
  try {
    const { DaemonClient } = await import("../client.js");
    const client = new DaemonClient();
    // Fix-r1 F2 (R2 blocking): enumerate to EXHAUSTION. A bounded read that comes back
    // FULL is truncation-suspect — completeness is proven only by a window strictly larger
    // than the result. Grow the window until that holds; a board that outgrows every
    // window is an honest completeness refusal, never a silently-shortened orphan list.
    let limit = 1000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await client.get<Array<{ qitemId?: string; state?: string; summary?: string | null }>>(
        `/api/queue/list?destinationSession=${encodeURIComponent(address)}&state=pending,in-progress,blocked&limit=${limit}&compact=1`,
      );
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}: queue enumeration refused`);
      }
      if (!Array.isArray(res.data)) {
        throw new Error("HTTP 200: malformed queue enumeration response");
      }
      const data = res.data;
      if (data.length < limit) {
        return {
          ok: true,
          rows: data.map((r) => ({
            id: String(r.qitemId ?? "(unknown-id)"),
            state: String(r.state ?? "(unknown-state)"),
            ...(r.summary ? { summary: String(r.summary) } : {}),
          })),
        };
      }
      limit *= 4;
    }
    return { ok: false, error: `queue enumeration for ${address} saturated every window up to ${limit / 4} rows — completeness unproven` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function gatewayCommand(deps: GatewayCommandDeps = {}): Command {
  const queueRows: HumanRowsLookup = deps.queueRows ?? daemonQueueRows;
  const humanReadiness: HumanReadinessLookup = deps.humanReadiness ?? daemonHumanReadiness;
  const humanQuiet: HumanQuietLookup = deps.humanQuiet ?? daemonHumanQuiet;
  const cmd = new Command("gateway").description("Gateway: the human registry + connector surfaces");
  const human = cmd.command("human").description("Manage human specs (file-per-human fragments under gateway/humans/)");

  human
    .command("add <entityId>")
    .description("Add a human fragment (verb-add-only; the fragment is truth, the registry is a GENERATED projection)")
    .requiredOption("--display-name <name>", "Human-readable display name")
    .requiredOption(
      "--binding <kind:connectorRef:secretsRef:role[:handle=<id>]>",
      "Connector binding (repeatable); role primary|secondary, EXACTLY ONE primary. connectorRef and secretsRef are config/vault labels (e.g. for Slack: slack:openrig-personal:file:<env-path>:primary:handle=<id>; tokens come from 'rig slack setup --secrets-env-file', never inline). Optional handle=<platform id> makes the binding inbound-resolvable (unique per kind); omit it for outbound-only.",
      (v: string, acc: string[] = []) => { acc.push(v); return acc; },
    )
    .requiredOption("--delivery-class <A|B|C|D>", "Notification loudness class (the notifications register selection)")
    .option("--away", "Set the AWAY preset")
    .option("--replace", "Explicitly replace an existing human (no silent overwrite)")
    .option("--reason <reason>", "Reason recorded with connector binding changes", "register human delivery")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--organization <id>", "The person's organization (create it first with rig gateway org set)")
    .option("--group <id>", "A group the person belongs to (repeatable; create it first with rig gateway group set)", (v: string, acc: string[] = []) => { acc.push(v); return acc; })
    .option("--policy <text>", "Readable policy for agents working with this person (text, not enforced)")
    .option("--policy-file <path>", "Read the policy text from a file")
    .option("--default", "Make this person the default: the one escalations, the notice digest and other unaddressed needs go to")
    .action(async (entityId: string, opts: { displayName: string; binding: string[]; deliveryClass: string; away?: boolean; replace?: boolean; reason: string; actor?: string; organization?: string; group?: string[]; policy?: string; policyFile?: string; default?: boolean }) => {
      // LAZY import the narrow daemon surface at invocation (dep rail 2).
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const { addHumanFragment, parseBindingSpec } = registry as unknown as {
        addHumanFragment: typeof AddHumanFragment;
        parseBindingSpec: (spec: string) => { ok: true; binding: Record<string, unknown> } | { ok: false; error: string };
      };
      // Several people may be registered. Their organization, groups, policy and the default go in the participant side
      // file, never the fragment, so an older daemon still loads every person after a rollback.
      const policy = readPolicyOption(opts);
      if (!policy.ok) { console.error(`refused: ${policy.error}`); process.exitCode = 1; return; }
      const placed = opts.organization !== undefined || opts.group !== undefined || policy.value !== undefined;
      if (placed) {
        // Check the organization and groups exist before writing anything, so a typo doesn't leave a half-placed person.
        const side = registry.readParticipantsFile();
        if (!side.ok) { console.error(`refused: ${side.error}`); process.exitCode = 1; return; }
        if (opts.organization && !side.file.organizations[opts.organization]) { console.error(`refused: no organization "${opts.organization}" — create it with rig gateway org set ${opts.organization} --name …`); process.exitCode = 1; return; }
        const unknownGroup = (opts.group ?? []).find((group) => !side.file.groups[group]);
        if (unknownGroup) { console.error(`refused: no group "${unknownGroup}" — create it with rig gateway group set ${unknownGroup} --organization … --name …`); process.exitCode = 1; return; }
      }
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
      const before = registry.showHuman(entityId);
      try {
        const result = await registry.runChannelOperation({
          actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1", reason: opts.reason,
          action: "binding", subject: `${entityId}@external`,
          before: { digest: registry.channelStateDigest(before.ok ? before.record.connectorBindings.map(({ inboundResolvable: _derived, ...binding }) => binding) : null) },
          run: async () => {
            const res = addHumanFragment(fragment, undefined, { replace: !!opts.replace });
            if (!res.ok) throw new Error(res.error);
            const digest = registry.channelStateDigest(res.fragment.connectorBindings);
            return { value: res, after: { digest }, effect: before.ok && registry.channelStateDigest(before.record.connectorBindings.map(({ inboundResolvable: _derived, ...binding }) => binding)) === digest ? "no-op" : "applied" };
          },
        });
        // The person is registered; their placement and the default are a second, separate write.
        const followUps: Record<string, unknown> = {};
        if (placed) {
          const res = registry.setPersonPlacement(entityId, { organization: opts.organization, groups: opts.group, policy: policy.value });
          followUps.placement = res.ok ? { path: res.path } : { error: res.error };
        }
        if (opts.default) {
          const res = registry.setDefaultPerson(entityId);
          followUps.default = res.ok ? { path: res.path } : { error: res.error };
        }
        const failed = Object.values(followUps).some((value) => "error" in (value as object));
        console.log(JSON.stringify({ ok: !failed, entityId, path: result.value.path, receipt: result.receipt, ...followUps }));
        if (failed) { console.error(`the person was registered, but part of their placement wasn't saved; fix it with rig gateway human set ${entityId} … or rig gateway default ${entityId}`); process.exitCode = 1; }
      } catch (error) { console.error(`refused: ${(error as Error).message}`); process.exitCode = 1; }
    })
    .addHelpText("after", `
Binding specification details:
  Format: <kind:connectorRef:secretsRef:role[:handle=<id>]>
  - kind: Connector kind (e.g. "slack")
  - connectorRef: Configuration label identifying the connector instance (e.g. "openrig-personal" or "main")
  - secretsRef: Pointer or label identifying where secrets are resolved (e.g. "file:/path/to/slack.env" or "vault://slack/user").
    NOTE: Never pass credentials or tokens inline here; credentials (like SLACK_BOT_TOKEN) are loaded from the connector's secrets env file (configured via 'rig slack setup --secrets-env-file').
  - role: "primary" (exactly one binding must be primary) or "secondary"
  - handle: Optional platform user identifier (e.g. "handle=U12345678") for inbound routing

Example:
  rig gateway human add alice --display-name "Alice" \\
    --binding "slack:openrig-personal:file:/etc/openrig/slack.env:primary:handle=U12345678" \\
    --delivery-class B`);

  // ── S12 (OPR.0.5.5.12): the fragment lifecycle beyond add. Every verb operates through
  // fragments + regeneration (the registry surface); none writes the generated projection.

  human
    .command("list")
    .description("List the registered people, with delivery readiness and quiet hours (rig gateway participants adds organizations, groups, policy and shared channels)")
    .option("--json", "Complete record(s) as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { listHumans } = await import("@openrig/daemon/gateway-human-registry");
      const res = listHumans();
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      const humans = await Promise.all(res.humans.map(async (record) => {
        const quiet = await humanQuiet(record.entityId);
        return { ...record, deliveryReadiness: await humanReadiness(record.entityId),
          quiet: quiet.ok ? quiet.quiet : { unknown: `quiet hours could not be read from the daemon: ${quiet.reason}` } };
      }));
      if (opts.json) { console.log(JSON.stringify({ ok: true, humans })); return; }
      if (res.humans.length === 0) { console.log("no human configured yet — register one: rig gateway human add <entityId> --display-name … --binding … --delivery-class …"); return; }
      for (const h of humans) {
        const inbound = h.bindings.inboundResolvable ? "" : "  [outbound-only]";
        console.log(`${h.entityId}  "${h.displayName}"  class=${h.deliveryClass}  ${h.availability}  bindings=${h.bindings.count} (primary ${h.bindings.primary.kind}:${h.bindings.primary.connectorRef})  delivery=${h.deliveryReadiness.state}${inbound}`);
        if (!h.deliveryReadiness.ready) console.log(`  delivery: ${h.deliveryReadiness.reason}${h.deliveryReadiness.nextAction ? `; next: ${h.deliveryReadiness.nextAction}` : ""}`);
        console.log(`  ${"unknown" in h.quiet ? `quiet: unknown (${h.quiet.unknown})` : describeQuiet(h.quiet)}`);
      }
    });

  const quiet = human.command("quiet").description("Quiet hours: while on, routine asks to this person are held, not posted; urgent ones (tagged escalation) still reach them. Held asks post once, each on its own, when quiet ends");
  const quietCall = async (method: "get" | "put" | "post", entityId: string, suffix: string, body: Record<string, unknown> | undefined, json?: boolean) => {
    const { DaemonClient } = await import("../client.js");
    const client = new DaemonClient();
    const path = `/api/gateway/human/${encodeURIComponent(entityId)}/quiet${suffix}`;
    const res = method === "get" ? await client.get<Record<string, any>>(path)
      : method === "put" ? await client.put<Record<string, any>>(path, body) : await client.post<Record<string, any>>(path, body);
    if (json) { console.log(JSON.stringify(res.data)); if (res.status !== 200) process.exitCode = 1; return false; }
    if (res.status !== 200) {
      console.error(`refused: ${res.data?.message ?? res.data?.error ?? `HTTP ${res.status}`}`);
      process.exitCode = 1;
      return false;
    }
    console.log(`${entityId} ${describeQuiet({ window: res.data.window ?? null, state: res.data.state })}`);
    return true;
  };
  const actorBody = (opts: { actor?: string }) => ({ actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK });
  quiet
    .command("set <entityId>")
    .description("Set quiet hours: every day in a timezone (--daily 22:00-07:00), or from now until a time (--until 07:00 or an ISO time)")
    .option("--daily <window>", "Every day, local HH:MM-HH:MM; may cross midnight")
    .option("--until <time>", "Until a time: HH:MM (its next occurrence in --tz) or an ISO time with an offset")
    .option("--tz <zone>", "IANA timezone, for example Europe/Berlin (default: this machine's zone)")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .addHelpText("after", `
Setting again replaces the window and starts a new revision; if the new window covers now, quiet stays on.
Times that don't exist or happen twice at a daylight-saving change: a skipped time means the next valid minute, a
repeated time its first occurrence.

Examples:
  rig gateway human quiet set alice --daily 22:00-07:00 --tz Europe/Berlin
  rig gateway human quiet set alice --until 09:00 --tz America/New_York`)
    .action(async (entityId: string, opts: { daily?: string; until?: string; tz?: string; actor?: string; json?: boolean }) => {
      const timezone = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const ok = await quietCall("put", entityId, "", { ...(opts.daily !== undefined ? { daily: opts.daily } : {}), ...(opts.until !== undefined ? { until: opts.until } : {}), timezone, ...actorBody(opts) }, opts.json);
      // This machine's zone may not be the person's (an agent on a server setting someone's hours).
      if (ok && opts.tz === undefined) console.log(`stored in ${timezone}; pass --tz for the person's own zone`);
    });
  quiet
    .command("end <entityId>")
    .description("\"I'm back\": end the quiet that is on now. A daily rule stays for tomorrow")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, opts: { actor?: string; json?: boolean }) => { await quietCall("post", entityId, "/end", actorBody(opts), opts.json); });
  quiet
    .command("clear <entityId>")
    .description("Remove the quiet-hours rule altogether")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, opts: { actor?: string; json?: boolean }) => { await quietCall("post", entityId, "/clear", actorBody(opts), opts.json); });
  quiet
    .command("show <entityId>")
    .description("Show the quiet-hours rule, whether it's on now, and the next boundary")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, opts: { json?: boolean }) => { await quietCall("get", entityId, "", undefined, opts.json); });

  // A person's own modes (asleep, away from desk, out of office, or a name of their own): saved bundles of availability,
  // decision room and delivery, and the record of applying one. Applying shows each effect's real state; ending undoes
  // only what is still the mode's own.
  const mode = human.command("mode").description("A person's modes: save one as they agreed it, apply it, see what's on, end it (\"I'm back\")");
  const daemonCall = async (method: "get" | "put" | "post", path: string, body: Record<string, unknown> | undefined,
    json: boolean | undefined, render: (data: Record<string, any>) => void) => {
    const { DaemonClient } = await import("../client.js");
    const client = new DaemonClient();
    const res = method === "get" ? await client.get<Record<string, any>>(path)
      : method === "put" ? await client.put<Record<string, any>>(path, body) : await client.post<Record<string, any>>(path, body);
    if (json) { console.log(JSON.stringify(res.data)); if (res.status !== 200) process.exitCode = 1; return; }
    if (res.status !== 200) { console.error(`refused: ${res.data?.message ?? res.data?.error ?? `HTTP ${res.status}`}`); process.exitCode = 1; return; }
    render(res.data);
  };
  const modeCall = (method: "get" | "put" | "post", entityId: string, suffix: string, body: Record<string, unknown> | undefined,
    json: boolean | undefined, render: (data: Record<string, any>) => void) =>
    daemonCall(method, `/api/gateway/human/${encodeURIComponent(entityId)}${suffix}`, body, json, render);
  const unresolvedLines = (data: Record<string, any>) => ((data.unresolved ?? []) as Array<Record<string, any>>)
    .map((u) => `  still ${u.effect.state} from ${u.modeName} (ended ${u.endedAt}): ${u.effect.consumer}${u.effect.detail ? ` (${u.effect.detail})` : ""}`);
  mode
    .command("save <entityId> <name>")
    .description("Save one of a person's modes as they agreed it. Saving again replaces it")
    .option("--availability <value>", "What their availability becomes while it's on: available | focus | away | off (omit to leave it unchanged)")
    .option("--expected-back <when>", "When they're expected back, in their words (for example 07:00, or Monday)")
    .option("--decision-room <words>", "What the team may decide for them meanwhile, in their own words. Omit for none: nothing is decided for them")
    .option("--exclude <item...>", "Exclusions read back from the decision room (for example publishing spending accounts)")
    .option("--quiet <rule>", "Quiet hours while it's on: a daily HH:MM-HH:MM, or until-end (until the mode's end time). Omit to leave quiet hours unchanged")
    .option("--tz <zone>", "IANA timezone for --quiet (default: this machine's zone)")
    .option("--account <where>", "Where the account goes when they're back")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, name: string, opts: { availability?: string; expectedBack?: string; decisionRoom?: string; exclude?: string[];
      quiet?: string; tz?: string; account?: string; actor?: string; json?: boolean }) => {
      await modeCall("put", entityId, `/modes/${encodeURIComponent(name)}`, {
        availability: opts.availability ?? null, expectedBack: opts.expectedBack ?? null, decisionRoom: opts.decisionRoom ?? null,
        exclusions: opts.exclude ?? [], quiet: opts.quiet ?? null, timezone: opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        account: opts.account ?? null, ...actorBody(opts),
      }, opts.json, (data) => console.log(describeSavedMode(data.mode)));
    });
  mode
    .command("saved <entityId> [name]")
    .description("Show a person's saved modes (or one), and the one that's on now")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, name: string | undefined, opts: { json?: boolean }) => {
      if (name) { await modeCall("get", entityId, `/modes/${encodeURIComponent(name)}`, undefined, opts.json, (data) => console.log(describeSavedMode(data.mode))); return; }
      await modeCall("get", entityId, "/modes", undefined, opts.json, (data) => {
        const modes = data.modes as Array<Record<string, any>>;
        if (modes.length === 0) console.log(`${entityId} has no saved modes`);
        for (const m of modes) console.log(describeSavedMode(m));
        console.log(data.current ? `on now: ${data.current.modeName}` : "on now: at desk (no mode)");
      });
    });
  mode
    .command("apply <entityId> <name>")
    .description("Switch a person into a saved mode, and show each effect's real state. 'at-desk' ends the current mode and applies none")
    .option("--until <time>", "When it ends: HH:MM (its next occurrence in --tz) or an ISO time with an offset. It ends then, as \"scheduled\"")
    .option("--tz <zone>", "IANA timezone for --until (default: this machine's zone, as for save and quiet set)")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, name: string, opts: { until?: string; tz?: string; actor?: string; json?: boolean }) => {
      const timezone = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      await modeCall("post", entityId, `/modes/${encodeURIComponent(name)}/apply`, {
        ...(opts.until ? { until: opts.until, timezone } : {}), ...actorBody(opts),
      }, opts.json, (data) => {
        if (data.ended) console.log(describeApplication(data.ended));
        console.log(data.application ? describeApplication(data.application) : `${entityId} is at desk: no mode on`);
        for (const line of unresolvedLines(data)) console.log(line);
        if (opts.until && opts.tz === undefined) console.log(`until ${opts.until} in ${timezone}; pass --tz for the person's own zone`);
      });
    });
  mode
    .command("current <entityId>")
    .description("Show the mode that's on for a person, with each effect's real state (none: at desk), and any restoration still owed")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, opts: { json?: boolean }) => {
      await modeCall("get", entityId, "/mode", undefined, opts.json, (data) => {
        console.log(data.current ? describeApplication(data.current) : `${entityId} is at desk: no mode on`);
        for (const line of unresolvedLines(data)) console.log(line);
      });
    });
  mode
    .command("end <entityId>")
    .description("\"I'm back\": end the person's mode. Each effect ends only if it's still the mode's own; a later choice of theirs stays. Restorations still owed are tried again")
    .option("--scheduled", "Record that it ended at its scheduled end, not on their word")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, opts: { scheduled?: boolean; actor?: string; json?: boolean }) => {
      await modeCall("post", entityId, "/mode/end", { reason: opts.scheduled ? "scheduled" : "back", ...actorBody(opts) }, opts.json, (data) => {
        console.log(data.ended ? `${describeApplication(data.ended)}\n${entityId} is at desk now` : `${entityId} had no mode on: at desk`);
        for (const line of unresolvedLines(data)) console.log(line);
      });
    });

  const chosen = (choices: Array<Record<string, any>>) => choices.map((c) => `${c.questionId ?? "choice"}=${c.chosen}`).join(", ");
  mode
    .command("account <entityId> <applicationId>")
    .description("The facts for a person's \"back\" account of one ended mode: how it ended, each effect, decisions made for them, what's waiting, and what isn't tracked. Made from the records only")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, applicationId: string, opts: { json?: boolean }) => {
      await modeCall("get", entityId, `/mode/applications/${encodeURIComponent(applicationId)}/account`, undefined, opts.json, (data) => {
        const a = data.account as Record<string, any>;
        const m = a.mode;
        const scheduled = m.scheduledEnd ? `; scheduled for ${m.scheduledEnd}` : "";
        console.log(describeSavedMode(m.settings));
        console.log(`  on ${m.startedAt}, ended ${m.endedAt} (${m.endReason}${scheduled})`);
        for (const e of a.effects as Array<Record<string, any>>) console.log(`  ${e.consumer}: ${e.state}${e.detail ? ` (${e.detail})` : ""}`);
        for (const line of unresolvedLines(a)) console.log(line);
        console.log(`  now: ${a.now ? a.now.modeName : "at desk"}`);
        const decisions = a.decisions as Array<Record<string, any>>;
        if (decisions.length === 0) console.log("  decided for them: nothing");
        for (const d of decisions) {
          console.log(`  decided for them: ${d.qitemId} by ${d.decision.decidedBy} (${d.decision.reversible ? "reversible" : "can't be undone"}): ${chosen(d.decision.choices)}; ${d.decision.reason}`);
        }
        const waiting = a.waiting as Array<Record<string, any>>;
        if (waiting.length === 0) console.log("  waiting for them: nothing");
        for (const w of waiting) console.log(`  waiting for them: ${w.qitemId} ${w.standing}${w.reason ? ` (${w.reason})` : ""}${w.summary ? `: ${w.summary}` : ""}`);
        for (const n of a.notTracked as string[]) console.log(`  not tracked: ${n}`);
      });
    });

  // Deciding on a person's behalf, inside the decision room of the mode they have on: read the room, record the decision
  // on the ask (as delegated, never as their answer), and list what was decided for the account when they're back.
  mode
    .command("room <entityId>")
    .description("Before asking a person a decision: the decision room of the mode they have on, in their own words, or none. You judge whether your decision falls inside it")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, opts: { json?: boolean }) => {
      await modeCall("get", entityId, "/decision-room", undefined, opts.json, (data) => {
        const room = data.decisionRoom as Record<string, any> | null;
        console.log(room
          ? `${entityId}'s ${room.modeName} decision room: "${room.words}"${room.exclusions?.length ? ` except ${room.exclusions.join(", ")}` : ""}\n`
            + `  decide with: rig gateway human mode decide <qitemId> --application ${room.applicationId} ...`
          : `${entityId}: no decision room (${data.why}); ask them`);
      });
    });

  mode
    .command("decide <qitemId>")
    .description("Record a decision you made on the person's behalf, inside their mode's decision room, on your own pending ask. It's recorded as delegated, never as their answer, and the ask closes")
    .requiredOption("--application <id>", "The application id from `rig gateway human mode room <entityId>`: the room you judged against. If their mode changed since, it's refused")
    .option("--choose <question=option...>", "The option chosen for each structured question (for example design=a ship=yes); for an ask without questions, the choice in words")
    .requiredOption("--reason <why>", "Why this choice")
    .option("--reversible", "It can be undone")
    .option("--irreversible", "It can't be undone")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .option("--json", "The daemon's answer as JSON")
    .action(async (qitemId: string, opts: { application: string; choose?: string[]; reason: string; reversible?: boolean; irreversible?: boolean; actor?: string; json?: boolean }) => {
      if (Boolean(opts.reversible) === Boolean(opts.irreversible)) {
        console.error("Say whether it can be undone: --reversible or --irreversible.");
        process.exitCode = 1;
        return;
      }
      const choices = (opts.choose ?? []).map((c) => {
        const at = c.indexOf("=");
        return at > 0 ? { questionId: c.slice(0, at), chosen: c.slice(at + 1) } : { chosen: c };
      });
      await daemonCall("post", `/api/queue/${encodeURIComponent(qitemId)}/delegated-decision`,
        { applicationId: opts.application, choices, reason: opts.reason, reversible: Boolean(opts.reversible), ...actorBody(opts) }, opts.json, (data) => {
          const d = data.item?.delegatedDecision as Record<string, any>;
          console.log(`${qitemId}: decided on the person's behalf under ${d.modeName} (${d.reversible ? "reversible" : "can't be undone"}): ${chosen(d.choices)}`);
        });
    });

  mode
    .command("decisions <entityId> <applicationId>")
    .description("The decisions made on a person's behalf under one mode application")
    .option("--json", "The daemon's answer as JSON")
    .action(async (entityId: string, applicationId: string, opts: { json?: boolean }) => {
      await modeCall("get", entityId, `/mode/applications/${encodeURIComponent(applicationId)}/decisions`, undefined, opts.json, (data) => {
        const decisions = data.decisions as Array<Record<string, any>>;
        if (decisions.length === 0) { console.log(`nothing was decided for ${entityId} under ${data.modeName}`); return; }
        for (const d of decisions) {
          console.log(`${d.qitemId} by ${d.decision.decidedBy} (${d.decision.reversible ? "reversible" : "can't be undone"}): ${chosen(d.decision.choices)}; ${d.decision.reason}`);
        }
      });
    });

  human
    .command("show <entityId>")
    .description("Show the effective record: fragment values + which defaults filled the rest, with provenance")
    .option("--json", "Complete record as JSON")
    .action(async (entityId: string, opts: { json?: boolean }) => {
      const { showHuman, participantsView } = await import("@openrig/daemon/gateway-human-registry");
      const res = showHuman(entityId);
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      // The person's organization, groups, policy and whether they're the default come from the participant side file.
      const view = participantsView();
      const placement = view.ok ? view.participants.find((p) => p.id === entityId) : undefined;
      const participant = placement
        ? { organization: placement.organization, groups: placement.groups, default: placement.default, policy: placement.policy }
        : { unavailable: view.ok ? "not found" : view.error };
      const sideFileError = view.ok ? view.sideFile.error : undefined;
      const r = { ...res.record, participant, ...(sideFileError ? { participantFileError: sideFileError } : {}), deliveryReadiness: await humanReadiness(entityId) };
      if (opts.json) { console.log(JSON.stringify({ ok: true, record: r })); return; }
      console.log(`${r.entityId} (${r.address}) — "${r.displayName}"`);
      console.log(`  fragment: ${r.fragmentPath}`);
      if (placement) for (const line of describePlacement(placement)) console.log(line);
      if (sideFileError) console.log(`  participant file: ${sideFileError}`);
      console.log(`  delivery-class: ${r.prefs.deliveryClass.value} (${r.prefs.deliveryClass.source})`);
      console.log(`  away: ${r.prefs.away.value} (${r.prefs.away.source})`);
      console.log(`  slack-subscription: ${r.slackSubscription.value} (${r.slackSubscription.source})`);
      r.connectorBindings.forEach((b, i) => {
        console.log(`  binding.${i}: ${b.kind}:${b.connectorRef} role=${b.role}${b.handle ? ` handle=${b.handle}` : " [outbound-only]"}`);
      });
      console.log(`  delivery-readiness: ${r.deliveryReadiness.state} (${r.deliveryReadiness.reason})`);
      if (r.deliveryReadiness.nextAction) console.log(`  next: ${r.deliveryReadiness.nextAction}`);
    });

  human
    .command("set <entityId> <field> <value>")
    .description("Edit one field through the verb (same validation as add; re-projection immediate). Fields: display-name, delivery-class, away, availability (available|focus|away|off, or unset), slack-subscription (the person's Slack subscription: every-ask, the default, posts every ask to Slack too; urgent-only posts only asks created with --alert, the rest wait on Steering and the TUI; or unset), binding.<n>; and, kept in the participant side file: organization (an id, or unset), groups (comma-separated ids, or unset), policy (text, @<path> to read a file, or unset)")
    .option("--reason <reason>", "Reason recorded with connector binding changes", "update human binding")
    .option("--actor <actor>", "Named operator when outside a managed seat")
    .action(async (entityId: string, field: string, value: string, opts: { reason: string; actor?: string }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      if (field === "organization" || field === "groups" || field === "policy") {
        const clear = value === "unset";
        let input: Record<string, unknown>;
        if (field === "organization") input = { organization: clear ? null : value };
        else if (field === "groups") input = { groups: clear ? null : value.split(",").map((g) => g.trim()).filter(Boolean) };
        else {
          const policy = clear ? { ok: true as const, value: null } : value.startsWith("@") ? readPolicyOption({ policyFile: value.slice(1) }) : { ok: true as const, value };
          if (!policy.ok) { console.error(`refused: ${policy.error}`); process.exitCode = 1; return; }
          input = { policy: policy.value };
        }
        const res = registry.setPersonPlacement(entityId, input);
        if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
        console.log(JSON.stringify({ ok: true, entityId, field, path: res.path }));
        return;
      }
      if (field.startsWith("binding.")) {
        const before = registry.showHuman(entityId);
        if (!before.ok) { console.error(`refused: ${before.error}`); process.exitCode = 1; return; }
        try {
          const prior = registry.channelStateDigest(before.record.connectorBindings.map(({ inboundResolvable: _derived, ...binding }) => binding));
          const result = await registry.runChannelOperation({
            actor: resolveSenderSession() ?? opts.actor ?? SENDER_FALLBACK, provenance: "claimed:v1", reason: opts.reason,
            action: "binding", subject: `${entityId}@external`, before: { digest: prior },
            run: async () => {
              const res = registry.setHumanField(entityId, field, value);
              if (!res.ok) throw new Error(res.error);
              const digest = registry.channelStateDigest(res.fragment.connectorBindings);
              return { value: res, after: { digest }, effect: digest === prior ? "no-op" : "applied" };
            },
          });
          console.log(JSON.stringify({ ok: true, entityId, field, path: result.value.path, receipt: result.receipt }));
        } catch (error) { console.error(`refused: ${(error as Error).message}`); process.exitCode = 1; }
        return;
      }
      const res = registry.setHumanField(entityId, field, value);
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
      // Their placement and, if it was them, the default go too; a later read would ignore them anyway, with a warning.
      const { removeParticipantEntry } = await import("@openrig/daemon/gateway-human-registry");
      const side = removeParticipantEntry(entityId, undefined, { kind: "person" });
      console.log(JSON.stringify({ ok: true, removed: res.removed, archivedPath: res.archivedPath, ...(res.orphanRecordPath ? { orphanRecordPath: res.orphanRecordPath } : {}),
        participantFile: side.ok ? { path: side.path } : { error: side.error } }));
    });

  // ── Participants beyond people (0.7.3): shared channels, organizations, groups, readable policy and the default. All of
  // it lives in gateway/participants.yaml, which older daemons don't read, so a rollback still loads every person.

  const channel = cmd.command("channel").description("Shared-channel participants: one vetted Slack channel is one participant (<id>@external), not a person per sender");
  channel
    .command("add <id>")
    .description("Register a shared channel")
    .requiredOption("--display-name <name>", "Human-readable name, e.g. \"Acme customers\"")
    .requiredOption("--binding <slack:connectorRef:secretsRef:channelId>", "The channel: connector kind (slack), connector label, vault pointer for its secrets (never the secret), and the Slack channel id")
    .option("--organization <id>", "Its organization (create it first with rig gateway org set)")
    .option("--group <id>", "A group it belongs to (repeatable)", (v: string, acc: string[] = []) => { acc.push(v); return acc; })
    .option("--policy <text>", "Readable policy for agents answering this channel (text, not enforced)")
    .option("--policy-file <path>", "Read the policy text from a file")
    .option("--replace", "Explicitly replace an existing channel (no silent overwrite)")
    .action(async (id: string, opts: { displayName: string; binding: string; organization?: string; group?: string[]; policy?: string; policyFile?: string; replace?: boolean }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const policy = readPolicyOption(opts);
      if (!policy.ok) { console.error(`refused: ${policy.error}`); process.exitCode = 1; return; }
      const parts = opts.binding.split(":");
      if (parts.length < 4 || parts[0] !== "slack") { console.error("refused: --binding must be slack:<connectorRef>:<secretsRef>:<channelId>"); process.exitCode = 1; return; }
      const res = registry.setSharedChannel(id, {
        displayName: opts.displayName,
        channel: { connector: "slack", connectorRef: parts[1]!, secretsRef: parts.slice(2, -1).join(":"), channelId: parts[parts.length - 1]! },
        organization: opts.organization, groups: opts.group, policy: policy.value,
      }, { replace: !!opts.replace });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, id, address: `${id}@${registry.ADDRESS_DOMAIN}`, path: res.path }));
    });
  channel
    .command("remove <id>")
    .description("Remove a shared channel: refuses while non-terminal rows are addressed to it (--force removes anyway)")
    .option("--force", "Remove despite KNOWN non-terminal rows")
    .action(async (id: string, opts: { force?: boolean }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const side = registry.readParticipantsFile();
      if (!side.ok) { console.error(`refused: ${side.error}`); process.exitCode = 1; return; }
      if (side.file.participants[id]?.kind !== "shared-channel") { console.error(`refused: no shared channel "${id}"`); process.exitCode = 1; return; }
      const address = `${id}@${registry.ADDRESS_DOMAIN}`;
      const rowsRes = await queueRows(address);
      if (!rowsRes.ok) { console.error(`refused: the queue could not be checked for rows addressed to ${address} (${rowsRes.error}); --force doesn't override an unchecked board`); process.exitCode = 1; return; }
      if (rowsRes.rows.length && !opts.force) {
        console.error(`refused: ${rowsRes.rows.length} non-terminal row(s) are addressed to ${address} (${rowsRes.rows.map((r) => r.id).join(", ")}); pass --force to remove anyway`);
        process.exitCode = 1;
        return;
      }
      const res = registry.removeParticipantEntry(id, undefined, { kind: "shared-channel" });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, removed: id, path: res.path, ...(rowsRes.rows.length ? { orphanedRows: rowsRes.rows.map((r) => r.id) } : {}) }));
    });

  const org = cmd.command("org").description("Organizations: the outer layer of participants, with readable policy agents apply");
  org
    .command("set <id>")
    .description("Create or update an organization")
    .option("--name <name>", "Display name (required when new)")
    .option("--policy <text>", "Readable policy for agents working with this organization (text, not enforced; \"\" clears it)")
    .option("--policy-file <path>", "Read the policy text from a file")
    .action(async (id: string, opts: { name?: string; policy?: string; policyFile?: string }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const policy = readPolicyOption(opts);
      if (!policy.ok) { console.error(`refused: ${policy.error}`); process.exitCode = 1; return; }
      const res = registry.setOrganization(id, { name: opts.name, ...(policy.value !== undefined ? { policy: policy.value || null } : {}) });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, organization: id, path: res.path }));
    });

  const group = cmd.command("group").description("Groups inside an organization, with readable policy agents apply");
  group
    .command("set <id>")
    .description("Create or update a group")
    .option("--organization <id>", "Its organization (required when new)")
    .option("--name <name>", "Display name (required when new)")
    .option("--policy <text>", "Readable policy for agents working with this group (text, not enforced; \"\" clears it)")
    .option("--policy-file <path>", "Read the policy text from a file")
    .action(async (id: string, opts: { organization?: string; name?: string; policy?: string; policyFile?: string }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const policy = readPolicyOption(opts);
      if (!policy.ok) { console.error(`refused: ${policy.error}`); process.exitCode = 1; return; }
      const res = registry.setGroup(id, { organization: opts.organization, name: opts.name, ...(policy.value !== undefined ? { policy: policy.value || null } : {}) });
      if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      console.log(JSON.stringify({ ok: true, group: id, path: res.path }));
    });

  cmd
    .command("participants")
    .description("List people and shared channels, with organization, groups, policy and the default")
    .option("--organization <id>", "Only this organization's participants")
    .option("--json", "Complete records as JSON, including organizations and groups")
    .action(async (opts: { organization?: string; json?: boolean }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const view = registry.participantsView();
      if (!view.ok) { console.error(`refused: ${view.error}`); process.exitCode = 1; return; }
      const shown = opts.organization ? view.participants.filter((p) => p.organization?.id === opts.organization) : view.participants;
      const defaultPerson = view.default.person ? { id: view.default.person.entityId, source: view.default.source } : { id: null, reason: view.default.source === "none" ? view.default.reason : null };
      if (opts.json) {
        const side = registry.readParticipantsFile();
        console.log(JSON.stringify({ ok: true, participants: shown, default: defaultPerson,
          organizations: side.ok ? side.file.organizations : null, groups: side.ok ? side.file.groups : null,
          warnings: view.warnings, participantFile: view.sideFile }));
        return;
      }
      if (!shown.length) console.log(opts.organization ? `no participants in organization "${opts.organization}"` : "no participants yet: rig gateway human add … registers a person, rig gateway channel add … a shared channel");
      for (const p of shown) {
        console.log(`${p.id}  ${p.kind}  "${p.displayName}"  ${p.address}${p.channel ? `  channel ${p.channel.channelId}` : ""}`);
        for (const line of describePlacement(p)) console.log(line);
      }
      console.log(defaultPerson.id ? `default: ${defaultPerson.id} (${defaultPerson.source === "chosen" ? "chosen" : "the only person"})` : `default: none — ${defaultPerson.reason}`);
      for (const warning of view.warnings) console.log(`warning: ${warning}`);
      if (view.sideFile.error) console.log(`participant file: ${view.sideFile.error}`);
    });

  cmd
    .command("default [entityId]")
    .description("Show or choose the default person: the one escalations, the notice digest, Mission Control's my-queue and pairing go to when no person is named")
    .option("--clear", "Clear the chosen default (with one person, they stay the default)")
    .action(async (entityId: string | undefined, opts: { clear?: boolean }) => {
      const registry = await import("@openrig/daemon/gateway-human-registry");
      if (entityId || opts.clear) {
        if (entityId && opts.clear) { console.error("refused: pass an id or --clear, not both"); process.exitCode = 1; return; }
        const res = registry.setDefaultPerson(opts.clear ? null : entityId!);
        if (!res.ok) { console.error(`refused: ${res.error}`); process.exitCode = 1; return; }
      }
      const people = registry.projectHumans();
      if (!people.ok) { console.error(`refused: ${people.error}`); process.exitCode = 1; return; }
      const chosen = registry.resolveDefaultPerson(people.entities);
      console.log(JSON.stringify(chosen.person
        ? { ok: true, default: chosen.person.entityId, address: chosen.person.address, source: chosen.source }
        : { ok: true, default: null, reason: chosen.source === "none" ? chosen.reason : null }));
    });

  return cmd;
}

/** One saved mode, in plain words. A setting the mode doesn't touch reads "unchanged". */
function describeSavedMode(m: Record<string, any>): string {
  const availability = m.availability?.value ? `${m.availability.value}${m.availability.expectedBack ? `, back ${m.availability.expectedBack}` : ""}` : "unchanged";
  const room = m.decisionRoom ? `"${m.decisionRoom.words}"${m.decisionRoom.exclusions?.length ? ` except ${m.decisionRoom.exclusions.join(", ")}` : ""}` : "none (nothing is decided for them)";
  const quiet = !m.delivery?.quiet ? "quiet hours unchanged" : m.delivery.quiet.kind === "daily"
    ? `quiet ${m.delivery.quiet.start}-${m.delivery.quiet.end} ${m.delivery.quiet.timezone}` : `quiet until the mode ends (${m.delivery.quiet.timezone})`;
  return `${m.name}: availability ${availability}; decision room ${room}; delivery: ${quiet}${m.delivery?.account ? `, account to ${m.delivery.account}` : ""}`;
}

/** One application: the mode, when it started or ended, and each effect's state. */
function describeApplication(a: Record<string, any>): string {
  const head = a.endedAt
    ? `${a.modeName} ended ${a.endedAt} (${a.endReason})`
    : `${a.modeName} on since ${a.startedAt}${a.scheduledEnd ? `, until ${a.scheduledEnd}` : ""}`;
  const effects = (a.effects as Array<Record<string, any>>).map((e) => `  ${e.consumer}: ${e.state}${e.detail ? ` (${e.detail})` : ""}`);
  return [head, ...(effects.length ? effects : ["  no effects"])].join("\n");
}

/** --policy or --policy-file (never both): the readable policy text agents read. Absent is undefined. */
function readPolicyOption(opts: { policy?: string; policyFile?: string }): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (opts.policy !== undefined && opts.policyFile !== undefined) return { ok: false, error: "pass --policy or --policy-file, not both" };
  if (opts.policyFile === undefined) return { ok: true, value: opts.policy };
  try {
    return { ok: true, value: readFileSync(opts.policyFile, "utf8") };
  } catch (error) {
    return { ok: false, error: `--policy-file: ${(error as Error).message}` };
  }
}

/** One participant's organization, groups, default and policy, in plain lines. */
function describePlacement(p: { organization: { id: string; name: string } | null; groups: Array<{ id: string; name: string }>; default: boolean; policy: Array<{ source: string; text: string }> }): string[] {
  const lines = [
    `  organization: ${p.organization ? `${p.organization.id} (${p.organization.name})` : "none"}`,
    `  groups: ${p.groups.length ? p.groups.map((g) => `${g.id} (${g.name})`).join(", ") : "none"}`,
  ];
  if (p.default) lines.push("  default: yes (escalations, the notice digest and other unaddressed needs go to this person)");
  if (!p.policy.length) lines.push("  policy: none");
  for (const part of p.policy) lines.push(`  policy, from ${part.source}:`, ...part.text.trimEnd().split("\n").map((line) => `    ${line}`));
  return lines;
}
