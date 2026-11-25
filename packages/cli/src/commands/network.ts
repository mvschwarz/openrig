import { Command } from "commander";
import { lstatSync, readFileSync } from "node:fs";
import { DaemonClient, operatorAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, type LifecycleDeps } from "../daemon-lifecycle.js";
import { resolveSenderSession } from "../sender-identity.js";
import { realDeps } from "./daemon.js";

export interface NetworkDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => Pick<DaemonClient, "get" | "post">;
  readTokenFile?: (path: string) => string;
}

interface Binding {
  id: string; localSession: string; hubUrl: string; hubSeat: string; state: string; stateReason: string | null;
  lastContactAt: string | null; lastError: string | null; unencrypted?: boolean;
  /** Hub items someone else closed before this binding's result reached them. */
  closedElsewhere?: Array<{ hubItem: string; localItem: string }>;
  participantName?: string | null;
  credentialCleanup?: "pending" | "complete";
  providerRemoval?: "pending" | "confirmed" | "unconfirmed" | "superseded" | null;
  providerRemovalReason?: string | null;
  /** For an ended binding made through the account: whether the account confirmed it stopped listing the name. */
  accountRemoval?: "confirmed" | "unconfirmed" | "old-installation" | null;
}

/** The network writes can wait on the account, which the daemon bounds at 30 s in all; the CLI waits past that so the
 *  account's own answer is shown rather than a daemon timeout. */
const ACCOUNT_WRITE_TIMEOUT_MS = 45_000;

const accountNote = (b: Binding): string => {
  if (b.accountRemoval === "unconfirmed") return `\n  couldn't confirm the account dropped ${b.participantName}: run rig network disconnect ${b.id} again`;
  if (b.accountRemoval === "old-installation") return `\n  ${b.participantName} may still be listed under the old installation: remove it on the account page`;
  if (b.providerRemoval === "pending") return "\n  provider removal pending; the connection provider has not confirmed it";
  if (b.providerRemoval === "unconfirmed") return "\n  provider removal unconfirmed; check the connection provider";
  if (b.providerRemoval === "superseded") return "\n  provider removal superseded; this revision was not confirmed removed";
  if (b.providerRemoval === "confirmed" && !b.accountRemoval) return "\n  provider removal confirmed";
  return "";
};

interface Installation { id: string; site: string; installationId: string; name: string | null }

const enrolled = (i: Installation) => `Enrolled at ${i.site} as installation ${i.name ?? i.installationId} (${i.id})`;

/** The participant's token, read from the file the account gave the person. A file others can read is used, with a note. */
function defaultReadTokenFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} isn't a regular file.`);
  if ((stat.mode & 0o077) !== 0) console.error(`Note: ${path} can be read by other users of this machine; OpenRig keeps its own private copy.`);
  return readFileSync(path, "utf8").trim();
}

/** A hub URL as status prints it: a query string or a fragment can carry a credential the person pasted, so neither is
 *  shown. The daemon's queue text and whoami hide them the same way. */
export function shownHubUrl(hubUrl: string): string {
  try {
    const url = new URL(hubUrl);
    const hidden = [url.search && "query", url.hash && "fragment"].filter(Boolean).join(" and ");
    if (!hidden) return hubUrl;
    url.search = "";
    url.hash = "";
    return `${url.toString()} (${hidden} hidden)`;
  } catch {
    return hubUrl;
  }
}

function line(b: Binding): string {
  const cleanup = b.credentialCleanup === "pending" ? "\n  credential cleanup pending; the connector will retry" : "";
  const contact = b.lastContactAt ? `last contact ${b.lastContactAt}` : "no contact yet";
  const state = b.state === "active" ? contact : `${b.state}${b.stateReason ? ` (${b.stateReason})` : ""}`;
  const plain = b.unencrypted ? "  UNENCRYPTED (http, allowed for this binding)" : "";
  const conflicts = (b.closedElsewhere ?? []).map((c) => `\n  hub item ${c.hubItem} was closed elsewhere before its result arrived; the result stays on ${c.localItem}`).join("");
  return `${b.id}  ${b.localSession} -> ${b.hubSeat} at ${shownHubUrl(b.hubUrl)}${plain}  ${state}${b.lastError && b.state === "active" ? `  last error: ${b.lastError}` : ""}${conflicts}${accountNote(b)}${cleanup}`;
}

