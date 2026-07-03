// OPR.0.4.3.29 — dashboard theming (light + dark, extensible).
//
// A theme is a set of CSS-variable token values applied by a class on <html>.
// Light is the current `:root` token set (globals.css); dark is a `.dark {}`
// block re-declaring the same names (Vellum Dark). Because every component
// styles via `hsl(var(--token))`, toggling the `.dark` class flips the whole
// dashboard through the cascade — no per-component work.
//
// This module is the single source of truth for the theme registry + storage
// key + resolution logic. The inline pre-paint script in index.html MUST mirror
// THEME_STORAGE_KEY and the resolve rules exactly (light/dark are explicit and
// win over the OS; `system` follows prefers-color-scheme) so the class is on
// <html> before first paint (no flash-of-wrong-theme).

/** localStorage key. Shared verbatim with the index.html pre-paint script. */
export const THEME_STORAGE_KEY = "openrig.theme";

/** The dashboard-scoped OS color-scheme query used by `system`. */
export const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** A selectable theme. `light`/`dark` are explicit choices; `system` follows the OS. */
export type ThemeId = "light" | "dark" | "system";

/** The two concrete palettes a theme resolves to (the class applied to <html>). */
export type ResolvedTheme = "light" | "dark";

export interface ThemeOption {
  id: ThemeId;
  label: string;
}

/**
 * The theme registry that drives the selector. Adding a future theme = add a
 * `.dark`-style token block + one entry here — NO component edits (extensibility
 * AC). Only light + dark ship as concrete palettes this slice; `system` is a
 * resolver over the two, not a third palette.
 */
export const THEMES: readonly ThemeOption[] = [
  { id: "light", label: "Vellum Light" },
  { id: "dark", label: "Vellum Dark" },
  { id: "system", label: "System" },
] as const;

/** No stored choice → follow the OS (`system`). */
export const DEFAULT_THEME: ThemeId = "system";

function isThemeId(value: unknown): value is ThemeId {
  return value === "light" || value === "dark" || value === "system";
}

/** Read the persisted choice; falls back to DEFAULT_THEME when unset/malformed. */
export function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(raw)) return raw;
  } catch {
    // localStorage may be unavailable (private mode, quota) — swallow.
  }
  return DEFAULT_THEME;
}

/** Persist the explicit choice. */
export function writeStoredTheme(theme: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Swallow — persistence is best-effort.
  }
}

/** Whether the OS currently prefers dark. */
export function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COLOR_SCHEME_QUERY).matches;
}

/** Resolve a theme choice to the concrete palette. `system` follows the OS. */
export function resolveTheme(theme: ThemeId): ResolvedTheme {
  if (theme === "system") return prefersDark() ? "dark" : "light";
  return theme;
}

/** Apply the resolved palette by toggling the `.dark` class on <html>. */
export function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark");
}
