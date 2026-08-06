// Stylize pass — pro-dev-tool treatment (founder directive, k9s class) applied
// AFTER layout: renderScreen stays the tested plain layer (layout + hitMap);
// this pass only injects zero-width SGR sequences. INVARIANT (test-pinned):
// stripAnsi(styled[i]) === plain[i] for every line — styling can never move a
// hit target or shear a frame. Segment-painted (no nested wraps), so resets
// never bleed.
import type { Screen } from "./types.js";
import type { Style } from "./theme.js";
import { reducedMotion } from "./motion.js";

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
  if (text.startsWith("›")) {
    const token = focused ? "accent" : "dim";
    const opts = { inverse: true, bold: focused };
    // FOUNDER CORRECTION (style verdict, folded spec): the highlight covers
    // the row's item TEXT only — branch-guide glyphs stay UNHIGHLIGHTED.
    const tree = text.match(/^›( *(?:[│ ] )*(?:├─|└─) )(.*?)( *)$/);
    if (tree) return s.paint(token, "›", opts) + s.paint("chrome", tree[1]!) + s.paint(token, tree[2]!, opts) + tree[3]!;
    return s.paint(token, text, opts);
  }
  if (/[▾▸] (TOPOLOGY|SPECS|NEEDS-YOU)/.test(text)) return s.paint("bright", text, { bold: true });
  // Slice-17 re-skin: branch guides paint faint (chrome), the row body keeps
  // its own rules — the tree rails read as structure, never as content.
  const tree = text.match(/^( *(?:[│ ] )*(?:├─|└─) )(.*)$/);
  if (tree) return s.paint("chrome", tree[1]!) + paintExplorerBody(tree[2]!, s);
  return paintExplorerBody(text, s);
}

/** row-body treatment (VISUAL-TARGETS: rig teal · pod dim · meta faint ·
 * names default ink); the right-aligned meta column always dims */
function paintExplorerBody(text: string, s: Style): string {
  const meta = text.match(/^(.*?\S)( +)((?:\S+ · )?(?:[0-9]+%|—)|[0-9]+)$/);
  if (meta) return paintExplorerBody(meta[1]!, s) + meta[2]! + s.paint("dim", meta[3]!);
  if (text.includes("⚑")) return s.paint("warn", text);
  if (/\(unreachable\)/.test(text)) {
    const at = text.indexOf("(unreachable)");
    return text.slice(0, at) + s.paint("error", "(unreachable)") + text.slice(at + "(unreachable)".length);
  }
  if (/\((recoverable|degraded|stopped|attention_required)\)/.test(text)) {
    return text.replace(/\((recoverable|degraded|stopped|attention_required)\)/, (m) => s.paint("warn", m));
  }
  // ROUND-3: explorer icons MONOCHROME — color is for status only
  if (text.startsWith("▦ ")) return s.paint("dim", "▦ ") + text.slice(2);
  if (text.startsWith("⊕ ")) return s.paint("dim", "⊕ ") + text.slice(2);
  if (/^[▾▸] /.test(text)) return s.paint("chrome", text.slice(0, 2)) + s.paint("dim", text.slice(2));
  return text;
}

/** alert line with in-row hierarchy: glyph+kind toned, host dim, target
 * bright, detail dim, link accent — same fact, same place, same color. */
