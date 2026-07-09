// OPR.0.4.6.MH2 FR-2 — the host envelope on the UI's read paths.
//
// The selected hostId rides the query string (`?host=<id>`) of the SAME
// same-origin endpoints; the LOCAL daemon's read-through edge consumes the
// envelope and forwards allowlisted GETs to the selected host's daemon
// (bearers stay server-side — the browser never learns a remote base URL
// or credential). Origin response shapes are verbatim, so the consuming
// hooks keep their existing types; only their query keys gain the hostId.
//
// THE ZERO-REGRESSION NEGATIVE LIVES HERE: for the local host (or an
// absent selection) `withHostParam` returns the input path UNCHANGED — no
// new fetch path exists on the local leg by construction (FR-2).

/** UI copy of the daemon's LOCAL_HOST_ID (fanout-contract.ts). */
export const LOCAL_HOST_ID = "local";

export function withHostParam(path: string, hostId: string | undefined): string {
  if (hostId === undefined || hostId === "" || hostId === LOCAL_HOST_ID) return path;
  return `${path}${path.includes("?") ? "&" : "?"}host=${encodeURIComponent(hostId)}`;
}
