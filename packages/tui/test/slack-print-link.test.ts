// OPR.0.6.0.5 F1 — "Print link to copy" on the Connections page. Real decoded key bytes drive the
// real input path (decodeInput → resolveKeyAction) to the action; the action runs the real
// printForCopy over test streams. Proves the EMITTED bytes: the exact link as one unbroken line.
// It cannot prove what a given terminal's mouse selection copies from soft-wrapped output.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { buildSlackAppManifest } from "../../daemon/src/domain/gateway/slack/manifest.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { decodeInput, resolveKeyAction, ALT_SCREEN_OFF, ALT_SCREEN_ON } from "../src/input.js";
import { printForCopy, printForCopyText, streamCopyTerminal, runCopySession, PRINT_FOR_COPY_RETURN_HINT, type CopyTerminal } from "../src/print-for-copy.js";
import type { Action, FleetSnapshot } from "../src/types.js";

const bundle = buildSlackAppManifest();
function snapshot(tokens: "missing" | "resolved" | "unavailable", manifest = true): FleetSnapshot {
  return {
    ...emptySnapshot(),
    slackManifest: manifest ? { yaml: bundle.yaml, url: bundle.url } : null,
    connections: {
      observedAt: "2026-09-27T00:00:00Z", home: "/fixture-home", pid: 1, settingsSource: null, settings: [],
      configSource: { state: "default", path: null },
      configuration: { enabled: false, channel: null, inboundDestination: null, outboundDestinations: [], postLevel: "NOTICE", interruptLevel: "ALERT", botToken: tokens, appToken: tokens },
      running: { state: "active", activatedAt: null, outboundReady: false, inboundReady: false, inboundState: "idle", applied: "matching" },
      state: "disabled", nextAction: tokens === "missing" ? "rig slack manifest --url" : "rig slack enable",
      verification: { state: "none", at: null, actor: null }, registry: { state: "available", path: null }, humans: [],
    },
  } as FleetSnapshot;
}

const KEYS = { right: "\x1b[C", down: "\x1b[B", up: "\x1b[A", enter: "\r" } as const;

/** Drive real key bytes to the "Print link to copy" line; return the action Enter resolves to. */
function pressEnterOnPrintLink(snap: FleetSnapshot, size: { cols: number; rows: number }): Action | null {
  const v = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
  v.dispatch(parseCommand("connections"));
  const draw = () => {
    const sc = renderScreen(v.get(), snap, size);
    v.dispatch({ type: "layout", contentMaxOffset: sc.contentMaxOffset, contentTargetCount: sc.contentTargets.length });
    return sc;
  };
  const resolve = (k: keyof typeof KEYS) => {
    const sc = draw();
    return resolveKeyAction(decodeInput(KEYS[k])[0]!, v.get(), sc, computeExplorerRows(v.get(), snap).length);
  };
  const key = (k: keyof typeof KEYS) => { const a = resolve(k); if (a) v.dispatch(a); };
  key("right");
  for (let steps = 0; steps < 400; steps++) {
    const sc = draw();
    const ix = sc.contentTargets.findIndex((t) => t.action?.type === "print-for-copy");
    if (ix >= 0) {
      for (let z = 0; z < 12 && v.get().contentSelection !== ix; z++) key(v.get().contentSelection > ix ? "up" : "down");
      if (v.get().contentSelection === ix) return resolve("enter");
      return null;
    }
    key("down");
  }
  return null;
}

class FakeTerminal {
  out = ""; raw: boolean[] = [];
  stdin = new PassThrough();
  term = streamCopyTerminal(this.stdin, { write: (t: string) => { this.out += t; } }, (on) => { this.raw.push(on); });
}

