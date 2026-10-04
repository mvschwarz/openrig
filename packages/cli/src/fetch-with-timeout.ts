export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export interface FetchWithTimeoutOptions {
  timeoutMs: number;
  timeoutMessage: string;
  /** Consume finite response bodies before releasing the request deadline. */
  consumeResponse?: (response: Response) => Promise<void>;
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new FetchTimeoutError(options.timeoutMessage)), options.timeoutMs);
  const externalSignal = init.signal;

  if (externalSignal?.aborted) {
    clearTimeout(timeout);
    throw externalSignal.reason instanceof Error
      ? externalSignal.reason
      : new Error(typeof externalSignal.reason === "string" ? externalSignal.reason : "The request was aborted.");
  }
  // Native composition keeps streaming cancellation alive after headers without
  // retaining one explicit listener per request on a reused caller signal.
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  try {
    const response = await fetchImpl(url, { ...init, signal });
    await options.consumeResponse?.(response);
    return response;
  } catch (err) {
    if (err instanceof FetchTimeoutError) throw err;
    if (externalSignal?.aborted && signal.reason === externalSignal.reason) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new Error(typeof externalSignal.reason === "string" ? externalSignal.reason : "The request was aborted.");
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw signal.reason instanceof Error
        ? signal.reason
        : new FetchTimeoutError(options.timeoutMessage);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
