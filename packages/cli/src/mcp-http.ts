// `rig mcp serve --http`: the same MCP tools over Streamable HTTP, for an assistant that can't start a local process.
//
// Auth is configured by the token file's existence. With no token file, the listener stays on loopback and serves the
// local owner as the env's seat, declared and not authenticated (what stdio does). With one, every request needs a bearer
// credential that matches a grant, even on loopback: a tunnel or proxy delivers remote traffic to loopback, so loopback
// proves nothing about the caller. A missing, invalid or revoked credential is refused and never falls back to the env
// seat, and so is every request once the file is gone or malformed, until a restart. Each request gets its own
// DaemonClient, carrying its grant's seat, so concurrent callers never share an identity.
//
// With --grant-service, grants come from an external grant service instead and the token file is never read: each
// request's key is checked with that service (openrig.grant/v1) for this daemon's instance, every answer but active is
// refused, and an external caller reaches only what its grant names (externalScope in mcp-server.ts).
//
// The endpoint serves both protocol revisions: 2026-07-28 per request, and 2025's initialize and exchanges statelessly.
import http from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { DaemonClient } from "./client.js";
import { createMcpServer, type McpAccess } from "./mcp-server.js";
import { getOpenRigHome } from "./openrig-compat.js";
import { MCP_PRESENCE_FILE, presenceRecorder } from "./mcp-presence.js";
import { resolveRigHandle } from "./rig-handle.js";

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

/** An entry as token add writes it. A blank seat would act as the env's seat, and a string would become a set of its
 *  characters, so any other shape makes the file unreadable. */
