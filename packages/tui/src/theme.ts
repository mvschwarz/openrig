// Theme layer — the LOCKED mockup's visual treatment (baseline tarball
// d3f3bf9c, artifact e99e3b32 .tui CSS) mapped to terminal color, with sane
// degradation: truecolor renders the exact mockup palette, 256-color the
// nearest xterm cubes, 16-color the classic SGR set, and none (NO_COLOR /
// --no-color / dumb term) renders plain text. Presentation only — nothing
// here touches layout, state, or the resolver.

export type ColorMode = "truecolor" | "256" | "16" | "none";

export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env["NO_COLOR"] != null && env["NO_COLOR"] !== "") return "none";
  const term = env["TERM"] ?? "";
  if (term === "dumb" || term === "") return "none";
  const colorterm = env["COLORTERM"] ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return "truecolor";
  if (/256color/.test(term)) return "256";
  return "16";
}

/** Semantic tokens — named for meaning, not color, so views stay honest. */
export type Token =
  | "accent" // selection/links/active (mockup teal #4dbdb2)
  | "accentBright" // tree/link emphasis (mockup #7bd3ca)
  | "warn" // blocked/needs-you/alerts (mockup amber #e6b56e)
  | "error" // failed/error states
  | "ok" // healthy/running states
  | "dim" // secondary text (mockup #6d7480)
  | "bright" // primary emphasis
  | "chrome" // borders/rules
  // S19 MR2 — web-identical runtime-mark colors (RuntimeMark.tsx values);
  // 16-color values are PLACEHOLDERS pending the founder degrade pick (mr7)
  | "clawd" // clawd body #ad6755
  | "clawdEye" // clawd eyes #181818
  | "markInk" // codex `>_` ink (light)
  | "markBg"; // terminal mark dark cell

// [truecolor rgb, 256 index, 16-color SGR]
const PALETTE: Record<Token, [[number, number, number], number, number]> = {
  accent: [[77, 189, 178], 73, 36],
  accentBright: [[123, 211, 202], 80, 96],
  warn: [[230, 181, 110], 179, 33],
  error: [[224, 108, 117], 167, 31],
  ok: [[152, 195, 121], 108, 32],
  dim: [[109, 116, 128], 243, 90],
  bright: [[232, 234, 240], 254, 97],
  chrome: [[58, 63, 75], 238, 90],
  clawd: [[173, 103, 85], 131, 31],
  clawdEye: [[24, 24, 24], 234, 30],
  markInk: [[250, 250, 249], 255, 97],
  markBg: [[12, 10, 9], 233, 30],
};

export interface Style {
  /** wrap text in the token's SGR (plus bold/inverse); identity in "none" mode */
  paint(token: Token, text: string, opts?: { bold?: boolean; inverse?: boolean; bg?: Token }): string;
  readonly mode: ColorMode;
}

export function createStyle(mode: ColorMode = detectColorMode()): Style {
  function open(token: Token, opts?: { bold?: boolean; inverse?: boolean; bg?: Token }): string {
    if (mode === "none") return "";
    const parts: string[] = [];
    if (opts?.bold) parts.push("1");
    if (opts?.inverse) parts.push("7");
    const [rgb, x256, basic] = PALETTE[token];
    if (mode === "truecolor") parts.push(`38;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
    else if (mode === "256") parts.push(`38;5;${x256}`);
    else parts.push(String(basic));
    if (opts?.bg) {
      const [brgb, b256] = PALETTE[opts.bg];
      if (mode === "truecolor") parts.push(`48;2;${brgb[0]};${brgb[1]};${brgb[2]}`);
      else if (mode === "256") parts.push(`48;5;${b256}`);
      // 16-color: no bg (placeholder-safe degrade; mr7 carries the question)
    }
    return `\x1b[${parts.join(";")}m`;
  }
  return {
    mode,
    paint(token, text, opts) {
      if (mode === "none" || text === "") return text;
      return `${open(token, opts)}${text}\x1b[0m`;
    },
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** The stylize invariant: stripping a styled line returns the plain line —
 * styling can never change layout, widths, or hit coordinates. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
