// Stylize pass — pro-dev-tool treatment (founder directive, k9s class) applied
// AFTER layout: renderScreen stays the tested plain layer (layout + hitMap);
// this pass only injects zero-width SGR sequences. INVARIANT (test-pinned):
// stripAnsi(styled[i]) === plain[i] for every line — styling can never move a
// hit target or shear a frame. Segment-painted (no nested wraps), so resets
// never bleed.
import type { Screen } from "./types.js";
import type { Style } from "./theme.js";

const EXPL_W = 30;

const STATUS_TOKENS: Array<[RegExp, "ok" | "warn" | "error" | "dim"]> = [
  [/\b(running|active|ready|verified)\b/g, "ok"],
  [/\b(needs-attention|attention_required|recoverable|detached|blocked|parked|degraded)\b/g, "warn"],
  [/\b(failed|down|unreachable|crashed|rejected)\b/g, "error"],
  [/\b(unknown|idle|stopped|pending)\b/g, "dim"],
];

const LINK_RE = /(run ▸|term ▸|open ▸|\(open: [^)]+\)|\[ (?:TABLE|OVERVIEW|TOPOLOGY|CONFIGURATION|YAML) \])/g;

function paintInline(text: string, s: Style): string {
  let out = text;
  for (const [re, token] of STATUS_TOKENS) out = out.replace(re, (m) => s.paint(token, m));
  out = out.replace(LINK_RE, (m) => s.paint("accent", m, { bold: true }));
  return out;
}

function paintExplorer(text: string, s: Style, focused: boolean): string {
  // pm-approved: the unfocused pane's selection bar dims (k9s/editor standard)
  if (text.startsWith("›")) return s.paint(focused ? "accent" : "dim", text, { inverse: true, bold: focused });
  if (/[▾▸] (TOPOLOGY|SPECS|NEEDS-YOU)/.test(text)) return s.paint("bright", text, { bold: true });
  if (text.includes("⚑")) return s.paint("warn", text);
  if (/\(unreachable\)/.test(text)) {
    const at = text.indexOf("(unreachable)");
    return text.slice(0, at) + s.paint("error", "(unreachable)") + text.slice(at + "(unreachable)".length);
  }
  if (/\((recoverable|degraded|stopped|attention_required)\)/.test(text)) {
    return text.replace(/\((recoverable|degraded|stopped|attention_required)\)/, (m) => s.paint("warn", m));
  }
  return text;
}

/** alert line with in-row hierarchy: glyph+kind toned, host dim, target
 * bright, detail dim, link accent — same fact, same place, same color. */
function paintAlertLine(text: string, token: "warn" | "error", s: Style): string {
  const openAt = text.indexOf("(open ▸)");
  const body = openAt >= 0 ? text.slice(0, openAt) : text;
  const suffix = openAt >= 0 ? s.paint("accent", "(open ▸)", { bold: true }) + text.slice(openAt + "(open ▸)".length) : "";
  const cols = body.match(/^(\s*[⚑☐✖] )(\S+\s+)(\[[^\]]*\]\s+)?(\S+\s+)(.*)$/);
  if (!cols)
    return s.paint(token, body) + suffix;
  return (
    s.paint(token, cols[1]! + cols[2]!) +
    (cols[3] ? s.paint("dim", cols[3]) : "") +
    s.paint("bright", cols[4]!) +
    s.paint("dim", cols[5] ?? "") +
    suffix
  );
}

function paintContent(text: string, s: Style): string {
  if (text.trim() === "") return text;
  if (/\bRIG\b.*\bAGENT\b.*\bSTATUS\b/.test(text)) return s.paint("accentBright", text, { bold: true });
  if (/\bNODE\b.*\bLABEL\b.*\bRUNTIME\b/.test(text)) return s.paint("accentBright", text, { bold: true });
  // detail vocabulary: section rule "  ── title ────"
  const rule = text.match(/^( {2})── (.+?) (─+)$/);
  if (rule) return `${rule[1]}${s.paint("chrome", "──")} ${s.paint("bright", rule[2]!, { bold: true })} ${s.paint("chrome", rule[3]!)}`;
  // detail vocabulary: field row "  label:      value" → dim label, inline-painted value
  const field = text.match(/^( {2})([a-z][a-z0-9 -]{0,14}:)( +)(\S.*)$/);
  if (field) return `${field[1]}${s.paint("dim", field[2]!)}${field[3]}${paintInline(field[4]!, s)}`;
  if (/^(SPEC LIBRARY|NEEDS-YOU|agent spec |rig spec |agent |seats running spec )/.test(text.trimStart()) && !text.includes("│"))
    return paintTitleLine(text, s);
  if (/^\s*\/ filter/.test(text)) return s.paint("dim", text);
  if (/^\s*─+$/.test(text)) return s.paint("chrome", text);
  if (text.includes("⚑")) return paintAlertLine(text, "warn", s);
  if (text.includes("✖")) return paintAlertLine(text, "error", s);
  if (/hosts\/rigs down:/.test(text)) return s.paint("warn", text, { bold: true });
  if (/human-queue:|honest-empty|read pending|proven empty|not in the current snapshot|library read pending/.test(text))
    return s.paint("dim", text);
  if (/^\s*(source|attach):/.test(text)) return s.paint("dim", text);
  if (/^\s*content ↑\/↓/.test(text)) return s.paint("dim", text);
  return paintInline(text, s);
}

