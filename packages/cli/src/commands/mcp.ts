import { Command } from "commander";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { createMcpServer } from "../mcp-server.js";
import { addGrant, McpHttpConfigError, mcpTokenFilePath, readGrantServiceHeader, readGrants, revokeGrant, startMcpHttpServer } from "../mcp-http.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig mcp serve` — start MCP server wrapping the daemon API.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function mcpCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("mcp").description("MCP server for agent integration");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("serve")
    .description("Start MCP server (stdio transport, or Streamable HTTP with --http)")
    .option("--port <port>", "Daemon port override")
    .option("--http", "Serve over Streamable HTTP at /mcp instead of stdio")
    .option("--bind <host:port>", "With --http: where to listen (default 127.0.0.1:7437). Beyond loopback needs a grant (rig mcp token add)")
    .option("--grant-service <url>", "With --http: check each request's key with the grant service at this URL instead of the token file")
    .option("--grant-service-header-file <path>", "With --grant-service: a file holding one 'Name: value' header to send with each grant request")
    .option("--oauth-resource <url>", "With --grant-service and --oauth-issuer: the public https URL clients reach this server as (its path ends in /mcp), for OAuth discovery")
    .option("--oauth-issuer <url>", "With --oauth-resource: the OAuth authorization server that issues the keys --grant-service checks")
    .addHelpText("after", `
Both MCP protocol revisions are served, over stdio and --http alike: clients on 2026-07-28 (which may start with
server/discover) and clients that open with 2025's initialize handshake.

With --http and no token file, the server stays on loopback and acts as OPENRIG_SESSION_NAME, declared and not
authenticated, like stdio. Once a grant exists (rig mcp token add), every request needs its bearer credential, loopback
included, and each caller acts as its grant's seat within its rigs and roots. Add a grant before reaching the port
through a tunnel or proxy: they arrive on loopback too. If the token file then goes missing or can't be read, every
request is refused; serving unauthenticated again takes a restart with no token file. TLS comes from the tunnel or
proxy, not from this server.

With --grant-service, every request needs a key the grant service issued, checked with that service on each request
for this daemon's instance (its self id); the token file isn't read. A caller acts as the seat its grant names, which
must already exist here (created is enough; it needn't have been launched), and reaches only what the grant names. If
the grant service can't answer, the request is refused.

With --grant-service, --oauth-resource and --oauth-issuer (both or neither) add OAuth discovery (RFC 9728) for clients
that sign in with OAuth. The resource is the public URL this server is reached as, and the issuer is the authorization
server that issues the keys --grant-service checks. GET /.well-known/oauth-protected-resource<resource path> then answers
with both, exactly as given, without a credential or a call to the grant service, and every 401 points there. Both must
be https with no userinfo, query or fragment, written as a URL writes them (a lowercase host, no default port). /mcp
stays the endpoint; a proxy in front forwards the metadata path unchanged.`)
    .action(async (opts: { port?: string; http?: boolean; bind?: string; grantService?: string; grantServiceHeaderFile?: string; oauthResource?: string; oauthIssuer?: string }) => {
      const deps = getDepsF();

      let daemonUrl: string;
      if (opts.port) {
        const daemonPort = parseInt(opts.port, 10);
        if (Number.isNaN(daemonPort)) {
          console.error("Invalid port number");
          process.exitCode = 1;
          return;
        }
        if (daemonPort < 1 || daemonPort > 65535) {
          console.error(`Warning: daemon port ${daemonPort} is outside [1, 65535]; MCP will start, but daemon tool calls may fail. Check --port.`);
        }
        daemonUrl = `http://127.0.0.1:${daemonPort}`;
      } else {
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (!daemonStatusGuard(status)) return;
        daemonUrl = getDaemonUrl(status);
      }

      if (!opts.http && (opts.grantService || opts.grantServiceHeaderFile)) {
        console.error("--grant-service and --grant-service-header-file need --http");
        process.exitCode = 1;
        return;
      }
      if (opts.grantServiceHeaderFile && !opts.grantService) {
        console.error("--grant-service-header-file needs --grant-service");
        process.exitCode = 1;
        return;
      }
      if ((opts.oauthResource === undefined) !== (opts.oauthIssuer === undefined)) {
        console.error("--oauth-resource and --oauth-issuer go together: give both, or neither");
        process.exitCode = 1;
        return;
      }
      const oauth = opts.oauthResource !== undefined && opts.oauthIssuer !== undefined ? { resource: opts.oauthResource, issuer: opts.oauthIssuer } : undefined;
      if (oauth && !(opts.http && opts.grantService)) {
        console.error("--oauth-resource and --oauth-issuer need --http --grant-service");
        process.exitCode = 1;
        return;
      }
      if (opts.http) {
        await serveHttp(daemonUrl, opts.bind ?? "127.0.0.1:7437", opts.grantService, opts.grantServiceHeaderFile, oauth);
        return;
      }
      const client = deps.clientFactory(daemonUrl);
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => { finish = resolve; });
      process.stdin.once("end", finish);
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      // Serves the protocol revision the client opens with: 2026-07-28 per request, or 2025's initialize handshake.
      const served = serveStdio(() => createMcpServer(client), { onerror: (err) => console.error(`rig mcp serve: ${err.message}`) });
      try {
        // EOF is a normal stdio disconnect, not an unresolved top-level await.
        if (process.stdin.readableEnded) finish();
        await closed;
      } finally {
        process.stdin.removeListener("end", finish);
        process.removeListener("SIGINT", finish);
        process.removeListener("SIGTERM", finish);
        await served.close();
      }
    });

  const token = cmd.command("token").description("Grants for rig mcp serve --http: who may connect, as which seat, reaching what");
  token
    .command("add <name>")
    .description("Add a grant and print its token once; only the token's hash is stored")
    .requiredOption("--seat <session>", "The seat this caller acts as (its rows' source)")
    .option("--rig <name...>", "Rigs whose seats and work this caller may reach")
    .option("--root <name...>", "Shared file roots (OPENRIG_FILES_ALLOWLIST names) whose artifacts it may read")
    .option("--workspace", "Also read the work tree and context (rig_slices, rig_mission, rig_context_*)")
    .option("--owner", "An owner grant: every tool and object, like the local owner")
    .action(async (name: string, opts: { seat: string; rig?: string[]; root?: string[]; workspace?: boolean; owner?: boolean }) => {
      const file = mcpTokenFilePath();
      try {
        const issued = await addGrant(file, { name, seat: opts.seat, rigs: opts.rig ?? [], roots: opts.root ?? [], workspace: opts.workspace === true, owner: opts.owner === true });
        console.log(`Token for ${name}, shown once (only its hash is kept in ${file}):`);
        console.log(issued);
        console.log(`The client sends it as: Authorization: Bearer <token>. Revoke it with: rig mcp token revoke ${name}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  token
    .command("list")
    .description("List grants (never their tokens or hashes)")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const file = mcpTokenFilePath();
      let grants;
      try { grants = readGrants(file); } catch (err) { console.error((err as Error).message); process.exitCode = 1; return; }
      const shown = (grants ?? []).map(({ tokenSha256: _hash, ...grant }) => grant);
      if (opts.json) { console.log(JSON.stringify({ configured: grants !== null, file, grants: shown }, null, 2)); return; }
      if (grants === null) { console.log(`No grants: rig mcp serve --http serves loopback only, unauthenticated (${file} doesn't exist).`); return; }
      if (shown.length === 0) console.log(`No grants left in ${file}: every HTTP request is refused until one is added.`);
      for (const grant of shown) {
        console.log(`${grant.name}: seat ${grant.seat}${grant.owner ? ", owner" : ""}; rigs ${grant.rigs.join(", ") || "(none)"}; roots ${grant.roots.join(", ") || "(none)"}${grant.workspace ? "; workspace" : ""}`);
      }
    });
  token
    .command("revoke <name>")
    .description("Remove a grant: its next request is refused. Work it already handed over stays with its owners")
    .action(async (name: string) => {
      try {
        if (!(await revokeGrant(mcpTokenFilePath(), name))) { console.error(`No grant named ${name}.`); process.exitCode = 1; return; }
        console.log(`Revoked ${name}: its next request is refused. Its rows and records stay.`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}

async function serveHttp(daemonUrl: string, bind: string, grantService?: string, grantServiceHeaderFile?: string,
  oauth?: { resource: string; issuer: string }): Promise<void> {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(bind);
  if (!match) {
    console.error(`--bind takes host:port (for example 127.0.0.1:7437 or [::1]:7437), not ${bind}`);
    process.exitCode = 1;
    return;
  }
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const tokenFile = mcpTokenFilePath();
  let served;
  try {
    const header = grantServiceHeaderFile ? readGrantServiceHeader(grantServiceHeaderFile) : undefined;
    served = await startMcpHttpServer({ daemonUrl, host, port: Number(match[2]), tokenFile,
      ...(grantService ? { grantService: { url: grantService, ...(header ? { header } : {}) } } : {}), ...(oauth ? { oauth } : {}) });
  } catch (err) {
    console.error(err instanceof McpHttpConfigError ? err.message : `Can't serve on ${bind}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const seat = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  console.error(grantService
    ? `OpenRig MCP over HTTP at ${served.url}: each request needs a key from the grant service, checked with ${grantService}.`
    : served.authenticated
    ? `OpenRig MCP over HTTP at ${served.url}: each request needs a bearer credential from ${tokenFile}.`
    : `OpenRig MCP over HTTP at ${served.url}: no grants, so loopback only, acting as ${seat || "no seat"}, declared and not authenticated. Add a grant (rig mcp token add) before reaching it through a tunnel or proxy.`);
  if (oauth) console.error(`OAuth discovery names ${oauth.resource}, issued by ${oauth.issuer}.`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await served.close();
}
