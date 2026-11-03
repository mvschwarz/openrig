// OPR.0.4.3.29 — theme SELECTOR (N-theme system, not a binary toggle).
//
// A native <select> over the theme registry — a selector, extensible to more
// themes by adding a token block + a registry entry (no edits here). Placement:
// the AppShell topbar right-slot (founder taste-gates final form/placement;
// provisional per PRD open question). Token-styled so it themes with the app.

import { useTheme } from "./ThemeProvider.js";
import type { ThemeId } from "../lib/theme.js";

export function ThemeSelector() {
  const { theme, themes, setTheme } = useTheme();
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Theme</span>
      <select
        data-testid="theme-selector"
        aria-label="Theme"
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeId)}
        className="h-8 rounded-md border border-outline-variant bg-background px-2 text-xs text-on-surface-variant hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
