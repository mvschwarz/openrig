// The NARROW `@openrig/daemon/crash-cart` public surface (packaging ruling A, rail 1): ONLY the
// crash-cart read / emit / detect — never a blanket daemon export (accidental-public-API guard).
// Consumed by the `rig crash-cart --json` verb (lazy-imported at invocation, dep rail 2). The C2 read
// (loadCrashCartDiscovery) is re-exported VERBATIM (coupling rail 2 — a single impl, not a parallel one).
export * from "./domain/crash-cart-discovery.js";
export * from "./domain/crash-cart-detect.js";
export * from "./domain/crash-cart-probes.js";
export * from "./domain/crash-cart-emit.js";
