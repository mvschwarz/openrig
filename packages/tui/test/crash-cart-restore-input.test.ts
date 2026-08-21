// B1 ROUND 4 — the CLASS test (r1's design): the crash-cart restore surface must never ADVERTISE a
// capability the state cannot honour. The test list is driven from what the render ADVERTISES (footer
// keys / action line), NOT from the handlers — an advertised-but-unwired key has no handler to enumerate
// from, which is exactly how the four prior gaps hid. For every phase × render-state we render, extract
// the affordances the screen offers, and assert each one ACTS via the pure restoreKeyAction reducer;
// and we assert the converse — a state that has dropped an affordance does not still honour it.
import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { buildRestoreLifecycleVM, type RestoreFrame } from "../src/crash-cart/restore-lifecycle.js";
import { restoreKeyAction, type RestoreInputEvent, type RestoreAction } from "../src/crash-cart/restore-input.js";

const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

function frame(over: Partial<RestoreFrame> & { rows?: number }): RestoreFrame {
  const rows = over.rows ?? 1;
  return {
    attemptId: "fleet-1",
    phase: over.phase ?? "running",
    done: over.done ?? false,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "none_attempted",
    rollup: over.rollup ?? {
      counts: { fully_restored: rows, partially_restored: 0, failed: 0, not_attempted: 0 },
      sequence: Array.from({ length: rows }, (_, i) => ({ rigId: `rig${i}`, outcome: "fully_restored" })),
      attention_required: [],
    },
  };
}

// The affordances the render advertises → the key that must honour each. Derived from the RENDERED TEXT.
function advertised(bodyText: string): Array<{ label: string; ev: RestoreInputEvent; acts: (a: RestoreAction) => boolean }> {
  const out: Array<{ label: string; ev: RestoreInputEvent; acts: (a: RestoreAction) => boolean }> = [];
  if (/\bc cancel\b/.test(bodyText)) out.push({ label: "c cancel", ev: { type: "char", ch: "c" }, acts: (a) => a.kind === "cancel" || a.kind === "cancel-reattach" });
  if (/\br reattach\b/.test(bodyText)) out.push({ label: "r reattach", ev: { type: "char", ch: "r" }, acts: (a) => a.kind === "reattach" });
  if (/scroll/.test(bodyText)) out.push({ label: "scroll", ev: { type: "key", key: "down" }, acts: (a) => a.kind === "scroll" });
  if (/dismiss/.test(bodyText)) out.push({ label: "dismiss", ev: { type: "char", ch: "x" }, acts: (a) => a.kind === "dismiss" });
  return out;
}

function renderState(vm: ReturnType<typeof buildRestoreLifecycleVM>, rows = 32) {
  const screen = renderScreen(view.get(), snap, { cols: 120, rows, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: 0 });
  return { screen, body: screen.lines.join("\n"), maxOffset: screen.contentMaxOffset };
}

const STATES: Array<{ name: string; vm: () => ReturnType<typeof buildRestoreLifecycleVM>; rows?: number }> = [
  { name: "running / normal", vm: () => buildRestoreLifecycleVM(frame({ phase: "running" })) },
  { name: "running / cancelled", vm: () => buildRestoreLifecycleVM(frame({ phase: "running", cancelled: true })) },
  { name: "detached / normal", vm: () => buildRestoreLifecycleVM(frame({ phase: "detached", done: false })) },
  { name: "detached / cancelled", vm: () => buildRestoreLifecycleVM(frame({ phase: "detached", done: false, cancelled: true })) },
  { name: "done", vm: () => buildRestoreLifecycleVM(frame({ phase: "done", done: true, verdict: "all_fully_restored" })) },
  // overflow variants — 28 rows, so the footer advertises scroll and the action row is below the fold
  { name: "running / overflow", vm: () => buildRestoreLifecycleVM(frame({ phase: "running", rows: 28 })) },
  { name: "detached / overflow", vm: () => buildRestoreLifecycleVM(frame({ phase: "detached", done: false, rows: 28 })) },
  { name: "done / overflow", vm: () => buildRestoreLifecycleVM(frame({ phase: "done", done: true, verdict: "mixed", rows: 28 })) },
];

describe("CLASS: every affordance the screen advertises ACTS in that state", () => {
  const seen = new Set<string>();
  for (const s of STATES) {
    it(`${s.name}: each advertised affordance is honoured by the reducer`, () => {
      const vm = s.vm();
      const { body, maxOffset } = renderState(vm);
      for (const ad of advertised(body)) {
        seen.add(ad.label);
        const action = restoreKeyAction(ad.ev, { phase: vm.phase, cancelled: vm.cancelled, offset: 0, maxOffset });
        expect(ad.acts(action), `${s.name} advertises "${ad.label}" but the reducer returned ${action.kind}`).toBe(true);
      }
    });
  }
  it("the matrix is NON-VACUOUS — every affordance type was advertised (and honoured) by some state", () => {
    expect([...seen].sort()).toEqual(["c cancel", "dismiss", "r reattach", "scroll"]);
  });
});

describe("CONVERSE: a state that dropped an affordance does not still honour it (HIGH-1)", () => {
  it("running / cancelled does NOT advertise 'c cancel' AND c does not fire a second cancel", () => {
    const vm = buildRestoreLifecycleVM(frame({ phase: "running", cancelled: true }));
    const { body } = renderState(vm);
    expect(/\bc cancel\b/.test(body)).toBe(false); // the render dropped it
    expect(body).toContain("cancellation requested"); // and SAYS cancellation is in flight (r2 HIGH-1)
    const action = restoreKeyAction({ type: "char", ch: "c" }, { phase: "running", cancelled: true, offset: 0, maxOffset: 0 });
    expect(action.kind).toBe("none"); // c is swallowed, not a fresh cancel
  });

  it("detached / cancelled does NOT advertise 'c cancel'; c reattaches to confirm, not re-cancels", () => {
    const vm = buildRestoreLifecycleVM(frame({ phase: "detached", done: false, cancelled: true }));
    const { body } = renderState(vm);
    expect(/\bc cancel\b/.test(body)).toBe(false);
    expect(body).toContain("cancellation requested");
    const action = restoreKeyAction({ type: "char", ch: "c" }, { phase: "detached", cancelled: true, offset: 0, maxOffset: 0 });
    expect(action.kind).toBe("reattach"); // confirm, not a second cancel-reattach
  });
});

describe("HIGH-2: advertised scroll is REACHABLE to the action row in running + detached", () => {
  for (const phase of ["running", "detached"] as const) {
    it(`${phase} / overflow: footer advertises scroll, the reducer scrolls, and the action row is reachable at max`, () => {
      const vm = buildRestoreLifecycleVM(frame({ phase, done: false, rows: 28 }));
      const { body, maxOffset } = renderState(vm);
      expect(/scroll/.test(body)).toBe(true); // footer advertises it
      expect(maxOffset).toBeGreaterThan(0);
      // the reducer honours the advertised scroll key (the input branch, not renderScreen(restoreScroll:max))
      const scrolled = restoreKeyAction({ type: "key", key: "down" }, { phase, cancelled: false, offset: 0, maxOffset });
      expect(scrolled).toEqual({ kind: "scroll", offset: 1 });
      // driving to max via the reducer, the action row is on-screen
      const atMax = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: maxOffset });
      const maxBody = atMax.lines.join("\n");
      if (phase === "running") expect(maxBody).toContain("c cancel");
      else expect(maxBody).toContain("r reattach");
    });
  }
});
