import type { CmuxTransportFactory } from "./cmux.js";

/**
 * Production CmuxTransportFactory.
 * Phase 1 stub: cmux socket protocol is not yet implemented.
 * Throws ENOENT so CmuxAdapter degrades to { available: false } cleanly.
 */
export function createCmuxTransportFactory(): CmuxTransportFactory {
  return async () => {
    const err = new Error(
      "cmux socket transport not yet implemented (Phase 1 stub)"
    ) as Error & { code?: string };
    err.code = "ENOENT";
    throw err;
  };
}
