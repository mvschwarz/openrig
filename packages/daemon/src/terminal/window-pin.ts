import type { TmuxResult } from "../adapters/tmux.js";

// A window pin: OpenRig sets a window's `window-size` to manual for a while (the web terminal's fixed geometry, a
// readable capture's resize) and gives the window its own value back after. resize-window and window-size manual stop
// the window's clients (Herdr, attach) sizing it, so a pin never given back leaves native clients a narrow window.

/** A window user option recording a pin: the window's own `window-size` from before it ("inherit" for none), then the
 *  holders of the pin (`<pid>.<n>`). It lives on the window, so a pin whose holders are gone (a daemon restart or crash)
 *  is given back by the next holder for that window, and a pin another live holder has is kept until it lets go. */
export const WINDOW_SIZE_PRIOR_OPTION = "@openrig-window-size-prior";
const INHERITED_WINDOW_SIZE = "inherit";

/** The window options a pin reads and writes; TmuxAdapter has them all. */
export interface PinTmux {
  readWindow?(target: string, userOption: string): Promise<{ id: string; userOption: string } | null>;
  getWindowLocalOption?(target: string, option: string): Promise<string | null | undefined>;
  setWindowOption(target: string, option: string, value: string): Promise<TmuxResult>;
  restoreWindowOption?(target: string, option: string, value: string | null): Promise<TmuxResult>;
}

/** A window, its own `window-size` now (`live`), the value to give back (`prior`), and the live holders of a pin. */
export interface PinSizing {
  window: string;
  live: string | null;
  prior: string | null;
  holders: string[];
}

// This process's holders. A holder from this process is live while listed here; one from another process (another
// daemon on the same tmux server) while that process runs.
const heldHere = new Set<string>();
let holderCount = 0;

// One queue per window in this process, so a readable capture and a web terminal on the same window take and give back
// a pin one at a time: each reads the record, writes it and changes the window's size before the next one reads. Another
// process isn't covered (tmux has no compare-and-set), and nothing waits on another process.
const windowQueues = new Map<string, Promise<unknown>>();

/** Run `step` (a read, record and pin, or a release) on `window` after any step already queued for it in this process. */
export function withWindowPin<T>(window: string, step: () => Promise<T>): Promise<T> {
  const run = (windowQueues.get(window) ?? Promise.resolve()).then(step);
  const settled = run.then(() => {}, () => {});
  windowQueues.set(window, settled);
  void settled.then(() => { if (windowQueues.get(window) === settled) windowQueues.delete(window); });
  return run;
}

export function newPinHolder(): string {
  return `${process.pid}.${++holderCount}`;
}

function holderLive(holder: string): boolean {
  const pid = Number(holder.split(".")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return heldHere.has(holder);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // running, as another user
  }
}

function parsePinRecord(value: string): { prior: string | null; holders: string[] } | null {
  const [prior, ...holders] = value.split(" ").filter(Boolean);
  return prior ? { prior: prior === INHERITED_WINDOW_SIZE ? null : prior, holders } : null;
}

function pinRecord(prior: string | null, holders: string[]): string {
  return [prior ?? INHERITED_WINDOW_SIZE, ...holders].join(" ");
}

/** The window `target` names (a session's current window, or `@N`), by its immutable id, with its sizing. A `manual`
 *  window with a record is pinned: its prior is the recorded one, kept for its live holders, or taken over from holders
 *  a crash left behind. Otherwise the live value is the prior. Null without a window id or a readable value. */
export async function readPinSizing(tmux: PinTmux, target: string): Promise<PinSizing | null> {
  const current = await tmux.readWindow?.(target, WINDOW_SIZE_PRIOR_OPTION).catch(() => null);
  if (!current) return null;
  const live = await tmux.getWindowLocalOption?.(current.id, "window-size").catch(() => undefined);
  if (live === undefined) return null;
  const record = parsePinRecord(current.userOption);
  if (live === "manual" && record) return { window: current.id, live, prior: record.prior, holders: record.holders.filter(holderLive) };
  return { window: current.id, live, prior: live, holders: [] };
}

/** Record `holder` as holding a pin on the window read by readPinSizing, keeping its prior. Before the pin itself.
 *  False when the record didn't land: there's then nothing to give the window back from. */
export async function recordPin(tmux: PinTmux, sizing: PinSizing, holder: string): Promise<boolean> {
  heldHere.add(holder);
  const written = await tmux.setWindowOption(sizing.window, WINDOW_SIZE_PRIOR_OPTION, pinRecord(sizing.prior, [...sizing.holders, holder]))
    .catch(() => null);
  if (!written?.ok) heldHere.delete(holder);
  return written?.ok === true;
}

/** What letting go did: the window got its prior back; another live holder keeps the pin; the window no longer lists
 *  this holder; or the give-back failed (the record is kept for the next holder). */
export type PinRelease = "given-back" | "kept-by-another-holder" | "not-listed" | "failed";

/** Let go of `holder`'s pin on `window`, once. While another live holder remains, only drop this one. As the last one,
 *  run `beforeGiveBack` (a readable capture puts the size back), then give back the prior and drop the record. A window
 *  that no longer lists this holder (the record was cleared, or the tmux server restarted and `@N` is another window)
 *  is left alone. */
export function releasePin(tmux: PinTmux, window: string, holder: string, beforeGiveBack?: () => Promise<void>): Promise<PinRelease> {
  return withWindowPin(window, async () => {
    try {
      const record = parsePinRecord((await tmux.readWindow?.(window, WINDOW_SIZE_PRIOR_OPTION).catch(() => null))?.userOption ?? "");
      if (!record?.holders.includes(holder)) return "not-listed";
      const others = record.holders.filter((other) => other !== holder && holderLive(other));
      if (others.length > 0) {
        await tmux.setWindowOption(window, WINDOW_SIZE_PRIOR_OPTION, pinRecord(record.prior, others)).catch(() => {});
        return "kept-by-another-holder";
      }
      await beforeGiveBack?.().catch(() => {});
      const restored = await tmux.restoreWindowOption?.(window, "window-size", record.prior).catch(() => null);
      // Kept when the give-back failed: this holder is then no longer live, so the next one gives it back instead.
      if (!restored?.ok) return "failed";
      await tmux.restoreWindowOption?.(window, WINDOW_SIZE_PRIOR_OPTION, null).catch(() => {});
      return "given-back";
    } finally {
      heldHere.delete(holder);
    }
  });
}