function paintAlertLine(text: string, token: "warn" | "error", s: Style): string {
  const openAt = text.indexOf("(open ▸)");
  const body = openAt >= 0 ? text.slice(0, openAt) : text;
  const suffix = openAt >= 0 ? s.paint("accent", "(open ▸)", { bold: true }) + text.slice(openAt + "(open ▸)".length) : "";
  const cols = body.match(/^(\s*[⚑☐✖] )(\S+\s+)(\[[^\]]*\]\s+)?(\S+\s+)(.*)$/);
  // ROUND-3 mr7: the needs-you ⚑ carries the SLOW attention-pulse — the ONLY
  // persistent motion in its region; reduced-motion renders it steady
  const pulse = !reducedMotion();
  const paintFlag = (seg: string): string => {
    const at = seg.indexOf("⚑");
    if (at < 0 || !pulse) return s.paint(token, seg);
    return s.paint(token, seg.slice(0, at)) + s.paint(token, "⚑", { blink: true }) + s.paint(token, seg.slice(at + 1));
  };
  if (!cols)
    return paintFlag(body) + suffix;
  return (
    paintFlag(cols[1]! + cols[2]!) +
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
      const m = line.match(/^cmd ▸ (.*?)(▊?)( *)$/);
      if (m)
        return `${s.paint("accent", "cmd ▸", { bold: true })} ${s.paint("bright", m[1] ?? "")}${m[2] ? s.paint("accent", "▊", reducedMotion() ? {} : { blink: true }) : ""}${m[3] ?? ""}`;
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
      // round-5 (guard): the ambient rig-stream ticker is NOT a pane-output
      // event source — it never flashes; the activity flash lives on the
      // flashed agent's explorer row (flashRows) instead
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
    // S19 round-5 (guard): the tmux-style fresh-pane-output ONE-SHOT flash —
    // whole-row inverse on EXACTLY the flashed agent's explorer row while the
    // window is open (renderScreen owns event/window/reduced-motion truth;
    // this is zero-width SGR only, strip-invariant preserved)
    if (screen.flashRows?.includes(index + 1)) return s.paint("bright", line, { inverse: true });
    // The pane border lives at the FIXED boundary column (EXPL_W) — located
    // positionally, never by scanning: the navigator's │ rails would shadow
    // a first-index search (slice-17 locked-rail resolution).
    const border = line.charAt(EXPL_W) === "│" ? EXPL_W : -1;
    if (border >= EXPL_W - 1 && border <= EXPL_W) {
      const left = line.slice(0, border);
      const marker = line.slice(border + 1, border + 2);
      const right = line.slice(border + 2);
      if (marker === "›") {
        // content-pane selection = a real highlight bar, not just a glyph
        return `${paintExplorer(left, s, explorerFocused)}${s.paint("chrome", "│")}${s.paint("accent", `›${right}`, { inverse: true, bold: true })}`;
      }
      // S19 MR2 (guard finding 2) + round-4 finding 4: explorer seg RUNS —
      // each run (status badge, right meta) paints its OWN tokens; the guide
      // prefix keeps the explorer chrome rules and the text between runs is
      // default ink (names). Selected rows keep the highlight bar.
      const em = screen.explorerMeta?.[index + 1];
      if (em && em.length && !left.startsWith("›")) {
        let paintedLeft = "";
        let pos = 0;
        em.forEach((run, k) => {
          const chunk = left.slice(pos, run.start);
          paintedLeft += k === 0 ? paintExplorer(chunk, s, explorerFocused) : chunk;
          paintedLeft += run.segs
            .map((g) => (g.token || g.bg || g.inverse ? s.paint(g.token ?? "bright", g.text, { ...(g.bold ? { bold: true } : {}), ...(g.bg ? { bg: g.bg } : {}), ...(g.inverse ? { inverse: true } : {}) }) : g.text))
            .join("");
          pos = run.start + run.segs.reduce((n, g) => n + g.text.length, 0);
        });
        paintedLeft += left.slice(pos);
        const cSegs = screen.segRows?.[index + 1];
        if (cSegs) {
          const segText = cSegs.map((g) => g.text).join("");
          const paintedC = cSegs
            .map((g) => (g.token || g.bg || g.inverse ? s.paint(g.token ?? "bright", g.text, { ...(g.bold ? { bold: true } : {}), ...(g.bg ? { bg: g.bg } : {}), ...(g.inverse ? { inverse: true } : {}) }) : g.text))
            .join("");
          return `${paintedLeft}${s.paint("chrome", "│")}${marker}${paintedC}${right.slice(segText.length)}`;
        }
        return `${paintedLeft}${s.paint("chrome", "│")}${marker}${paintContent(right, s)}`;
      }
      // slice-17: canvas-rendered rows (graph view) carry token segments —
      // painted with THIS Style; plain(segs) === the content text by
      // construction, so the strip-invariant holds structurally
      const segs = screen.segRows?.[index + 1];
      if (segs) {
        const segText = segs.map((seg) => seg.text).join("");
        const painted = segs
          .map((seg) =>
            seg.token || seg.bg || seg.inverse
              ? s.paint(seg.token ?? "bright", seg.text, { ...(seg.bold ? { bold: true } : {}), ...(seg.bg ? { bg: seg.bg } : {}), ...(seg.inverse ? { inverse: true } : {}) })
              : seg.text)
          .join("");
        return `${paintExplorer(left, s, explorerFocused)}${s.paint("chrome", "│")}${marker}${painted}${right.slice(segText.length)}`;
      }
      return `${paintExplorer(left, s, explorerFocused)}${s.paint("chrome", "│")}${marker}${paintContent(right, s)}`;
    }
    // Full-width canvas rows (no explorer split — e.g. the crash-cart cockpit): paint the row's
    // segs directly. Same seg-paint rule as the split-pane path; plain(segs) === the row text by
    // construction, so stripAnsi(styled) === plain holds (the strip-invariant).
    const fullSegs = screen.segRows?.[index + 1];
    if (fullSegs) {
      const segText = fullSegs.map((g) => g.text).join("");
      const painted = fullSegs
        .map((g) =>
          g.token || g.bg || g.inverse
            ? s.paint(g.token ?? "bright", g.text, { ...(g.bold ? { bold: true } : {}), ...(g.bg ? { bg: g.bg } : {}), ...(g.inverse ? { inverse: true } : {}) })
            : g.text)
        .join("");
      return painted + line.slice(segText.length);
    }
    return paintContent(line, s);
  });
}