describe("Print link to copy — real key path to the action", () => {
  for (const size of [{ cols: 60, rows: 20 }, { cols: 100, rows: 30 }]) {
    it(`${size.cols}x${size.rows}: arrow keys and Enter reach the action carrying the exact link`, () => {
      const action = pressEnterOnPrintLink(snapshot("missing"), size);
      expect(action).toEqual({ type: "print-for-copy", label: expect.any(String), value: bundle.url });
    });
  }

  it("not offered when Slack is configured, or when token state is unknown", () => {
    for (const tokens of ["resolved", "unavailable"] as const) {
      const sc = renderScreen((() => { const v = createViewState({ instanceId: "f", getSnapshot: () => snapshot(tokens) }); v.dispatch(parseCommand("connections")); return v.get(); })(), snapshot(tokens), { cols: 100, rows: 30 });
      expect(sc.contentTargets.some((t) => t.action?.type === "print-for-copy")).toBe(false);
    }
  });

  it("older daemon (no manifest): no print action, the CLI fallback is named", () => {
    const snap = snapshot("missing", false);
    const v = createViewState({ instanceId: "f", getSnapshot: () => snap });
    v.dispatch(parseCommand("connections"));
    const sc = renderScreen(v.get(), snap, { cols: 100, rows: 60 });
    expect(sc.contentTargets.some((t) => t.action?.type === "print-for-copy")).toBe(false);
    expect(sc.lines.join("\n")).toContain("rig slack manifest --url");
  });

  it("dispatching the action to view state changes nothing (only perform runs it)", () => {
    const snap = snapshot("missing");
    const v = createViewState({ instanceId: "f", getSnapshot: () => snap });
    v.dispatch(parseCommand("connections"));
    const before = JSON.stringify(v.get());
    v.dispatch({ type: "print-for-copy", label: "x", value: bundle.url });
    expect(JSON.stringify(v.get())).toBe(before);
  });
});

const RESTORE = ALT_SCREEN_ON + "\x1b[?1000h\x1b[?1006h\x1b[?2004h";
const tick = () => new Promise((r) => setImmediate(r));
const listeners = (s: PassThrough) => ["data", "end", "close", "error"].reduce((n, e) => n + s.listenerCount(e), 0);

describe("Print link to copy — emitted bytes and normal return", () => {
  it("leaves the alternate screen, prints the exact link as one unbroken line, and restores on Enter", async () => {
    const f = new FakeTerminal();
    const action = pressEnterOnPrintLink(snapshot("missing"), { cols: 60, rows: 20 }) as Extract<Action, { type: "print-for-copy" }>;
    const done = printForCopy(f.term, action.label, action.value);
    await tick();
    expect(f.out.startsWith("\x1b[?2004l")).toBe(true);
    expect(f.out).toContain(ALT_SCREEN_OFF);
    expect(f.out).not.toContain(ALT_SCREEN_ON);
    const printed = f.out.slice(f.out.indexOf(ALT_SCREEN_OFF) + ALT_SCREEN_OFF.length);
    expect(printed).toBe(printForCopyText(action.label, bundle.url));
    expect(printed.split("\r\n").filter((r) => r.includes("api.slack.com"))).toEqual([bundle.url]);
    expect(printed).toContain(PRINT_FOR_COPY_RETURN_HINT);
    f.stdin.write("\r");
    expect(await done).toBe("enter");
    expect(f.out.endsWith(RESTORE)).toBe(true);
    expect(f.raw).toEqual([false, true]);
    expect(listeners(f.stdin)).toBe(0);
  });

  it("ignores other input while waiting; later input is not consumed", async () => {
    const f = new FakeTerminal();
    let returned = false;
    const done = printForCopy(f.term, "label", bundle.url).then(() => { returned = true; });
    for (const stray of ["q", "\x1b[B", "\x1b[A", "v", "\x1b"]) { f.stdin.write(stray); await tick(); }
    expect(returned).toBe(false);
    f.stdin.write("\n");
    await done;
    expect(listeners(f.stdin)).toBe(0);
    const len = f.out.length;
    f.stdin.write("x\r"); await tick();
    expect(f.out.length).toBe(len);
  });

  it("a value that contains a line break is still printed as one line", () => {
    expect(printForCopyText("l", "a\nb\r\nc").split("\r\n")).toContain("abc");
  });
});

