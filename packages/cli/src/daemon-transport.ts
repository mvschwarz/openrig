import { HttpsProxyAgent, type HttpsProxyAgentOptions } from "https-proxy-agent";
import type { ClientRequest } from "node:http";
import { nodeHttpFetch } from "./long-request-fetch.js";

/** A failed proxy connection is not evidence that the daemon answered or stopped. */
export class SandboxProxyError extends Error {
  readonly code = "ESANDBOXPROXY";
  constructor(message: string) {
    super(message);
    this.name = "SandboxProxyError";
  }
}

class SandboxProxyAgent<Uri extends string> extends HttpsProxyAgent<Uri> {
  constructor(proxy: URL, options: HttpsProxyAgentOptions<Uri>, private readonly daemon: string,
    private readonly callerSignal: AbortSignal | undefined) {
    super(proxy, options);
  }

  override async connect(req: ClientRequest, options: Parameters<HttpsProxyAgent<string>["connect"]>[1]) {
    let status: number | undefined;
    const onConnect = (response: { statusCode: number }) => { status = response.statusCode; };
    req.once("proxyConnect", onConnect);
    try {
      const socket = await super.connect(req, options);
      if (status !== undefined && status !== 200) {
        // The library has closed the real proxy socket and returned a replay socket. Discard that response before
        // node:http can mistake it for a daemon reply; let the agent reject the request through its normal callback.
        socket.destroy();
        throw new SandboxProxyError(`Sandbox proxy refused CONNECT (HTTP ${status}) for daemon ${this.daemon}; no daemon request was sent.`);
      }
      return socket;
    } catch (error) {
      if (error instanceof SandboxProxyError || this.callerSignal?.aborted) throw error;
      // Do not retain ECONNREFUSED as the daemon's cause, or expose a proxy URL/parser message with credentials.
      throw new SandboxProxyError(`Sandbox proxy could not establish CONNECT for daemon ${this.daemon}.`);
    } finally {
      req.removeListener("proxyConnect", onConnect);
    }
  }
}

/** Only the configured daemon origin opts into the sandbox's supplied proxy. The sandbox runtime sets
 * SANDBOX_RUNTIME=1 alongside HTTP(S)_PROXY and a loopback NO_PROXY that would otherwise select an unreachable
 * direct socket. The proxy still decides whether the daemon host/port is allowed; never retry outside it. */
export function daemonFetch(baseUrl: string, direct: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (process.env.SANDBOX_RUNTIME !== "1") return direct(input, init);
    let target: URL, url: URL;
    try {
      target = new URL(baseUrl);
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      // Keep invalid explicit targets with their existing transport; construction and MCP startup must not throw.
      return direct(input, init);
    }
    if (url.origin !== target.origin || (url.protocol !== "http:" && url.protocol !== "https:")) return direct(input, init);
    const value = url.protocol === "https:"
      ? process.env.https_proxy || process.env.HTTPS_PROXY
      : process.env.http_proxy || process.env.HTTP_PROXY;
    if (!value) return direct(input, init);
    let proxy: URL;
    try {
      proxy = new URL(value);
      if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new TypeError();
    } catch {
      // Proxy URLs can contain credentials. Do not include the value or URL parser error in diagnostics.
      console.warn("The sandbox daemon proxy URL is invalid; keeping the caller's transport.");
      return direct(input, init);
    }
    init?.signal?.throwIfAborted();
    // One agent per call: the caller's signal also cancels the proxy socket while CONNECT is pending.
    // This explicit CONNECT adapter works at Node 22's floor, without changing global agents or proxy variables.
    const daemon = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    const options = { keepAlive: false, signal: init?.signal ?? undefined };
    const agent = proxy.protocol === "https:"
      ? new SandboxProxyAgent<"https:">(proxy, options, daemon, options.signal)
      : new SandboxProxyAgent<"http:">(proxy, options, daemon, options.signal);
    return nodeHttpFetch(input, init, agent);
  };
}
