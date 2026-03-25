import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "./index.html"],
  theme: {
    // Zero ALL border radii — hard edges everywhere
    borderRadius: {
      none: "0px",
      sm: "0px",
      DEFAULT: "0px",
      md: "0px",
      lg: "0px",
      xl: "0px",
      "2xl": "0px",
      "3xl": "0px",
      full: "0px",
    },
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        "foreground-muted": "hsl(var(--foreground-muted))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          dark: "hsl(var(--primary-dark))",
          foreground: "hsl(var(--primary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        warning: "hsl(var(--warning))",
        accent: "hsl(var(--accent))",
        surface: {
          low: "hsl(var(--surface-low))",
          DEFAULT: "hsl(var(--surface))",
          high: "hsl(var(--surface-high))",
        },
        "ghost-border": "var(--ghost-border)",
      },
      fontFamily: {
        inter: ["Inter", "system-ui", "sans-serif"],
        grotesk: ["Space Grotesk Variable", "monospace"],
        mono: ["JetBrains Mono Variable", "monospace"],
      },
      spacing: {
        "spacing-1": "4px",
        "spacing-2": "8px",
        "spacing-3": "12px",
        "spacing-4": "16px",
        "spacing-6": "24px",
        "spacing-8": "32px",
        "spacing-12": "48px",
        "spacing-16": "64px",
        "spacing-24": "96px",
      },
      fontSize: {
        "display-lg": ["3.5rem", { lineHeight: "1.1", fontWeight: "700", letterSpacing: "-0.02em" }],
        "headline-lg": ["2rem", { lineHeight: "1.2", fontWeight: "600", letterSpacing: "0.05em" }],
        "headline-md": ["1.5rem", { lineHeight: "1.3", fontWeight: "600" }],
        "body-lg": ["1.125rem", { lineHeight: "1.5", fontWeight: "400" }],
        "body-md": ["1rem", { lineHeight: "1.5", fontWeight: "400" }],
        "body-sm": ["0.875rem", { lineHeight: "1.5", fontWeight: "400" }],
        "label-lg": ["0.875rem", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.02em" }],
        "label-md": ["0.75rem", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.04em" }],
        "label-sm": ["0.625rem", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.06em" }],
      },
      transitionTimingFunction: {
        tactical: "cubic-bezier(0.2, 0, 0, 1)",
      },
      transitionDuration: {
        "150": "150ms",
        "250": "250ms",
      },
    },
  },
  plugins: [],
};

export default config;
