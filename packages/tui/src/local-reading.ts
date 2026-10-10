import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { Action } from "./types.js";

export interface LocalRequest { op: "roots" | "list" | "read"; root?: string; path?: string }
interface LocalEntry { label: string; root: string; path: string; source: string; kind: string; error?: string }
export interface LocalResult {
  entries?: LocalEntry[]; source?: string; readAt?: string; error?: string; message?: string;
  absolutePath?: string; content?: string; mtime?: string; contentHash?: string;
  binary?: boolean; truncated?: boolean; truncatedAtBytes?: number | null; totalBytes?: number;
}
export interface LocalReadingState {
  request: LocalRequest; busy: boolean; selected: number; scroll: number; result: LocalResult;
}

export function readLocal(cliEntry: string | undefined, request: LocalRequest): Promise<LocalResult> {
  if (!cliEntry) return Promise.resolve({ error: "Local reader unavailable in this launcher; open through the installed rig CLI." });
  return new Promise((resolve) => {
    execFile(process.execPath, [join(dirname(cliEntry), "local-reading.js"), JSON.stringify(request)],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve({ error: "Local reader did not complete", message: error.message });
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ error: "Local reader returned invalid data" }); }
      });
  });
}

export class LocalReadingController {
  readonly state: LocalReadingState = { request: { op: "roots" }, busy: false, selected: 0, scroll: 0, result: {} };
  private history: Array<{ request: LocalRequest; selected: number; scroll: number }> = [];
  private generation = 0;
  constructor(private read: (request: LocalRequest) => Promise<LocalResult>, private changed: () => void) {}
  async load(request = this.state.request) {
    const generation = ++this.generation;
    Object.assign(this.state, { request, busy: true, result: {} }); this.changed();
    let result: LocalResult;
    try { result = await this.read(request); }
    catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    if (generation !== this.generation) return;
    if (result.entries) this.state.selected = Math.max(0, Math.min(this.state.selected, result.entries.length - 1));
    Object.assign(this.state, { busy: false, result }); this.changed();
  }
  close() { this.generation++; }
  async key(key: string): Promise<boolean> {
    const s = this.state;
    if (key === "escape") {
      const previous = this.history.pop();
      if (!previous) { this.close(); return false; }
      Object.assign(s, previous); await this.load(); return true;
    }
    if (key === "r") { await this.load(); return true; }
    if (["up", "down", "pageup", "pagedown"].includes(key) || key.startsWith("select:")) {
      const delta = (key.includes("up") ? -1 : 1) * (key.startsWith("page") ? 10 : 1);
      if (s.result.entries) s.selected = Math.max(0, Math.min(s.result.entries.length - 1,
        key.startsWith("select:") ? Number(key.slice(7)) : s.selected + delta));
      else s.scroll = Math.max(0, s.scroll + delta);
      this.changed(); return true;
    }
    if (key === "enter" && !s.busy) {
      const entry = s.result.entries?.[s.selected];
      if (entry) {
        this.history.push({ request: s.request, selected: s.selected, scroll: s.scroll });
        s.selected = 0; s.scroll = 0;
        const request: LocalRequest = { op: entry.kind === "directory" ? "list" : "read", root: entry.root, path: entry.path };
        if (entry.error) { this.generation++; s.request = request; s.result = { error: entry.error, source: entry.source }; this.changed(); }
        else await this.load(request);
      }
    }
    return true;
  }
}

export function localLines(s: LocalReadingState): Array<{ text: string; action?: Action }> {
  const r = s.result;
  const lines: Array<{ text: string; action?: Action }> = [
    { text: "LOCAL READING · this machine's configured sources" },
    { text: "Disk snapshot only. Live queue, execution and topology are unavailable here." },
    { text: "r re-reads disk · Esc Back · ↑↓ choose/scroll · Enter read" },
    { text: `Source: ${r.absolutePath ?? r.source ?? (s.request.root ? `${s.request.root}/${s.request.path}` : "configured workspace roots")}` },
  ];
  if (s.busy) return [...lines, { text: "Reading selected source… Help and Back remain available." }];
  if (r.error) return [...lines, { text: `UNAVAILABLE: ${r.error}` }, { text: r.message ?? "" }];
  if (r.entries) {
    lines.push({ text: `Read at ${r.readAt}` }, { text: "" });
    for (const [i, entry] of r.entries.entries()) lines.push({
      text: `${i === s.selected ? "▶" : " "} ${entry.label}${entry.kind === "directory" ? "/" : ""}${entry.error ? ` · ${entry.error}` : ""}`,
      action: { type: "startup", key: `select:${i}` },
    });
    if (!r.entries.length) lines.push({ text: "No visible entries in this selected directory." });
  } else {
    lines.push({ text: `Modified ${r.mtime} · ${r.totalBytes} bytes` }, { text: `SHA-256 ${r.contentHash}` },
      { text: r.truncated ? `TRUNCATED at ${r.truncatedAtBytes} of ${r.totalBytes} bytes.` : "Complete disk read. May change after this read; not daemon state." });
    if (r.binary) lines.push({ text: "Binary / non-UTF-8 file; text is not displayed." });
    else lines.push({ text: "" }, ...(r.content ?? "").split(/\r\n|\r|\n/).map((text) => ({ text })));
  }
  return lines;
}
