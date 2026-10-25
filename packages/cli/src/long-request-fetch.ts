import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/**
 * Node's fetch (undici) gives up on a response whose headers haven't arrived within 300 s, and a waiting send's response
 * starts only when its wait ends. A request allowed that long goes over node:http instead, which has no headers timeout,
 * so a long `--wait-for-idle` stays one request: one deadline, and the daemon's one binding to the seat's occupant.
 */
export const FETCH_HEADERS_TIMEOUT_MS = 300_000;

/** The subset of fetch the daemon client uses (method, headers, a string body, a signal), over node:http or https. */
export const nodeHttpFetch = ((input: string | URL, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
  // Only a string body is sent; any other is refused rather than sent empty.
  const body = init?.body;
  if (body != null && typeof body !== "string") {
    reject(new TypeError("This request path sends only a string body."));
    return;
  }
  const url = new URL(String(input));
  // Through the module objects, not named imports, so a test's request guard sees this call as it sees fetch.
  const transport = url.protocol === "https:" ? https : http;
  const request = transport.request(url, {
    method: init?.method ?? "GET",
    headers: init?.headers as Record<string, string> | undefined,
    signal: init?.signal ?? undefined,
    agent: false,
  }, (res) => {
    // Returned when the headers arrive, as fetch does, with the body still to read: a body lost after that is a failed
    // read of an answer the daemon sent, never a request that didn't arrive.
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) for (const one of [value ?? []].flat()) headers.append(name, one);
      const status = res.statusCode ?? 0;
      const noBody = [204, 205, 304].includes(status);
      if (noBody) res.on("error", () => {}).resume();
      resolve(new Response(noBody ? null : Readable.toWeb(res) as unknown as ConstructorParameters<typeof Response>[0], { status, statusText: res.statusMessage, headers }));
    } catch (err) {
      res.destroy();
      reject(err);
    }
  });
  request.on("error", reject);
  request.end(body ?? undefined);
})) as typeof fetch;