function isGrant(entry: unknown): entry is McpGrant {
  const grant = (entry ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const list = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const flag = (value: unknown) => typeof value === "boolean";
  return text(grant.name) && typeof grant.tokenSha256 === "string" && text(grant.seat)
    && list(grant.rigs) && list(grant.roots) && flag(grant.workspace) && flag(grant.owner);
}

/** The configured grants, or null when there is no token file (auth not configured). A file that can't be read or parsed,
 *  or holds a malformed entry, throws: a broken configuration must never read as "no auth". */
export function readGrants(file: string): McpGrant[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(text) as { principals?: unknown } | null;
  if (!Array.isArray(parsed?.principals)) throw new Error(`${file} must hold { "principals": [...] }`);
  const bad = parsed.principals.findIndex((entry) => !isGrant(entry));
  if (bad >= 0) throw new Error(`${file}: grant ${bad + 1} is malformed; each needs a name, a tokenSha256, a non-blank seat, and lists of rigs and roots`);
  return parsed.principals as McpGrant[];
}

/** Holds the token file's lock for one read, modify and publish, so a concurrent add and revoke can't each publish a copy
 *  that drops the other's change. A lock left by a crashed command names itself after the wait. */
export async function withGrantsLock<T>(file: string, update: () => T, waitMs = 5_000): Promise<T> {
  const lock = `${file}.lock`;
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) throw new Error(`Another rig mcp token command holds ${lock}. If none is running, remove that file and try again.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return update();
  } finally {
    fs.rmSync(lock, { force: true });
  }
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
export function addGrant(file: string, grant: Omit<McpGrant, "tokenSha256" | "createdAt">): Promise<string> {
  if (!grant.name.trim() || !grant.seat.trim()) {
    return Promise.reject(new Error("A grant needs a name and a seat: --seat <session>, the seat this caller acts as."));
  }
  return withGrantsLock(file, () => {
    const grants = readGrants(file) ?? [];
    if (grants.some((existing) => existing.name === grant.name)) {
      throw new Error(`'${grant.name}' already has a grant; revoke it first to issue a new token`);
    }
    const token = `orm_${randomBytes(32).toString("base64url")}`;
    grants.push({ ...grant, seat: grant.seat.trim(), tokenSha256: sha256(token), createdAt: new Date().toISOString() });
    writeGrants(file, grants);
    return token;
  });
}

/** Removes a grant; its next request is refused. The file stays, so auth stays configured. */
export function revokeGrant(file: string, name: string): Promise<boolean> {
  return withGrantsLock(file, () => {
    const grants = readGrants(file);
    if (!grants?.some((grant) => grant.name === name)) return false;
    writeGrants(file, grants.filter((grant) => grant.name !== name));
    return true;
  });
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

/** The caller whose grant this server checked, as the daemon records it beside the rows it writes (principal:v1). */
export type McpPrincipal = { source: "file" | "grant-service"; id: string; grant?: string; version?: number | string };
/** One request's caller as this server decided it: no seat, access or principal for the loopback local owner. */
type RequestCaller = { seat?: string; access?: McpAccess; principal?: McpPrincipal };

/** An external grant service's contract. Core asks on every request with the caller's raw key and its own instance id;
 *  nothing is cached, and every answer but `active` is refused. */
export const GRANT_SCHEMA = "openrig.grant/v1";
/** A grant key as the grant service issues it, `<connection id>.cus_<principal id>.<secret>`. Anything else is refused
 *  before any call. */
const GRANT_KEY = /^[a-f0-9]{24}\.cus_[A-Za-z0-9]{8,64}\.[a-f0-9]{48}$/;
/** An instance id as the grant service takes it. */
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type GrantServiceOptions = {
  /** The grant endpoint. It must be https, except on loopback. */
  url: string;
  /** One header sent with every grant request and nowhere else, such as a protected deployment's bypass. */
  header?: { name: string; value: string };
  timeoutMs?: number;
};

/** Reads a `Name: value` header line from a secret file. */
export function readGrantServiceHeader(file: string): { name: string; value: string } {
  const line = fs.readFileSync(file, "utf8").trim();
  const match = /^([A-Za-z0-9-]+):[ \t]*(\S(?:.*\S)?)$/.exec(line);
  if (!match || line.includes("\n")) throw new McpHttpConfigError(`${file} must hold one line, Name: value`);
  // The request's own headers carry the key and the body; this one can't replace them.
  if (["authorization", "content-type", "content-length", "host"].includes(match[1]!.toLowerCase())) {
    throw new McpHttpConfigError(`${file} can't set ${match[1]}: the grant request sets it`);
  }
  return { name: match[1]!, value: match[2]! };
}

function grantServiceUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new McpHttpConfigError(`--grant-service takes the grant endpoint's URL, not ${url}`); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new McpHttpConfigError(`The grant endpoint must be https: ${url}`);
  }
  return parsed;
}

/** OAuth discovery (RFC 9728) for a server whose keys a grant service checks: the one metadata document, where it's
 *  served, and the 401 challenge that points at it. */
type OAuthDiscovery = { path: string; document: Record<string, unknown>; challenge: string };

/** The resource clients reach this server as and the authorization server that issues its keys, served exactly as
 *  configured. Each must be https with no userinfo, query or fragment, written as a URL writes it (a lowercase host, no
 *  default port), so nothing is normalized on the way out; the resource's path ends in /mcp. Its metadata is at the
 *  path-inserted address, and nowhere else. */
function oauthDiscovery(oauth: { resource: string; issuer: string }): OAuthDiscovery {
  const exact = (flag: string, value: string): URL => {
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* refused below */ }
    // A bare origin is written without the slash a URL adds. An empty query or fragment shows only in the text.
    const written = url !== undefined && (url.href === value || (url.pathname === "/" && url.href === `${value}/`));
    if (!url || !written || url.protocol !== "https:" || url.username || url.password || /[?#]/.test(value)) {
      throw new McpHttpConfigError(`${flag} takes an https URL with no userinfo, query or fragment, written as a URL writes it (a lowercase host, no default port), not ${value}`);
    }
    return url;
  };
  const resource = exact("--oauth-resource", oauth.resource);
  exact("--oauth-issuer", oauth.issuer);
  if (!resource.pathname.endsWith("/mcp")) throw new McpHttpConfigError(`--oauth-resource's path must end in /mcp, not ${oauth.resource}`);
  const path = `/.well-known/oauth-protected-resource${resource.pathname}`;
  return {
    path,
    document: { resource: oauth.resource, authorization_servers: [oauth.issuer], scopes_supported: ["openrig.work"], bearer_methods_supported: ["header"] },
    challenge: `Bearer realm="openrig", resource_metadata="${resource.origin}${path}"`,
  };
}

