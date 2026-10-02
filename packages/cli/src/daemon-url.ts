import { isIP } from "node:net";

/** Build a daemon URL from a bind/config host, preserving existing URL brackets. */
export function daemonUrl(host: string, port: number | undefined): string {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}