describe("Print link to copy — input ends, closes or fails while waiting", () => {
  for (const [how, trigger] of [
    ["end", (s: PassThrough) => { s.end(); }],
    ["close", (s: PassThrough) => { s.emit("close"); }],
    ["error", (s: PassThrough) => { s.emit("error", new Error("EIO")); }],
  ] as const) {
    it(`${how}: the wait settles, the TUI is restored and every listener is released`, async () => {
      const f = new FakeTerminal();
      const done = printForCopy(f.term, "label", bundle.url);
      await tick();
      trigger(f.stdin);
      expect(await done).toBe(how);
      expect(f.out.endsWith(RESTORE)).toBe(true);
      expect(f.raw).toEqual([false, true]);
      expect(listeners(f.stdin)).toBe(0);
    });
  }
});

function sessionDeps(terminal: CopyTerminal, over: Partial<{ shutting: () => boolean }> = {}) {
  const log: string[] = [];
  return {
    log,
    deps: {
      terminal, label: "label", value: bundle.url,
      setSuspended: (on: boolean) => log.push(`suspended:${on}`),
      isShuttingDown: over.shutting ?? (() => false),
      notice: (m: string) => log.push(`notice:${m}`),
      draw: () => log.push("draw"),
    },
  };
}

describe("runCopySession — the main boundary", () => {
  it("normal Enter: suspends, resumes, redraws once, no notice", async () => {
    const f = new FakeTerminal();
    const { log, deps } = sessionDeps(f.term);
    const done = runCopySession(deps);
    await tick(); f.stdin.write("\r");
    expect(await done).toBe("enter");
    expect(log).toEqual(["suspended:true", "suspended:false", "draw"]);
  });

  it("input ends while waiting: resumes with a notice", async () => {
    const f = new FakeTerminal();
    const { log, deps } = sessionDeps(f.term);
    const done = runCopySession(deps);
    await tick(); f.stdin.end();
    expect(await done).toBe("end");
    expect(log).toEqual(["suspended:true", "notice:Returned from the printed link: terminal input ended.", "suspended:false", "draw"]);
  });

  it("a rejected wait is caught: notice, resume, redraw, and no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let out = ""; const raw: boolean[] = [];
      const term: CopyTerminal = { write: (t) => { out += t; }, setRawMode: (on) => { raw.push(on); }, waitForEnter: () => Promise.reject(new Error("closed")) };
      const { log, deps } = sessionDeps(term);
      expect(await runCopySession(deps)).toBe("failed");
      await tick(); await tick();
      expect(unhandled).toEqual([]);
      expect(log).toEqual(["suspended:true", "notice:Could not print the link (closed). Run: rig slack manifest --url", "suspended:false", "draw"]);
      expect(out.endsWith(RESTORE)).toBe(true);
      expect(raw).toEqual([false, true]);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });

  for (const failAt of ["setRawMode", "first write"] as const) {
    it(`initial failure (${failAt}) does not bypass cleanup`, async () => {
      let out = ""; const raw: boolean[] = []; let writes = 0;
      const term: CopyTerminal = {
        write: (t) => { writes++; if (failAt === "first write" && writes === 1) throw new Error("EPIPE"); out += t; },
        setRawMode: (on) => { raw.push(on); if (failAt === "setRawMode" && on === false) throw new Error("EBADF"); },
        waitForEnter: () => Promise.resolve("enter"),
      };
      const { log, deps } = sessionDeps(term);
      expect(await runCopySession(deps)).toBe("failed");
      expect(raw).toEqual([false, true]);
      expect(out.endsWith(RESTORE)).toBe(true);
      expect(log[0]).toBe("suspended:true");
      expect(log.slice(-2)).toEqual(["suspended:false", "draw"]);
    });
  }

  it("shutdown while waiting: no alternate-screen restore and no redraw after shutdown", async () => {
    const f = new FakeTerminal();
    let shutting = false;
    const { log, deps } = sessionDeps(f.term, { shutting: () => shutting });
    const done = runCopySession(deps);
    await tick();
    shutting = true;
    f.stdin.write("\r");
    expect(await done).toBe("enter");
    expect(f.out).not.toContain(ALT_SCREEN_ON);
    expect(f.raw).toEqual([false]);
    expect(log).toEqual(["suspended:true", "suspended:false"]);
  });
});
