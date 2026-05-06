// V1 attempt-3 Phase 3 — host label utility per code-map AFTER tree.
//
// Formats the env / host label for the Dashboard header. V1 = single
// localhost; multi-host envelope is V2 deferred.

export function formatHostLabel(): string {
  if (typeof window === "undefined") return "openrig @ localhost";
  return `openrig @ ${window.location.hostname || "localhost"}`;
}