/** `rig network`: connect a selected local seat to a participant of a remote hub (an account's network rig, or
 *  another OpenRig hub), see where each connection stands, and disconnect one. */
/** The hub's roster for a seat, without that seat: its `rig_team` lists the asking participant too, and a seat can't send
 *  a request to itself. Only an exact match on the binding's hub seat is left out. */
function withoutOwnSeat(data: Record<string, unknown>): Record<string, unknown> {
  const own = data.hubSeat;
  const team = data.team as Record<string, unknown> | null | undefined;
  if (typeof own !== "string" || !team || typeof team !== "object") return data;
  const others = (list: unknown[]) => list.filter((p) => (p as { session?: unknown } | null)?.session !== own);
  return { ...data, team: { ...team,
    ...(Array.isArray(team.seats) ? { seats: others(team.seats) } : {}),
    ...(Array.isArray(team.hostedMembers) ? { hostedMembers: others(team.hostedMembers) } : {}) } };
}

export function networkCommand(depsOverride?: NetworkDeps): Command {
  const cmd = new Command("network")
    .description("Connect selected local seats to a remote hub, see their status, and disconnect them. Experimental and unsupported: use it only if you choose to, at your own risk");
  const getDeps = (): NetworkDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  const client = async () => {
    const deps = getDeps();
    const daemon = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(daemon)) return null;
    return deps.clientFactory(getDaemonUrl(daemon));
  };
  const finish = (status: number, data: unknown, json: boolean | undefined, ok: (data: Record<string, unknown>) => string) => {
    if (status >= 400) {
      const error = data as { error?: string; message?: string };
      console.error(json ? JSON.stringify(data) : `${error.message ?? "The daemon refused this"} (${error.error ?? status})`);
      process.exitCode = status >= 500 ? 2 : 1;
      return;
    }
    console.log(json ? JSON.stringify(data, null, 2) : ok(data as Record<string, unknown>));
  };
  const missingArgument = (name: string) => {
    console.error(`error: missing required argument '${name}'`);
    process.exitCode = 1;
  };
  /** A left-out binding or seat is the calling seat, resolved as the seat-acting verbs resolve it; the daemon finds a
   *  seat's binding by its address. With no seat to use, the error is the one the required argument gave. */
  const ownSeat = (): string | undefined => {
    const seat = resolveSenderSession();
    if (!seat) missingArgument("binding-or-seat");
    return seat;
  };

  cmd.command("enroll")
    .description("Enroll this daemon in an account with the one-time code its page shows, so seats connect by name")
    .argument("<code>", "The one-time code from the account page")
    .requiredOption("--site <url>", "The account's site")
    .option("--allow-http", "Accept a plain-http site: the installation key and tokens cross the network unencrypted")
    .option("--replace", "Replace this daemon's enrollment at the site, once the account accepts the new code (after a lost key or a removed installation)")
    .option("--json", "Print JSON")
    .action(async (code: string, opts: { site: string; allowHttp?: boolean; replace?: boolean; json?: boolean }) => {
      const daemon = await client();
      if (!daemon) return;
      const res = await daemon.post<Record<string, unknown>>("/api/network/installations", { code, site: opts.site, allowHttp: opts.allowHttp === true, replace: opts.replace === true },
        { headers: operatorAuthHeaders(), timeoutMs: ACCOUNT_WRITE_TIMEOUT_MS });
      finish(res.status, res.data, opts.json, (i) => {
        const replaced = (i as { replaced?: { endedBindings?: Array<{ id: string; localSession: string; participantName: string | null }>; problems?: string[] } }).replaced;
        const ended = replaced?.endedBindings ?? [];
        const lines = [enrolled(i as unknown as Installation)];
        if (ended.length) {
          lines.push(`Ended ${ended.length} binding${ended.length === 1 ? "" : "s"} made through the old installation; their names may still be listed under it, so remove them on the account page:`);
          for (const b of ended) lines.push(`  ${b.id}  ${b.localSession} as ${b.participantName}`);
        }
        for (const problem of replaced?.problems ?? []) lines.push(`Replaced, with cleanup left over: ${problem}`);
        lines.push("Connect a seat with rig network connect <seat> --as <name>.");
        return lines.join("\n");
      });
    });

  cmd.command("connect")
    .description("Connect a local seat to a hub participant: by name through the enrolled account, or with a hub URL and token file")
    .argument("<seat>", "The local seat to connect (its address, member@rig)")
    .requiredOption("--as <participant>", "Through the account: the name to connect as. With --hub: the participant's address in the hub (member@rig)")
    .option("--hub <url>", "The hub's MCP URL, to connect without the account (with --token-file)")
    .option("--token-file <path>", "A file holding the participant's token (with --hub)")
    .option("--allow-http", "Accept a plain-http hub for this binding: its token and work cross the network unencrypted")
    .option("--json", "Print JSON")
    .action(async (seat: string, opts: { hub?: string; as: string; tokenFile?: string; allowHttp?: boolean; json?: boolean }) => {
      if (!opts.hub !== !opts.tokenFile) {
        console.error("Give both --hub and --token-file, or neither to connect through the enrolled account.");
        process.exitCode = 1;
        return;
      }
      let body: Record<string, unknown> = { session: seat, participantName: opts.as };
      if (opts.hub && opts.tokenFile) {
        let token: string;
        try { token = (getDeps().readTokenFile ?? defaultReadTokenFile)(opts.tokenFile); } catch (error) {
          console.error(`Can't read the token file: ${(error as Error).message}`);
          process.exitCode = 1;
          return;
        }
        body = { session: seat, hubUrl: opts.hub, hubSeat: opts.as, token, allowHttp: opts.allowHttp === true };
      }
      const daemon = await client();
      if (!daemon) return;
      const res = await daemon.post<Record<string, unknown>>("/api/network/bindings", body, { headers: operatorAuthHeaders(), timeoutMs: ACCOUNT_WRITE_TIMEOUT_MS });
      finish(res.status, res.data, opts.json, (b) => `Connected ${line(b as unknown as Binding)}\nWork for ${(b as unknown as Binding).hubSeat} reaches ${seat} once the connector runs; rig network status shows its last contact.`);
    });

  cmd.command("status")
    .description("List the connections and where each stands")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const daemon = await client();
      if (!daemon) return;
      const res = await daemon.get<{ bindings: Binding[]; installations?: Installation[] }>("/api/network/bindings");
      finish(res.status, res.data, opts.json, (d) => {
        const bindings = (d.bindings ?? []) as Binding[];
        const installations = (d.installations ?? []) as Installation[];
        return [...installations.map(enrolled), ...(bindings.length ? bindings.map(line) : ["No seats are connected to a hub."])].join("\n");
      });
    });

  cmd.command("disconnect")
    .description("Disconnect a seat: no new work comes in through it; its local work and results stay")
    .argument("<binding-or-seat>", "The binding id, or the connected seat's address")
    .option("--reason <text>", "Why, for the record")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { reason?: string; json?: boolean }) => {
      const daemon = await client();
      if (!daemon) return;
      const res = await daemon.post<Record<string, unknown>>(`/api/network/bindings/${encodeURIComponent(ref)}/disconnect`, { reason: opts.reason },
        { headers: operatorAuthHeaders(), timeoutMs: ACCOUNT_WRITE_TIMEOUT_MS });
      finish(res.status, res.data, opts.json, (raw) => {
        const b = raw as unknown as Binding;
        if (b.accountRemoval === "confirmed") return `Disconnected ${line(b)}\nThe account stopped listing ${b.participantName}, which revokes it there.`;
        if (b.accountRemoval) return `Disconnected ${line(b)}`;
        return `Disconnected ${line(b)}\nRemove the participant on the hub too: until then, the hub still lists it.`;
      });
    });

  cmd.command("peers")
    .description("List the peers a connected seat can send requests to, as its hub answers")
    .argument("[binding-or-seat]", "The binding id, or the connected seat's address. Left out, your own seat")
    .option("--json", "Print JSON")
    .action(async (given: string | undefined, opts: { json?: boolean }) => {
      const ref = given ?? ownSeat();
      if (!ref) return;
      const daemon = await client();
      if (!daemon) return;
      const res = await daemon.get<Record<string, unknown>>(`/api/network/bindings/${encodeURIComponent(ref)}/peers`, { timeoutMs: ACCOUNT_WRITE_TIMEOUT_MS });
      finish(res.status, res.status < 400 ? withoutOwnSeat(res.data) : res.data, opts.json, (d) => {
        const team = (d.team ?? {}) as { seats?: Array<{ session?: string; label?: string | null }>; hostedMembers?: Array<{ session?: string; label?: string | null }> };
        const peers = [...(team.seats ?? []), ...(team.hostedMembers ?? [])].filter((p) => typeof p.session === "string");
        if (!peers.length) return `The hub lists no peers for ${String(d.hubSeat)}.`;
        return [`Peers ${String(d.hubSeat)} can send to:`, ...peers.map((p) => `  ${p.session}${p.label ? `  ${p.label}` : ""}`)].join("\n");
      });
    });

  cmd.command("request")
    .description("Send a request to a peer through a connected seat's hub; its answer comes back to a local queue item")
    // Commander fills arguments in order, so an optional one can't come before a required one: both are optional here,
    // and one argument given is the peer.
    .usage("[options] [binding-or-seat] <peer>")
    .argument("[binding-or-seat]", "The binding id, or the connected seat's address. Left out, your own seat")
    .argument("[peer]", "The peer's address in the hub, as rig network peers lists it")
    .requiredOption("--id <request-id>", "Your own id for this request, unique to it: the local item's id. Retry only with the same id")
    .requiredOption("--body-file <path>", "A file holding the request: what to do and what to return")
    .option("--summary <text>", "One-line summary")
    .option("--json", "Print JSON")
    .addHelpText("after", `
Waiting for the answer: the local item <request-id> belongs to OpenRig, so nothing
wakes you when it closes. To be woken, park a row of your own on it:
  rig queue create --id <request-id>-wait --destination <your seat> --summary "Report <request-id>'s answer" --body "..."
  rig queue claim <request-id>-wait
  rig queue block <request-id>-wait --on <request-id> --continuation "read <request-id> and report its answer"
Then check once: rig queue show <request-id>. If it already reads closed (done, failed,
canceled or denied), or isn't found, nothing will wake you for it: read the answer now
and close your own row. (For a request id starting qitem-, block itself refuses a
closed item.) Otherwise, when <request-id> closes, your row returns to pending and
you're woken. A request whose binding ends, or that the hub never answers, stays open:
add --wake-after 4h (your choice) to the block to be woken anyway.
A request id starting fold:, auth: or external: is read by block as a gate, not as
this item, so nothing wakes the row for it: give a request you'll wait on another id.
rig whoami names your binding.`)
    .action(async (first: string | undefined, second: string | undefined, opts: { id: string; bodyFile: string; summary?: string; json?: boolean }) => {
      if (first === undefined) return missingArgument("peer");
      const peer = second ?? first;
      const ref = second === undefined ? ownSeat() : first;
      if (!ref) return;
      let body: string;
      try { body = readFileSync(opts.bodyFile, "utf8"); } catch (error) {
        console.error(`Can't read the body file: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      const daemon = await client();
      if (!daemon) return;
      const res = await daemon.post<Record<string, unknown>>(`/api/network/bindings/${encodeURIComponent(ref)}/requests`,
        { peer, requestId: opts.id, body, summary: opts.summary }, { headers: operatorAuthHeaders(), timeoutMs: ACCOUNT_WRITE_TIMEOUT_MS });
      finish(res.status, res.data, opts.json, (d) => String(d.message ?? ""));
      // Refused by the hub: the request is recorded and closed failed, which isn't success.
      if (res.status < 400 && (res.data as { state?: unknown } | null)?.state === "refused") process.exitCode = 1;
    });

  return cmd;
}