type Refusal = { status: number; error: string; message: string; log?: string };
const unauthenticated = (message: string): Refusal => ({ status: 401, error: "unauthenticated", message });
const NOT_VALID_HERE = "This credential isn't valid here: it's unknown or was revoked.";
const unavailable = (log: string): Refusal => ({
  status: 503, error: "grant_authority_unavailable", message: "The grant authority can't answer now, so this request isn't served. Try again later.", log,
});

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");

/** One request's caller from the grant service's answer for its key. A refusal never falls back to the token file or
 *  the env's seat. */
async function grantServiceCaller(service: GrantServiceOptions, url: URL, key: string, instance: string): Promise<{ seat: string; access: McpAccess; principal: McpPrincipal } | Refusal> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // A redirect would carry the key and the header to another origin.
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(service.header ? { [service.header.name]: service.header.value } : {}) },
      body: JSON.stringify({ instance }),
      signal: AbortSignal.timeout(service.timeoutMs ?? 5_000),
    });
  } catch (err) {
    return unavailable(`the grant request failed: ${(err as Error).message}`);
  }
  let body: Record<string, any>;
  try { body = await res.json() as Record<string, any>; } catch { return unavailable(`HTTP ${res.status} answered with a body that isn't JSON`); }
  if (body?.schema !== GRANT_SCHEMA) return unavailable(`HTTP ${res.status} answered schema ${JSON.stringify(body?.schema)}`);
  if (body.status === "unknown" || body.status === "wrong_instance") return unauthenticated(NOT_VALID_HERE);
  if (body.status === "revoked") return unauthenticated("This connection was disconnected. Reconnect it where it was made.");
  if (body.status === "expired") return unauthenticated("This credential has expired.");
  // malformed (this server's request), unavailable, or anything else.
  if (body.status !== "active" || res.status !== 200) return unavailable(`HTTP ${res.status} answered status ${JSON.stringify(body.status)}`);
  const { principal, grant, environment, seat, rigs, artifact_roots: roots, access_class: accessClass, objects } = body;
  const seatRig = typeof seat === "string" ? seat.split("@") : [];
  const problem = typeof principal?.id !== "string" || principal.id === "" ? "principal.id"
    : typeof grant?.id !== "string" || grant.id === "" ? "grant.id"
    : environment?.core_instance !== instance ? "environment.core_instance"
    : seatRig.length !== 2 || seatRig[0] === "" ? "seat"
    : !strings(rigs) || !rigs.includes(seatRig[1]!) ? "rigs"
    : !strings(roots) ? "artifact_roots"
    : accessClass !== "work" ? "access_class"
    : !objects || typeof objects !== "object" || Array.isArray(objects) || !Object.values(objects).every(strings) ? "objects"
    : grant.expires_at !== null && grant.expires_at !== undefined && !(Date.parse(grant.expires_at) > Date.now()) ? "expired" : null;
  if (problem === "expired") return unauthenticated("This credential has expired.");
  if (problem) return unavailable(`an active answer with an unusable ${problem}`);
  // The principal the daemon records beside this caller's rows. A version that isn't a finite number is left out (a v1
  // answer sends a number).
  return { seat, access: { principal: principal.id, owner: false, rigs, roots, workspace: false, external: { objects } },
    principal: { source: "grant-service", id: principal.id, grant: grant.id, ...(Number.isFinite(grant.version) ? { version: grant.version } : {}) } };
}