function paintTitleLine(text: string, s: Style): string {
  // headings: bright-bold the heading token, leave the rest to inline painting
  const m = text.match(/^(\s*)(SPEC LIBRARY|NEEDS-YOU|agent spec \S+|rig spec \S+|agent \S+|seats running spec "[^"]*")(.*)$/);
  if (!m) return paintInline(text, s);
  return `${m[1]}${s.paint("bright", m[2]!, { bold: true })}${paintInline(m[3] ?? "", s)}`;
}

function paintRule(line: string, s: Style): string {
  // pane titles are embedded in rule lines: dim the rule, brighten title words
  return line
    .split(/(─+|[┌┐└┘├┤┬┴┼])/)
    .map((part) => (part === "" ? part : /^[─┌┐└┘├┤┬┴┼]+$/.test(part) ? s.paint("chrome", part) : s.paint("accentBright", part, { bold: true })))
    .join("");
}

export function stylizeLines(screen: Screen, s: Style): string[] {
  if (s.mode === "none") return screen.lines;
  // focus is read from the chrome itself (the bracketed pane title) — no
  // second source of truth to drift
  const explorerFocused = (screen.lines[1] ?? "").includes("[ EXPLORER ]");

  return screen.lines.map((line, index) => {
    if (index === 0) {
      const m = line.match(/^cmd ▸ (.*)$/);
      if (m) return `${s.paint("accent", "cmd ▸", { bold: true })} ${s.paint("bright", m[1] ?? "")}`;
      return line;
    }
    if (/^[─┌┐└┘├┤┬┴┼]/.test(line) && /─{4}/.test(line)) return paintRule(line, s);
    if (/\bq quit\b/.test(line)) {
      // keybind hint bar: keys accent, labels dim, separators chrome
      return line
        .split(/( · )/)
        .map((part) =>
          part === " · "
            ? s.paint("chrome", " · ")
            : part.replace(/^(\S+)( .*)$/, (_, key: string, label: string) => s.paint("accent", key, { bold: true }) + s.paint("dim", label)),
        )
        .join("");
    }
    if (line.startsWith("≋")) {
      const m = line.match(/^≋ (\S+) (\S+) (.*)$/);
      if (m) return `${s.paint("accent", "≋")} ${s.paint("dim", m[1]!)} ${s.paint("accentBright", m[2]!)} ${s.paint("dim", m[3]!)}`;
      return s.paint("dim", line);
    }
    if (/^\[[^\]]+\] /.test(line)) {
      const closeAt = line.indexOf("]");
      let rest = line.slice(closeAt + 1);
      const errAt = rest.indexOf("✗");
      const noticeAt = rest.indexOf("▸");
      const warnAt = rest.indexOf("⚠");
      const cut = Math.min(...[errAt, noticeAt, warnAt].filter((n) => n >= 0), rest.length);
      const path = rest.slice(0, cut);
      let tail = rest.slice(cut);
      if (tail.startsWith("✗")) tail = s.paint("error", tail);
      else if (tail.startsWith("▸")) tail = s.paint("accentBright", tail);
      else if (tail.startsWith("⚠")) tail = s.paint("warn", tail);
      return `${s.paint("accent", line.slice(0, closeAt + 1), { bold: true })}${s.paint("bright", path)}${tail}`;
    }
    const border = line.indexOf("│");
    if (border >= EXPL_W - 1 && border <= EXPL_W) {
      const left = line.slice(0, border);
      const marker = line.slice(border + 1, border + 2);
      const right = line.slice(border + 2);
      if (marker === "›") {
        // content-pane selection = a real highlight bar, not just a glyph
        return `${paintExplorer(left, s, explorerFocused)}${s.paint("chrome", "│")}${s.paint("accent", `›${right}`, { inverse: true, bold: true })}`;
      }
      return `${paintExplorer(left, s, explorerFocused)}${s.paint("chrome", "│")}${marker}${paintContent(right, s)}`;
    }
    return paintContent(line, s);
  });
}
