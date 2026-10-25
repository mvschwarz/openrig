import http from "node:http";
import https from "node:https";

/**
 * Node's fetch (undici) gives up on a response whose headers haven't arrived within 300 s, and a waiting send's response
 * starts only when its wait ends. A request allowed that long goes over node:http instead, which has no headers timeout,
 * so a long `--wait-for-idle` stays one request: one deadline, and the daemon's one binding to the seat's occupant.
 */
export const FETCH_HEADERS_TIMEOUT_MS = 300_000;

/** The subset of fetch the daemon client uses (method, headers, a string body, a signal), over node:http or https. */
export const nodeHttpFetch = ((input: string | URL, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
  const url = new URL(String(input));
  // Through the module objects, not named imports, so a test's request guard sees this call as it sees fetch.
  const transport = url.protocol === "https:" ? https : http;
  const request = transport.request(url, {
    method: init?.method ?? "GET",
    headers: init?.headers as Record<string, string> | undefined,
    signal: init?.signal ?? undefined,
    agent: false,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("error", reject);
    res.on("end", () => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const one of [value ?? []].flat()) headers.append(name, one);
        const status = res.statusCode ?? 0;
        const body = [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks));
        resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
      } catch (err) {
        reject(err);
      }
    });
  });
  request.on("error", reject);
  request.end(typeof init?.body === "string" ? init.body : undefined);
})) as typeof fetch;
