// `rig mcp serve --http`: the same MCP tools over Streamable HTTP, for an assistant that can't start a local process.
//
// Auth is configured by the token file's existence. With no token file, the listener stays on loopback and serves the
// local owner as the env's seat, declared and not authenticated (what stdio does). With one, every request needs a bearer
// credential that matches a grant, even on loopback: a tunnel or proxy delivers remote traffic to loopback, so loopback
// proves nothing about the caller. A missing, invalid or revoked credential is refused and never falls back to the env
// seat. Each request gets its own DaemonClient, carrying its grant's seat, so concurrent callers never share an identity.
import http from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DaemonClient } from "./client.js";
import { createMcpServer, type McpAccess } from "./mcp-server.js";
import { getOpenRigHome } from "./openrig-compat.js";

/** One caller's grant. Only the token's sha256 is stored. */
export type McpGrant = {
  name: string;
  tokenSha256: string;
  seat: string;
  rigs: string[];
  roots: string[];
  workspace: boolean;
  owner: boolean;
  createdAt: string;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function mcpTokenFilePath(home: string = getOpenRigHome()): string {
  return nodePath.join(home, "mcp-http-tokens.json");
}

/** The configured grants, or null when there is no token file (auth not configured). A file that can't be read or parsed
 *  throws: a broken configuration must never read as "no auth". */
export function readGrants(file: string): McpGrant[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(text) as { principals?: unknown };
  if (!Array.isArray(parsed.principals)) throw new Error(`${file} must hold { "principals": [...] }`);
  return parsed.principals as McpGrant[];
}

function writeGrants(file: string, grants: McpGrant[]): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ principals: grants }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Adds a grant and returns its token, which is shown once and never stored. */
export function addGrant(file: string, grant: Omit<McpGrant, "tokenSha256" | "createdAt">): string {
  const grants = readGrants(file) ?? [];
  if (grants.some((existing) => existing.name === grant.name)) {
    throw new Error(`'${grant.name}' already has a grant; revoke it first to issue a new token`);
  }
  const token = `orm_${randomBytes(32).toString("base64url")}`;
  grants.push({ ...grant, tokenSha256: sha256(token), createdAt: new Date().toISOString() });
  writeGrants(file, grants);
  return token;
}

/** Removes a grant; its next request is refused. The file stays, so auth stays configured. */
export function revokeGrant(file: string, name: string): boolean {
  const grants = readGrants(file);
  if (!grants?.some((grant) => grant.name === name)) return false;
  writeGrants(file, grants.filter((grant) => grant.name !== name));
  return true;
}

/** The grant a bearer token matches, compared in constant time. */
export function grantFor(grants: readonly McpGrant[], token: string): McpGrant | null {
  const digest = Buffer.from(sha256(token), "hex");
  let found: McpGrant | null = null;
  for (const grant of grants) {
    const stored = Buffer.from(typeof grant.tokenSha256 === "string" ? grant.tokenSha256 : "", "hex");
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) found = grant;
  }
  return found;
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export class McpHttpConfigError extends Error {}

export type McpHttpOptions = {
  daemonUrl: string;
  host: string;
  port: number;
  tokenFile: string;
  /** Builds the daemon client for one request; sessionName is the grant's seat (absent: the env's). */
  clientFactory?: (daemonUrl: string, sessionName?: string) => DaemonClient;
};

function reply(res: http.ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMcpHttpServer(opts: McpHttpOptions): Promise<{ url: string; authenticated: boolean; close(): Promise<void> }> {
  const loopback = isLoopbackHost(opts.host);
  const configured = readGrants(opts.tokenFile) !== null;
  if (!loopback && !configured) {
    throw new McpHttpConfigError(`Serving on ${opts.host} needs authentication: add a grant with rig mcp token add, then start again. With no grants, the server stays on loopback.`);
  }
  const makeClient = opts.clientFactory ?? ((url: string, sessionName?: string) => new DaemonClient(url, sessionName ? { sessionName } : undefined));
  let boundPort = opts.port;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") {
      reply(res, 404, { error: "not_found", message: "The MCP endpoint is /mcp." });
      return;
    }
    let grants: McpGrant[] | null;
    try {
      grants = readGrants(opts.tokenFile);
    } catch (err) {
      reply(res, 500, { error: "auth_config_unreadable", message: `The token file can't be read: ${(err as Error).message}` });
      return;
    }
    let access: McpAccess | undefined;
    let seat: string | undefined;
    if (grants !== null) {
      const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
      const grant = token ? grantFor(grants, token) : null;
      if (!grant) {
        reply(res, 401, {
          error: "unauthenticated",
          message: token ? "This credential isn't valid here: it's unknown or was revoked." : "This server needs a bearer credential: Authorization: Bearer <token>.",
        }, { "WWW-Authenticate": 'Bearer realm="openrig"' });
        return;
      }
      access = { principal: grant.name, owner: grant.owner === true, rigs: grant.rigs ?? [], roots: grant.roots ?? [], workspace: grant.workspace === true };
      seat = grant.seat;
    } else if (!loopback) {
      // The token file was removed after start: never serve a non-loopback caller without auth.
      reply(res, 401, { error: "unauthenticated", message: "Authentication isn't configured, so this server serves loopback only." }, { "WWW-Authenticate": 'Bearer realm="openrig"' });
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        const tooLarge = (err as Error).message === "body_too_large";
        reply(res, tooLarge ? 413 : 400, { jsonrpc: "2.0", error: { code: -32700, message: tooLarge ? "Request body too large" : "Parse error" }, id: null });
        return;
      }
    }
    const mcp = createMcpServer(makeClient(opts.daemonUrl, seat), { seat, access });
    // With no auth (loopback only), refuse a Host that isn't loopback, as a page reaching localhost through DNS rebinding
    // or a forward from elsewhere would send. With auth, the credential is the check, so a tunnel's Host is fine.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      ...(grants === null ? { enableDnsRebindingProtection: true, allowedHosts: [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`] } : {}),
    });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) reply(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: (err as Error).message }, id: null });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => { server.off("error", reject); resolve(); });
  });
  boundPort = (server.address() as { port: number }).port;
  const shownHost = opts.host.includes(":") && !opts.host.startsWith("[") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${shownHost}:${boundPort}/mcp`,
    authenticated: configured,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