/** A node's seat name as the daemon derives it (deriveCanonicalFromEntry): {pod}-{member}@{rig}, the logical id split at
 *  its first dot. */
function canonicalSeat(logicalId: string, rigName: string): string | null {
  const dot = logicalId.indexOf(".");
  return dot > 0 && dot < logicalId.length - 1 ? `${logicalId.slice(0, dot)}-${logicalId.slice(dot + 1)}@${rigName}` : null;
}

/** Whether a seat whoami doesn't know is one of this daemon's nodes: a seat created without a launch (rig import
 *  --materialize-only) has no session yet. The rig resolves by name as rig commands resolve one (resolveRigHandle: only
 *  active rigs, and two active rigs of that name are ambiguous), and the seat must be exactly one of its nodes' names.
 *  Read only: nothing is created, launched or bound. A rig list or node list that can't be read, or has a malformed
 *  entry, and a name two nodes share, never count as the seat. */
async function nodeSeat(client: DaemonClient, seat: string): Promise<"found" | "absent" | Refusal> {
  const rig = await resolveRigHandle(client, seat.slice(seat.indexOf("@") + 1), { strict: true });
  if (rig.kind === "not_found") return "absent";
  if (rig.kind === "passthrough") return unavailable(`the rig list couldn't be read, or has a malformed entry, to look for seat ${seat}`);
  if (rig.kind === "ambiguous") return unavailable(`seat ${seat}'s rig name matches ${rig.ids.length} rigs (${rig.ids.join(", ")})`);
  const nodes = await client.get(`/api/rigs/${encodeURIComponent(rig.id)}/nodes`);
  if (nodes.status !== 200 || !Array.isArray(nodes.data)) return unavailable(`the node list for seat ${seat} answered HTTP ${nodes.status}`);
  let matches = 0;
  for (const node of nodes.data as unknown[]) {
    const { logicalId, rigName } = (node ?? {}) as Record<string, unknown>;
    if (typeof logicalId !== "string" || typeof rigName !== "string") return unavailable(`the node list for seat ${seat} has a malformed entry`);
    if (canonicalSeat(logicalId, rigName) === seat) matches += 1;
  }
  return matches === 1 ? "found" : matches === 0 ? "absent" : unavailable(`${matches} nodes are named ${seat}`);
}

