import { HttpsProxyAgent } from "https-proxy-agent";
import { nodeHttpFetch } from "./long-request-fetch.js";

/** Only the configured daemon origin opts into the sandbox's supplied proxy. The sandbox runtime sets
 * SANDBOX_RUNTIME=1 alongside HTTP(S)_PROXY and a loopback NO_PROXY that would otherwise select an unreachable
 * direct socket. The proxy still decides whether the daemon host/port is allowed; never retry outside it. */
export function daemonFetch(baseUrl: string, direct: typeof fetch = fetch): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (process.env.SANDBOX_RUNTIME !== "1" || url.origin !== origin) return direct(input, init);
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
      throw new TypeError("The sandbox's daemon proxy must be a valid HTTP(S) URL.");
    }
    init?.signal?.throwIfAborted();
    // One agent per call: the caller's signal also cancels the proxy socket while CONNECT is pending.
    // This explicit CONNECT adapter works at Node 22's floor, without changing global agents or proxy variables.
    const options = { keepAlive: false, signal: init?.signal ?? undefined };
    const agent = proxy.protocol === "https:"
      ? new HttpsProxyAgent<"https:">(proxy, options)
      : new HttpsProxyAgent<"http:">(proxy, options);
    return nodeHttpFetch(input, init, agent);
  };
}
