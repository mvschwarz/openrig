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

function externalAbortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "The request was aborted.");
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
    throw externalAbortError(externalSignal.reason);
  }
  // Compose signals without retaining a listener on the caller's signal; streams can outlive the fetch promise.
  const requestSignal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

  try {
    const response = await fetchImpl(url, { ...init, signal: requestSignal });
    await options.consumeResponse?.(response);
    return response;
  } catch (err) {
    if (err instanceof FetchTimeoutError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      if (requestSignal.reason instanceof Error) throw requestSignal.reason;
      if (externalSignal?.aborted) throw externalAbortError(requestSignal.reason);
      throw new FetchTimeoutError(options.timeoutMessage);
    }
    if (externalSignal?.aborted && err === externalSignal.reason && !(err instanceof Error)) {
      throw externalAbortError(err);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
