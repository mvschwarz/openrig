import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { fieldLine, listItem, sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { FleetSnapshot } from "../types.js";

/** Selected, value-safe daemon projection; raw config and connector errors never enter the TUI. */
export interface ConnectionsRead {
  observedAt: string; home: string | null; pid: number;
  settingsSource: string | null;
  settings: Array<{ key: string; value: string | null; source: string }>;
  configSource: { state: string; path: string | null };
  configuration: null | { enabled: boolean; channel: string | null; inboundDestination: string | null;
    outboundDestinations: Array<string | null>; postLevel: string; interruptLevel: string; botToken: string; appToken: string;
    /** #192: absent from daemons that predate the channel map. */
    channelMap?: Array<{ match: string | null; channel: string | null }> };
  running: { state: string; activatedAt: string | null; outboundReady: boolean | null; inboundReady: boolean | null; inboundState: string; applied: string;
    inboundDelivery?: string | null; inboundEventsMissingSince?: string | null };
  state: string; nextAction: string;
  verification: { state: string; at: string | null; actor: string | null };
  registry: { state: string; path: string | null };
  humans: Array<{ entityId: string; address: string; displayName: string | null; deliveryClass: string; availability: string; excluded: boolean | null;
    bindings: Array<{ kind: string; ref: string | null; role: string; handle: string | null }> }>;
}
/** The daemon's read-only Slack app manifest (GET /api/gateway/slack/manifest). */
export interface SlackManifestRead { yaml: string; url: string; scopes?: string[]; events?: string[] }
export const SLACK_MANIFEST_EXPAND_KEY = "slack:manifest";

/** No Slack app yet: neither token resolves. Unknown token state is not "not configured". */
export function slackNotConfigured(c: ConnectionsRead): boolean {
  return !!c.configuration && c.configuration.botToken === "missing" && c.configuration.appToken === "missing";
}

/** Not-configured Slack: the create-your-own-app link as plain selectable text, and a toggle that
 *  expands the manifest in place. The TUI opens nothing, accepts no tokens and creates nothing. */
function slackSetupLines(snap: FleetSnapshot, expanded: readonly string[], width: number): ContentLine[] {
  const m = snap.slackManifest;
  const lines: ContentLine[] = [fieldLine({ label: "setup", value: "not configured · no Slack app tokens yet" })];
  if (!m) {
    lines.push({ text: "  Create your own Slack app first: rig slack manifest --url (this daemon does not serve the manifest)." });
    return lines;
  }
  const open = expanded.includes(SLACK_MANIFEST_EXPAND_KEY);
  lines.push({ text: "  Create your own private Slack app from OpenRig's manifest, using this link:" },
    { text: "  ▸ Print link to copy (Enter): leaves this view and shows the link as one line; Enter returns",
      action: { type: "print-for-copy", label: "Slack create-app link (from OpenRig's manifest):", value: m.url } },
    { text: "  The link, split into rows with nothing added (or run: rig slack manifest --url):" },
    // Exact-width chunks with no indent, so the rows concatenate back to the link byte for byte.
    ...Array.from({ length: Math.ceil(m.url.length / Math.max(8, width)) }, (_, i) =>
      ({ text: m.url.slice(i * Math.max(8, width), (i + 1) * Math.max(8, width)) })),
    { text: `  ${open ? "▾ Hide" : "▸ Show"} manifest (Enter)`, action: { type: "toggle-expand", key: SLACK_MANIFEST_EXPAND_KEY } });
  if (open) for (const line of m.yaml.trimEnd().split("\n")) lines.push({ text: `    ${line}` });
  lines.push({ text: "  Then: rig slack setup, rig slack verify, rig slack enable. Steps: rig slack manifest --help" });
  return lines;
}

export interface ControlPlaneRead {
  status?: string; semver?: string; commit?: string; dirty?: boolean; builtAt?: string;
  selfHostId?: string | null; selfHostIdSource?: string;
}
export function connectionsLines(snap: FleetSnapshot, width: number, timeZone = DEFAULT_TIME_ZONE, expanded: readonly string[] = []): ContentLine[] {
  const c = snap.connections;
  const h = snap.controlPlane;
  const lines: ContentLine[] = [{ text: "Connections · this daemon's instance" },
    ...(c ? [{ text: `  Slack: ${c.state} · humans: ${c.registry.state === "available" ? c.humans.length : "unknown"} · Next: ${c.nextAction}` }] : []),
    { text: "  Passive view · refresh sends nothing · back returns to work" },
    sectionRule("Running control plane", width),
    fieldLine({ label: "daemon", value: h ? `${h.status ?? "unknown"} · ${h.semver ?? "version unstamped"} · ${h.commit ?? "commit unstamped"}${h.dirty === true ? " · dirty" : ""}` : "unavailable — check rig status" }),
    fieldLine({ label: "host", value: h?.selfHostId ? `${h.selfHostId} (${h.selfHostIdSource ?? "source unreported"})` : "identity unreported" }),
    fieldLine({ label: "CLI launch", value: snap.launchingCli ?? "identity not supplied (direct TUI launch)" }),
    fieldLine({ label: "target", value: snap.daemonTarget ?? "unreported" }),
  ];
  if (!c) return wrapDetailLines([...lines, { text: "" }, { text: "  Connections unavailable — the daemon could not serve this view." },
    { text: "  Next: rig status; rig --version; rig daemon logs" },
    { text: "  An older daemon may not support Connections. No readiness inferred." }], width);
  lines.push(fieldLine({ label: "process", value: `PID ${c.pid} · home ${c.home ?? "unreported"}` }),
    fieldLine({ label: "observed", value: displayTime(c.observedAt, timeZone) }),
    sectionRule("Instance settings · resolved values", width));
  lines.push(fieldLine({ label: "settings", value: c.settingsSource ?? "source unavailable" }));
  for (const s of c.settings) lines.push(fieldLine({ label: s.key === "host.name" ? "display name" : s.key === "workspace.root" ? "workspace" : "operator", value: `${s.value ?? "unavailable"} (${s.source})` }));
  lines.push({ text: "  env overrides file overrides default. These are current settings, not proof of runtime adoption." },
    { text: "  Inspect/change on this instance: rig config --with-source; rig config set <key> <value>" },
    sectionRule("Slack · configuration and running services", width),
    fieldLine({ label: "delivery", value: `${c.state} · current external reach is unverified` }),
    fieldLine({ label: "source", value: `${c.configSource.state} · ${c.configSource.path ?? "unreported"}` }),
    fieldLine({ label: "gateway", value: `${c.running.state} · configuration ${c.running.applied}` }));
  if (c.running.applied === "changed") lines.push({ text: "  Config changed since the wire was built. Inspect before a supported restart; do not assume applied." });
  if (slackNotConfigured(c)) lines.push(...slackSetupLines(snap, expanded, width));
  const cfg = c.configuration;
  if (cfg) {
    lines.push(fieldLine({ label: "enabled", value: String(cfg.enabled) }),
      fieldLine({ label: "channel", value: cfg.channel ?? "missing" }),
      ...(cfg.channelMap ?? []).map((e) => fieldLine({ label: "channel map", value: `${e.match ?? "withheld"} → ${e.channel ?? "withheld"}` })),
      fieldLine({ label: "credentials", value: `bot ${cfg.botToken}; Socket Mode app ${cfg.appToken} (values hidden)` }),
      fieldLine({ label: "outbound", value: c.running.outboundReady === null ? "unreported" : `${c.running.outboundReady ? "configured at activation" : "not configured at activation"}; posting >= ${cfg.postLevel}, interrupting >= ${cfg.interruptLevel} (current config)` }),
      fieldLine({ label: "inbound", value: inboundValue(c.running) }));
    let inboundAction: ContentLine["action"];
    for (const host of snap.hosts) for (const rig of host.rigs) for (const pod of rig.pods) {
      const a = pod.agents.find((a) => a.session === cfg.inboundDestination);
      if (a) inboundAction = { type: "drill", resource: "agent", name: a.name, target: { host: host.name, rig: rig.name, pod: pod.name } };
    }
    lines.push(fieldLine({ label: "new inbound", value: cfg.inboundDestination ?? "missing", link: inboundAction }),
      { text: "  Replies follow their existing conversation; new/unmapped inbound uses the configured seat above." });
  }
  lines.push(fieldLine({ label: "last check", value: `${c.verification.state}${c.verification.at ? ` · ${displayTime(c.verification.at, timeZone)} · ${c.verification.actor ?? "actor unknown"}` : " · no matching check in the bounded audit tail"}` }),
    { text: "  A check records scopes/channel membership at that time. It does not prove delivery, current credentials, or readership." },
    fieldLine({ label: "next", value: c.nextAction }),
    { text: "  Run guidance on the displayed instance. verify contacts Slack explicitly; enable/disable retain their audited CLI behavior." },
    sectionRule("External humans · instance-wide registry", width));
  if (c.registry.state !== "available") lines.push({ text: "  Registry unavailable; recipients unknown. Next: rig gateway human list --json" });
  else if (!c.humans.length) lines.push({ text: "  No registered humans. Next: rig gateway human add --help" });
  const requests = [...new Map([...snap.attention, ...snap.pending, ...snap.inProgress, ...snap.blocked].map((r) => [r.qitemId, r])).values()];
  for (const human of c.humans) {
    lines.push(listItem(`${human.displayName ?? human.entityId} · ${human.address}`),
      { text: `    ${human.excluded === true ? "excluded by outbound policy" : human.excluded === null ? "route eligibility unknown" : `route uses instance Slack · ${c.state}`} · class ${human.deliveryClass}, availability ${human.availability}` });
    for (const b of human.bindings) lines.push({ text: `    ${b.role}: ${b.kind} ${b.ref ?? "unreported"} · handle ${b.handle ?? "absent (outbound only)"}` });
    for (const r of requests.filter((r) => r.destinationSession === human.address && ["pending", "in-progress", "blocked"].includes(r.state)).slice(0, 3)) {
      lines.push({ text: `    Open request in loaded window: ${r.qitemId} · from ${r.sourceSession ?? "source unreported"} · ${r.state}` },
        { text: `      Inspect: rig queue show ${r.qitemId} --full` });
    }
    lines.push({ text: `    Inspect binding/readiness (contacts Slack): rig gateway human show ${human.entityId} --json` });
  }
  lines.push({ text: "  Primary is the declared default binding; registration alone assigns no rig and proves no reachability." },
    sectionRule("Work and configuration", width));
  for (const host of snap.hosts) for (const rig of host.rigs) {
    lines.push(listItem(`${rig.name} · observed ${rig.lifecycleState ?? "unknown"} · ${snap.readErrors.some((e) => e.startsWith(`nodes(${rig.name}):`)) ? "seat inventory unavailable" : `${rig.pods.reduce((n, p) => n + p.agents.length, 0)} seats`}`, { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } }));
    if (rig.authoredSpecName) lines.push(listItem(`Authored spec: ${rig.authoredSpecName}`, snap.specs.some((s) => s.name === rig.authoredSpecName) ? { type: "drill", resource: "spec", name: rig.authoredSpecName } : undefined));
  }
  lines.push(listItem("Open work and workflows", { type: "jump", section: "scopes" }), listItem("Human requests and waits", { type: "jump", section: "needs" }), listItem("Return to previous view", { type: "back" }));
  return wrapDetailLines(lines, width);
}

/** An open socket is not proof that events arrive, so the delivery word is named beside the state.
 *  A daemon too old to report delivery leaves the bare state. */
export function inboundValue(r: ConnectionsRead["running"]): string {
  if (r.inboundDelivery === "events-missing") return `${r.inboundState}; events missing since ${r.inboundEventsMissingSince ?? "unknown"}`;
  if (r.inboundDelivery === "no-server-pings") return `${r.inboundState}; no server pings`;
  if (r.inboundDelivery === "socket-mode-disabled") return `${r.inboundState}; Socket Mode disabled in the Slack app settings`;
  if (r.inboundState === "connected" && r.inboundDelivery === "delivering") return "connected; delivering";
  if (r.inboundState === "connected" && r.inboundDelivery === "unknown") return "connected; delivery not yet confirmed";
  return r.inboundState;
}
