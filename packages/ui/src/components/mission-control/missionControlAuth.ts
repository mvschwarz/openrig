export const MISSION_CONTROL_BEARER_STORAGE_KEY = "openrig.missionControlBearerToken";

const TOKEN_QUERY_KEYS = ["mcToken", "mc_token"];

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

export function primeMissionControlBearerTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const tokenKey = TOKEN_QUERY_KEYS.find((key) => url.searchParams.has(key));
  if (!tokenKey) return;

  const token = url.searchParams.get(tokenKey)?.trim();
  for (const key of TOKEN_QUERY_KEYS) {
    url.searchParams.delete(key);
  }
  if (token) {
    window.localStorage.setItem(MISSION_CONTROL_BEARER_STORAGE_KEY, token);
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}
