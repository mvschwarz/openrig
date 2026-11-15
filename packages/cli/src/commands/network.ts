import { Command } from "commander";
import { lstatSync, readFileSync } from "node:fs";
import { DaemonClient, operatorAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard, type LifecycleDeps } from "../daemon-lifecycle.js";
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
  /** For an ended binding made through the account: whether the account confirmed it stopped listing the name. */
  accountRemoval?: "confirmed" | "unconfirmed" | "old-installation" | null;
}

/** The network writes can wait on the account, which the daemon bounds at 30 s in all; the CLI waits past that so the
 *  account's own answer is shown rather than a daemon timeout. */
const ACCOUNT_WRITE_TIMEOUT_MS = 45_000;

const accountNote = (b: Binding): string => {
  if (b.accountRemoval === "unconfirmed") return `\n  couldn't confirm the account dropped ${b.participantName}: run rig network disconnect ${b.id} again`;
  if (b.accountRemoval === "old-installation") return `\n  ${b.participantName} may still be listed under the old installation: remove it on the account page`;
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

function line(b: Binding): string {
  const contact = b.lastContactAt ? `last contact ${b.lastContactAt}` : "no contact yet";
  const state = b.state === "active" ? contact : `${b.state}${b.stateReason ? ` (${b.stateReason})` : ""}`;
  const plain = b.unencrypted ? "  UNENCRYPTED (http, allowed for this binding)" : "";
  const conflicts = (b.closedElsewhere ?? []).map((c) => `\n  hub item ${c.hubItem} was closed elsewhere before its result arrived; the result stays on ${c.localItem}`).join("");
  return `${b.id}  ${b.localSession} -> ${b.hubSeat} at ${b.hubUrl}${plain}  ${state}${b.lastError && b.state === "active" ? `  last error: ${b.lastError}` : ""}${conflicts}${accountNote(b)}`;
}

/** `rig network`: connect a selected local seat to a participant of a remote hub (an account's network rig, or
 *  another OpenRig hub), see where each connection stands, and disconnect one. */
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

  return cmd;
}
