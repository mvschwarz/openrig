// SPIKE — character canvas for the graph-render styles. Every cell carries an
// optional semantic token; `plainLines()` and `paintedLines()` are generated
// from the SAME cells, so stripAnsi(painted) === plain holds BY CONSTRUCTION
// (the shipped stylize invariant, kept structural instead of regex-matched).
// Hit zones are recorded in plain-character coordinates on the same grid.
import type { Style, Token } from "../theme.js";
import type { Action } from "../types.js";

interface Cell {
  ch: string;
  token?: Token;
  bold?: boolean;
}

export interface CanvasZone {
  y: number; // 0-based canvas row
  start: number; // 0-based inclusive column
  end: number; // exclusive
  action: Action;
}

export class GraphCanvas {
  private grid: Cell[][] = [];
  readonly zones: CanvasZone[] = [];

  constructor(readonly width: number) {}

  private row(y: number): Cell[] {
    while (this.grid.length <= y) this.grid.push([]);
    return this.grid[y]!;
  }

  set(x: number, y: number, ch: string, token?: Token, bold?: boolean): void {
    if (x < 0 || x >= this.width || y < 0) return;
    const row = this.row(y);
    while (row.length <= x) row.push({ ch: " " });
    row[x] = { ch, ...(token ? { token } : {}), ...(bold ? { bold } : {}) };
  }

  /** read the plain character at (x, y) — " " when unset */
  charAt(x: number, y: number): string {
    return this.grid[y]?.[x]?.ch ?? " ";
  }

  text(x: number, y: number, text: string, token?: Token, bold?: boolean): void {
    for (let i = 0; i < text.length; i++) this.set(x + i, y, text[i]!, token, bold);
  }

  hline(x1: number, x2: number, y: number, ch: string, token?: Token): void {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      // box-drawing crossings: a vertical run already present becomes ┼
      const existing = this.charAt(x, y);
      this.set(x, y, existing === "│" ? "┼" : ch, token);
    }
  }

  vline(x: number, y1: number, y2: number, ch: string, token?: Token): void {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      const existing = this.charAt(x, y);
      this.set(x, y, existing === "─" ? "┼" : ch, token);
    }
  }

  private readonly protectedRects: Array<{ x: number; y: number; w: number; h: number }> = [];

  /** true when (x, y) lies inside a drawn box (border or interior) */
  isProtected(x: number, y: number): boolean {
    return this.protectedRects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }

  /** rectangle border in light (─│┌┐└┘) or double (═║╔╗╚╝) box-drawing.
   * The FULL rect is cleared first and marked protected: boxes are OPAQUE —
   * edge lines drawn earlier never show through an interior, and sub-cell
   * (braille) passes must not dot inside them. */
  box(x: number, y: number, w: number, h: number, token?: Token, double = false): void {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++) this.set(col, row, " ");
    this.protectedRects.push({ x, y, w, h });
    const [hz, vt, tl, tr, bl, br] = double ? ["═", "║", "╔", "╗", "╚", "╝"] : ["─", "│", "┌", "┐", "└", "┘"];
    this.hline(x + 1, x + w - 2, y, hz!, token);
    this.hline(x + 1, x + w - 2, y + h - 1, hz!, token);
    this.vline(x, y + 1, y + h - 2, vt!, token);
    this.vline(x + w - 1, y + 1, y + h - 2, vt!, token);
    this.set(x, y, tl!, token);
    this.set(x + w - 1, y, tr!, token);
    this.set(x, y + h - 1, bl!, token);
    this.set(x + w - 1, y + h - 1, br!, token);
  }

  zone(y: number, start: number, end: number, action: Action): void {
    this.zones.push({ y, start, end, action });
  }

  get height(): number {
    return this.grid.length;
  }

  /** per-line token segments — the paint layer (stylize) renders these with
   * ITS Style instance; plain(segs) === plainLines()[y] BY CONSTRUCTION, so
   * the shipped strip-invariant holds structurally */
  segLines(): Array<Array<{ text: string; token?: Token; bold?: boolean }>> {
    return this.grid.map((row) => {
      const segs: Array<{ text: string; token?: Token; bold?: boolean }> = [];
      const cells = [...row];
      while (cells.length < this.width) cells.push({ ch: " " });
      for (const cell of cells.slice(0, this.width)) {
        const last = segs.at(-1);
        if (last && last.token === cell.token && last.bold === cell.bold) last.text += cell.ch;
        else segs.push({ text: cell.ch, ...(cell.token ? { token: cell.token } : {}), ...(cell.bold ? { bold: cell.bold } : {}) });
      }
      return segs;
    });
  }

  plainLines(): string[] {
    return this.grid.map((row) => row.map((cell) => cell.ch).join("").padEnd(this.width, " ").slice(0, this.width));
  }

  paintedLines(style: Style): string[] {
    return this.grid.map((row) => {
      let out = "";
      let run = "";
      let runToken: Token | undefined;
      let runBold: boolean | undefined;
      const flush = () => {
        if (run === "") return;
        out += runToken ? style.paint(runToken, run, runBold ? { bold: true } : undefined) : run;
        run = "";
      };
      const cells = [...row];
      while (cells.length < this.width) cells.push({ ch: " " });
      for (const cell of cells.slice(0, this.width)) {
        if (cell.token !== runToken || cell.bold !== runBold) {
          flush();
          runToken = cell.token;
          runBold = cell.bold;
        }
        run += cell.ch;
      }
      flush();
      return out;
    });
  }
}
