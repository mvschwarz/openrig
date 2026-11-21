export const MISSION_CONTROL_BEARER_STORAGE_KEY = "openrig.missionControlBearerToken";
export const TERMINAL_BEARER_STORAGE_KEY = "openrig.terminalBearerToken";

const TOKEN_KEYS = ["mcToken", "mc_token"];
const TERMINAL_TOKEN_KEYS = ["termToken", "term_token"];

export function readMissionControlBearerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.localStorage.getItem(MISSION_CONTROL_BEARER_STORAGE_KEY);
    const trimmed = token?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export function missionControlAuthHeaders(): Record<string, string> {
  const token = readMissionControlBearerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function readTerminalBearerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.localStorage.getItem(TERMINAL_BEARER_STORAGE_KEY);
    const trimmed = token?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export function terminalAuthHeaders(): Record<string, string> {
  const token = readTerminalBearerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Keep a token the address gave in this browser. Storage that refuses it (blocked, or full) keeps what it held before,
 *  a token or none; the page still loads and the address is still cleaned. */
function storeToken(key: string, token: string | undefined): void {
  if (!token) return;
  try {
    window.localStorage.setItem(key, token);
  } catch {
    // The protected actions then use whatever this browser already held.
  }
}

/** The tokens come in the address's fragment, `#termToken=…&mcToken=…`, which a browser keeps to itself: it never sends
 *  a fragment in a request or in a Referer. Only the token parts are taken out; the path, the query and any other part
 *  of the fragment stay as they are. */
export function primeMissionControlBearerTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const fragment = window.location.hash.replace(/^#/, "");
  if (!fragment) return;

  let missionControl: string | undefined;
  let terminal: string | undefined;
  let found = false;
  const kept: string[] = [];
  for (const part of fragment.split("&")) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at);
    const isMissionControl = TOKEN_KEYS.includes(key);
    if (!isMissionControl && !TERMINAL_TOKEN_KEYS.includes(key)) { kept.push(part); continue; }
    found = true;
    let value = "";
    // A raw `+` stays a `+`: a token may contain one.
    try { value = decodeURIComponent(at < 0 ? "" : part.slice(at + 1)).trim(); } catch { /* not a token */ }
    if (isMissionControl) missionControl = value; else terminal = value;
  }
  if (!found) return;

  storeToken(MISSION_CONTROL_BEARER_STORAGE_KEY, missionControl);
  storeToken(TERMINAL_BEARER_STORAGE_KEY, terminal);
  const rest = kept.join("&");
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`);
}