export type McpHttpOptions = {
  daemonUrl: string;
  host: string;
  port: number;
  tokenFile: string;
  /** Builds the daemon client for one request; sessionName is the grant's seat (absent: the env's), and principal the
   *  caller whose grant was checked. */
  clientFactory?: (daemonUrl: string, sessionName?: string, principal?: McpPrincipal) => DaemonClient;
  /** Grants come from an external grant service instead of the token file, which is then never read. */
  grantService?: GrantServiceOptions;
  /** With grantService: OAuth discovery for clients that sign in with OAuth. The public resource this server is reached
   *  as and the authorization server that issues its keys, both served exactly as given. */
  oauth?: { resource: string; issuer: string };
  /** How often one seat's call is recorded (default 60 s). */
  presenceIntervalMs?: number;
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
  const service = opts.grantService;
  const serviceUrl = service ? grantServiceUrl(service.url) : undefined;
  // The metadata describes the keys a grant service checks, so it's served only with one.
  if (opts.oauth && !service) throw new McpHttpConfigError("--oauth-resource and --oauth-issuer need --grant-service");
  const discovery = opts.oauth ? oauthDiscovery(opts.oauth) : undefined;
  const configured = service !== undefined || readGrants(opts.tokenFile) !== null;
  if (!loopback && !configured) {
    throw new McpHttpConfigError(`Serving on ${opts.host} needs authentication: add a grant with rig mcp token add, then start again. With no grants, the server stays on loopback.`);
  }
  const makeClient = opts.clientFactory ?? ((url: string, sessionName?: string, principal?: McpPrincipal) =>
    new DaemonClient(url, sessionName === undefined ? undefined : { sessionName, ...(principal ? { principal } : {}) }));
  let boundPort = opts.port;
  // A token-file grant's last call, for rig_team's presence. An external caller isn't a team member, so none is kept.
  const presenceFile = nodePath.join(nodePath.dirname(opts.tokenFile), MCP_PRESENCE_FILE);
  const recordCall = presenceRecorder(presenceFile, opts.presenceIntervalMs);
  // Once auth has been configured here, a missing token file is a broken configuration, not a return to local-owner
  // mode: that takes a restart with no file. A beyond-loopback listener always starts with auth.
  let authSeen = configured;
  // The instance a grant key must be bound to: the self id of the daemon whose seats this server acts on, read from that
  // daemon, never from a caller. Kept once known.
  let instance: string | undefined;
  const instanceId = async (): Promise<string | undefined> => {
    if (instance) return instance;
    try {
      const res = await fetch(`${opts.daemonUrl.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(2_000) });
      const self = res.ok ? ((await res.json()) as { selfHostId?: unknown }).selfHostId : undefined;
      if (typeof self === "string" && INSTANCE_ID.test(self)) instance = self;
    } catch { /* Unknown: refused below, and asked again on the next request. */ }
    return instance;
  };
  // A 401 names the realm. With OAuth discovery it also points at the metadata, and says invalid_token when a bearer
  // credential was presented and refused (RFC 6750 §3); a request with none gets no error.
  const refuse = (res: http.ServerResponse, refusal: Refusal, presented = false): void => {
    // The detail stays in this server's log: the reply goes to a caller not yet authenticated.
    if (refusal.log) console.error(`rig mcp serve --http: ${refusal.log}`);
    const challenge = !discovery ? 'Bearer realm="openrig"' : `${discovery.challenge}${presented ? ', error="invalid_token"' : ""}`;
    reply(res, refusal.status, { error: refusal.error, message: refusal.message }, refusal.status === 401 ? { "WWW-Authenticate": challenge } : {});
  };
  // One handler for both protocol revisions: a request carrying 2026-07-28's per-request envelope is served as that
  // revision, anything else (initialize and the rest of 2025) statelessly as before. Each request gets a fresh server for
  // the caller decided below, handed over as the request's authInfo.
  const mcpHandler = createMcpHandler(({ authInfo }) => {
    const caller = (authInfo?.extra as { caller?: RequestCaller } | undefined)?.caller;
    // Never a default seat: a request reaches the handler only with its caller decided.
    if (!caller) throw new Error("a request reached the MCP handler without its caller");
    return createMcpServer(makeClient(opts.daemonUrl, caller.seat, caller.principal), { seat: caller.seat, access: caller.access, presenceFile: () => presenceFile });
  });
  const serveMcp = toNodeHandler(mcpHandler);
  const bearer = (req: http.IncomingMessage): string | undefined => /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
  const NO_BEARER = "This server needs a bearer credential: Authorization: Bearer <token>.";

  /** The caller of one request on a server with a grant service: its key's grant, checked there, for a seat on this
   *  instance. */
  const serviceRequestCaller = async (req: http.IncomingMessage): Promise<{ seat: string; access: McpAccess; principal: McpPrincipal } | Refusal> => {
    const key = bearer(req);
    if (!key) return unauthenticated(NO_BEARER);
    if (!GRANT_KEY.test(key)) return unauthenticated(NOT_VALID_HERE);
    const self = await instanceId();
    if (!self) return unavailable("this daemon reports no self id, so a grant key can't be checked against this instance");
    const caller = await grantServiceCaller(service!, serviceUrl!, key, self);
    if (!("seat" in caller)) return caller;
    // The grant service names the seat; it must already exist here. It's checked, never created.
    try {
      const res = await fetch(`${opts.daemonUrl.replace(/\/+$/, "")}/api/whoami?${new URLSearchParams({ sessionName: caller.seat, compact: "1" }).toString()}`,
        { signal: AbortSignal.timeout(5_000) });
      if (res.status === 404) {
        // whoami knows a seat by its sessions, and a seat created without a launch has none yet: it's then this daemon's
        // node of exactly that name, or it isn't here.
        const node = await nodeSeat(makeClient(opts.daemonUrl), caller.seat);
        if (node === "absent") return { status: 503, error: "seat_unavailable", message: "This connection's seat isn't on this instance yet.", log: `The grant service named seat ${caller.seat}, which this daemon doesn't have` };
        if (node !== "found") return node;
      } else if (!res.ok) return unavailable(`the seat check for ${caller.seat} answered HTTP ${res.status}`);
    } catch (err) {
      return unavailable(`the seat check for ${caller.seat} failed: ${(err as Error).message}`);
    }
    return caller;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    // The OAuth metadata is static and public: served before any credential or grant-service call, whatever the Host.
    if (discovery && req.method === "GET" && pathname === discovery.path) {
      reply(res, 200, discovery.document);
      return;
    }
    if (pathname !== "/mcp") {
      reply(res, 404, { error: "not_found", message: "The MCP endpoint is /mcp." });
      return;
    }
    let access: McpAccess | undefined;
    let seat: string | undefined;
    let principal: McpPrincipal | undefined;
    let authenticated = false;
    if (service) {
      const caller = await serviceRequestCaller(req);
      if (!("seat" in caller)) { refuse(res, caller, bearer(req) !== undefined); return; }
      ({ access, seat, principal } = caller);
      authenticated = true;
    } else {
      let grants: McpGrant[] | null;
      try {
        grants = readGrants(opts.tokenFile);
        if (grants === null && authSeen) throw new Error(`${opts.tokenFile} is gone after auth was configured; restore it, or restart with no token file to serve loopback unauthenticated`);
      } catch (err) {
        // The detail stays in this server's log: the reply goes to a caller not yet authenticated.
        console.error(`rig mcp serve --http: the token file can't be read: ${(err as Error).message}`);
        reply(res, 500, { error: "auth_config_unreadable", message: "The token file can't be read." });
        return;
      }
      if (grants !== null) authSeen = true;
      if (grants !== null) {
        const token = bearer(req);
        const grant = token ? grantFor(grants, token) : null;
        if (!grant) {
          refuse(res, unauthenticated(token ? NOT_VALID_HERE : NO_BEARER));
          return;
        }
        access = { principal: grant.name, owner: grant.owner === true, rigs: grant.rigs ?? [], roots: grant.roots ?? [], workspace: grant.workspace === true };
        seat = grant.seat;
        // A token-file grant has a name and nothing more: no grant id or version is invented for it.
        principal = { source: "file", id: grant.name };
        authenticated = true;
        recordCall(grant.seat, grant.name);
      }
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
    // With no auth (loopback only), refuse a Host that isn't loopback, as a page reaching localhost through DNS rebinding
    // or a forward from elsewhere would send. With auth, the credential is the check, so a tunnel's Host is fine. The SDK's
    // handler checks no Host, so this is the refusal its 1.x transport gave.
    if (!authenticated && ![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(req.headers.host ?? "")) {
      reply(res, 403, { jsonrpc: "2.0", error: { code: -32000, message: `Invalid Host header: ${req.headers.host}` }, id: null });
      return;
    }
    const caller: RequestCaller = { seat, access, principal };
    (req as http.IncomingMessage & { auth?: AuthInfo }).auth = { token: "", clientId: principal?.id ?? "local-owner", scopes: [], extra: { caller } };
    await serveMcp(req, res, body);
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
    close: async () => {
      await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
      await mcpHandler.close();
    },
  };
}
