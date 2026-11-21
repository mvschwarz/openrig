export const MISSION_CONTROL_BEARER_STORAGE_KEY = "openrig.missionControlBearerToken";
export const TERMINAL_BEARER_STORAGE_KEY = "openrig.terminalBearerToken";

const TOKEN_QUERY_KEYS = ["mcToken", "mc_token"];
const TERMINAL_TOKEN_QUERY_KEYS = ["termToken", "term_token"];

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

/** Keep a token the address gave in this browser. Storage that refuses it (blocked, or full) leaves the token unset;
 *  the page still loads and the address is still cleaned. */
function storeToken(key: string, token: string | undefined): void {
  if (!token) return;
  try {
    window.localStorage.setItem(key, token);
  } catch {
    // The protected actions are then refused (401), as they are with no token stored.
  }
}

export function primeMissionControlBearerTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);

  const tokenKey = TOKEN_QUERY_KEYS.find((key) => url.searchParams.has(key));
  const termKey = TERMINAL_TOKEN_QUERY_KEYS.find((key) => url.searchParams.has(key));
  if (!tokenKey && !termKey) return;

  if (tokenKey) {
    storeToken(MISSION_CONTROL_BEARER_STORAGE_KEY, url.searchParams.get(tokenKey)?.trim());
    for (const key of TOKEN_QUERY_KEYS) url.searchParams.delete(key);
  }
  if (termKey) {
    storeToken(TERMINAL_BEARER_STORAGE_KEY, url.searchParams.get(termKey)?.trim());
    for (const key of TERMINAL_TOKEN_QUERY_KEYS) url.searchParams.delete(key);
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}
