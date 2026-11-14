/** Starting a local instance must never silently target the default daemon or
 * launch kernel occupants before the user has selected them. */
export function daemonStartArgs(target: string): string[] {
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("This target is not a local daemon endpoint. Reconnect after its owner starts it; no local daemon was started.");
  }
  // The daemon's default bind already listens on 127.0.0.1, with Tailscale beside it when present; naming that host would
  // make it the only listener. Another loopback spelling isn't in the default bind, so it's still named.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return ["daemon", "start", "--no-kernel", ...(host === "127.0.0.1" ? [] : ["--host", host]), "--port", url.port || "80"];
}
