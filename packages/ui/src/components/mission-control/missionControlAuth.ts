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

export function primeMissionControlBearerTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);

  const tokenKey = TOKEN_QUERY_KEYS.find((key) => url.searchParams.has(key));
  const termKey = TERMINAL_TOKEN_QUERY_KEYS.find((key) => url.searchParams.has(key));
  if (!tokenKey && !termKey) return;

  if (tokenKey) {
    const token = url.searchParams.get(tokenKey)?.trim();
    if (token) window.localStorage.setItem(MISSION_CONTROL_BEARER_STORAGE_KEY, token);
    for (const key of TOKEN_QUERY_KEYS) url.searchParams.delete(key);
  }
  if (termKey) {
    const token = url.searchParams.get(termKey)?.trim();
    if (token) window.localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, token);
    for (const key of TERMINAL_TOKEN_QUERY_KEYS) url.searchParams.delete(key);
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}
