/** The supported ESM entry for embedding the existing HTTP MCP endpoint.
 * Importing this module does not start a server or a daemon; the caller owns start/close.
 */
export { startMcpHttpServer, McpHttpConfigError } from "./mcp-http.js";
export type { McpHttpOptions, McpPrincipal, McpGrant, GrantServiceOptions } from "./mcp-http.js";
export type { McpAccess } from "./mcp-server.js";
export type { CallerResolver, CallerResolution } from "./mcp-caller-resolver.js";
