// OPR.0.4.3.29 — ThemeProvider + useTheme.
//
// Holds the active theme choice, applies it to <html> (via applyTheme), persists
// explicit choices to localStorage, and — while the choice is `system` — subscribes
// to `prefers-color-scheme` so an OS flip re-resolves live. The matchMedia
// subscribe/init/cleanup shape mirrors usePrefersReducedMotion; the localStorage
// idiom mirrors useDismissedSeqs (lazy init + try/catch swallow).
//
// The pre-paint script in index.html already set the correct class before first
// paint (no FOUC); this provider re-asserts the same resolution on mount and keeps
// it in sync thereafter.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTheme,
  COLOR_SCHEME_QUERY,
  DEFAULT_THEME,
  readStoredTheme,
  resolveTheme,
  THEMES,
  writeStoredTheme,
  type ResolvedTheme,
  type ThemeId,
  type ThemeOption,
} from "../lib/theme.js";

interface ThemeContextValue {
  /** The persisted choice (light / dark / system). */
  theme: ThemeId;
  /** The concrete palette currently applied (light or dark). */
  resolved: ResolvedTheme;
  /** The available themes (drives the selector). */
  themes: readonly ThemeOption[];
  /** Set + persist an explicit choice; applies immediately. */
  setTheme: (theme: ThemeId) => void;
}

// Functional standalone default so a bare <ThemeSelector/> (e.g. AppShell rendered
// in a test without the root provider) still persists + applies rather than
// throwing. Production always wraps <App/> in <ThemeProvider> (main.tsx), which
// supplies the reactive value below.
const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolved: "light",
  themes: THEMES,
  setTheme: (next: ThemeId) => {
    writeStoredTheme(next);
    applyTheme(next);
  },
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    writeStoredTheme(next);
    applyTheme(next);
    setResolved(resolveTheme(next));
  }, []);

  // Apply on mount + whenever the choice changes (re-asserts the pre-paint class).
  useEffect(() => {
    applyTheme(theme);
    setResolved(resolveTheme(theme));
  }, [theme]);

  // While following the OS (`system`), re-resolve when the OS preference flips.
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const onChange = () => {
      applyTheme("system");
      setResolved(resolveTheme("system"));
    };
    mediaQuery.addEventListener?.("change", onChange);
    return () => mediaQuery.removeEventListener?.("change", onChange);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, themes: THEMES, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
