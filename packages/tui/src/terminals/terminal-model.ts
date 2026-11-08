import type { DaemonClient } from "../daemon-client.js";
import { windowTarget, type WindowTarget } from "./open-window.js";
import type { ExplorerRow, FleetSnapshot, ViewState } from "../types.js";
import { wrapDetailLines, type ContentLine } from "../detail.js";

export interface TerminalEntry {
  view: string;
  name: string;
  kind: "saved" | "derived";
  members: string[];
  readinessUnverified?: boolean;
  ready: number;
  absent: number;
  degraded: number;
  pages: number;
}

export interface TerminalPreview {
  view: string;
  provider: string;
  planId: string;
  status: { available: boolean; launch?: { socketPath?: string } };
  herdrApp?: { appHome?: string };
  composed: {
    id: string;
    pages: Array<Array<{ seat: string; label: string; readOnly: boolean; paneCommand: string; recoveryCommand?: string }>>;
    opened: Array<{ seat: string }>;
    absent: Array<{ seat: string; reason: string }>;
    degraded: Array<{ seat: string; reason: string }>;
  };
  grids: Array<{ columns: number; rows: number; blanks: number }>;
}

export interface TerminalRead {
  catalog: TerminalEntry[];
  catalogLoaded?: boolean;
  daemonTarget?: string;
  preview: TerminalPreview | null;
  error?: string;
}

