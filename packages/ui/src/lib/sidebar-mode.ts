// ui-redesign C06: sidebar collapse mode persisted in localStorage.

export type SidebarMode = "auto" | "expanded" | "collapsed";

export const SIDEBAR_MODE_STORAGE_KEY = "openrig.sidebar.mode";

/** Folded sidebar section ids, persisted as a JSON array. */
export const SIDEBAR_FOLDED_STORAGE_KEY = "openrig.sidebar.folded";

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Safari private mode throws on localStorage access.
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Safari private mode throws on localStorage access.
  }
}

function readStored(key: string): string | null {
  return typeof window === "undefined" ? null : safeGet(key);
}

function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  safeSet(key, value);
}

export function readSidebarMode(): SidebarMode {
  const raw = readStored(SIDEBAR_MODE_STORAGE_KEY);
  if (raw === "auto" || raw === "expanded" || raw === "collapsed") return raw;
  return "auto";
}

export function writeSidebarMode(mode: SidebarMode): void {
  writeStored(SIDEBAR_MODE_STORAGE_KEY, mode);
}

export function readFoldedSections(): string[] {
  const raw = readStored(SIDEBAR_FOLDED_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function writeFoldedSections(ids: string[]): void {
  writeStored(SIDEBAR_FOLDED_STORAGE_KEY, JSON.stringify(ids));
}

/** auto: collapsed when an Explorer column is visible on desktop, expanded otherwise. */
export function isSidebarCollapsed(mode: SidebarMode, explorerVisible: boolean): boolean {
  if (mode === "collapsed") return true;
  if (mode === "expanded") return false;
  return explorerVisible;
}