export async function readTerminals(client: DaemonClient, view?: string | null,
  provider: () => Promise<WindowTarget | WindowTarget["provider"]> = windowTarget): Promise<TerminalRead> {
  const result: TerminalRead = { catalog: [], preview: null };
  // Display the endpoint without URL credentials, query parameters or fragments.
  try { result.daemonTarget = new URL(client.baseUrl).origin; } catch { /* unavailable target */ }
  try {
    const listing = await client.terminalViews();
    if (!Array.isArray(listing.saved) || !Array.isArray(listing.rigs)) throw new Error("Terminal names could not be read.");
    result.catalog = [
      ...listing.saved.map(s => ({ view: `saved:${s.id}`, name: s.name, kind: "saved" as const, members: s.members.map(m => m.seat) })),
      ...listing.rigs.map(name => ({ view: `rig:${name}`, name, kind: "derived" as const, members: [] })),
    ].map(entry => ({ ...entry, readinessUnverified: true, ready: 0, absent: 0, degraded: 0, pages: 0 }));
    result.catalogLoaded = true;
    if (view) {
      const target = await provider();
      // herdr-app carries its client; the other providers are named as before.
      const preview = await client.previewTerminal(view, typeof target === "string" || target.provider !== "herdr-app" ? (typeof target === "string" ? target : target.provider) as "herdr" | "rex" | "cmux" : target);
      result.preview = preview && typeof target !== "string" && target.provider === "herdr-app" && !preview.herdrApp
        ? { ...preview, herdrApp: { appHome: target.appHome } }
        : preview;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function terminalExplorerRows(state: ViewState, snap: FleetSnapshot): ExplorerRow[] {
  if (!snap.terminals || (snap.terminals.error && !snap.terminals.catalogLoaded && !snap.terminals.catalog.length)) return [];
  const entries = snap.terminals.catalog;
  const rows: ExplorerRow[] = [];
  for (const kind of ["saved", "derived"] as const) {
    const key = `terminals:${kind}`;
    const open = kind === "saved" || state.expanded.includes(key) || !!state.filter;
    rows.push({ label: `  ${kind === "saved" ? "Saved" : `${open ? "▾" : "▸"} Derived`} (${entries.filter(e => e.kind === kind).length})`, key,
      action: kind === "saved" ? { type: "noop" } : { type: "toggle-expand", key } });
    if (!open) continue;
    for (const entry of entries.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()))) {
      rows.push({ label: `    ${entry.name}${entry.readinessUnverified ? "" : ` · ${entry.ready}/${entry.members.length}`}`, key: `terminal:${entry.view}`, action: { type: "terminal-preview", view: entry.view } });
    }
  }
  return rows;
}

export function terminalLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const read = snap.terminals;
  const lines: ContentLine[] = [{ text: "TERMINALS · Saved and Derived views" }];
  if (state.terminalResult && state.terminalResult.view === state.terminalView) lines.push({ text: `Last Open result: ${state.terminalResult!.message}` });
  if (!read) return [...lines, { text: "Reading terminal views…" }];
  if (read.error) lines.push({ text: `Unavailable: ${read.error}` });
  if (read.error && !read.catalogLoaded && !read.catalog.length) return wrapDetailLines(lines, width);
  const preview = read.preview?.view === state.terminalView ? read.preview : null;
  if (state.terminalView && !preview) {
    lines.push({ text: "Back to terminal views", action: { type: "back" } });
    return wrapDetailLines(lines, width);
  }
  if (!preview) {
    lines.push({ text: "Browse and preview are passive. Choose a view, then Open terminals: a desktop window, or inside herdr-app a Rig view in this window." });
    for (const kind of ["saved", "derived"] as const) {
      const entries = read.catalog.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()));
      const open = kind === "saved" || state.expanded.includes("terminals:derived") || !!state.filter;
      lines.push({ text: "" }, { text: `${kind === "saved" ? "Saved" : `${open ? "▾" : "▸"} Derived`} · ${entries.length} views`,
        ...(kind === "derived" ? { action: { type: "toggle-expand" as const, key: "terminals:derived" } } : {}) });
      if (!open) continue;
      if (!entries.length) lines.push({ text: kind === "saved" ? "No saved views. Existing terminal-views.yaml stores membership, not custom geometry." : "No derived rig views available." });
      for (const entry of entries) {
        lines.push({ text: `${entry.name} · ${entry.readinessUnverified ? (entry.kind === "saved" ? `${entry.members.length} saved members · Preview readiness` : "Preview members and readiness") : `${entry.members.length} members · ${entry.ready} attachable · ${entry.absent + entry.degraded} unavailable · ${entry.pages} pages`}`, action: { type: "terminal-preview", view: entry.view } });
        if (entry.kind === "saved") lines.push({ text: `  ${entry.members.join(", ") || "Empty view"}` });
      }
    }
    return wrapDetailLines(lines, width);
  }

  const plan = preview.composed;
  const pageIndex = Math.min(Math.max(0, state.terminalPage ?? 0), Math.max(0, plan.pages.length - 1));
  const page = plan.pages[pageIndex] ?? [];
  const grid = preview.grids[pageIndex];
  lines.push({ text: preview.view }, { text: `${plan.opened.length} attachable · ${plan.absent.length} absent · ${plan.degraded.length} degraded` });
  // Actions precede the diagram so explicit Open/Back remain accessible at 80×24.
  lines.push({ text: "Back to views", action: { type: "back" } });
  const herdrAppUnavailable = preview.provider === "herdr-app" && !preview.status.available;
  if (plan.opened.length && !herdrAppUnavailable) {
    lines.push({ text: `Open terminals ▸ all ${plan.pages.length} pages`, action: { type: "act", act: "open-terminal", view: preview.view, expectedPlan: preview.planId } });
  } else if (!plan.opened.length) lines.push({ text: "Nothing attachable; no space will be opened." });
  lines.push({ text: "Refresh preview", action: { type: "terminal-preview", view: preview.view } });
  if (plan.pages.length > 1) {
    if (pageIndex > 0) lines.push({ text: "Previous page", action: { type: "terminal-page", page: pageIndex - 1 } });
    if (pageIndex + 1 < plan.pages.length) lines.push({ text: "Next page", action: { type: "terminal-page", page: pageIndex + 1 } });
  }
  lines.push({ text: `Page ${plan.pages.length ? pageIndex + 1 : 0}/${plan.pages.length}${grid ? ` · ${grid.columns} columns × ${grid.rows} rows · ${grid.blanks} filler cells` : ""}` });
  if (grid) {
    const cellWidth = Math.max(4, Math.floor((width - 1) / grid.columns) - 1);
    const border = "+" + Array(grid.columns).fill("-".repeat(cellWidth)).join("+") + "+";
    lines.push({ text: border });
    for (let row = 0; row < grid.rows; row++) {
      const cells = Array.from({ length: grid.columns }, (_, col) => {
        const index = row * grid.columns + col;
        return (page[index] ? `${index + 1}${page[index]!.readOnly ? " RO" : " RW"}` : "blank").padEnd(cellWidth);
      });
      lines.push({ text: "|" + cells.join("|") + "|" }, { text: border });
    }
  }
  page.forEach((member, index) => {
    lines.push({ text: `${index + 1}. ${member.label} · ${member.readOnly ? "read-only" : "interactive"}` }, { text: `   ${member.seat}${member.paneCommand.startsWith("ssh ") ? " · SSH login unverified; opened pane will attempt connection" : ""}` });
  });
  lines.push({ text: "Auto-layout: equal cells, at most 9 members per page. Blank cells fill incomplete rectangles. Saved views store membership only; no custom geometry editor." });
  for (const member of [...plan.absent, ...plan.degraded]) lines.push({ text: `Unavailable · ${member.seat}: ${member.reason}` });
  if (page.length && preview.provider === "herdr-app") {
    if (preview.status.available) {
      // The view opens in the herdr-app window this TUI runs in: no desktop window, no attach-by-hand recipe.
      lines.push({ text: "Opens here: a new Rig view in this herdr-app window, beside your tabs, switched from the strip above them. Nothing needs a desktop display or SSH. Existing conversations stay in place." });
    } else {
      const socketPath = preview.status.launch?.socketPath ?? (preview.herdrApp?.appHome ? `${preview.herdrApp.appHome}/herdr-app.sock` : "herdr-app.sock");
      lines.push({ text: `herdr-app is not answering at ${socketPath} (the socket file exists, but nothing replied). Nothing will open from here. Start herdr-app, or run \`rig terminal open ${preview.view} --window\` for a desktop window.` });
    }
  } else if (page.length) {
    lines.push({ text: "On a desktop, opens a new terminal tab or window: a Rex session when run inside Rex, a new cmux workspace when run inside cmux, Herdr if installed, otherwise the same layout in plain tmux." });
    lines.push({ text: `Run this TUI on the selected daemon's desktop (${read.daemonTarget ?? "address unreported"}). Existing conversations stay in place.` });
    lines.push({ text: `Headless or remote: open a NEW terminal/tab on the machine running the selected daemon (${read.daemonTarget ?? "address unreported"}), then attach with one command below per terminal. Existing conversations stay in place.` });
    lines.push({ text: "If a command wraps, widen this terminal until it fits on one line before copying." });
    for (const member of page) {
      // Current SSH commands already request a TTY; older daemons may omit it.
      const command = (member.recoveryCommand ?? member.paneCommand).replace(/^ssh (?!-t(?:\s|$))/, "ssh -t ");
      lines.push({ text: `${member.label} · ${member.seat}` }, { text: `env -u TMUX ${command}` });
    }
  }
  return wrapDetailLines(lines, width);
}
