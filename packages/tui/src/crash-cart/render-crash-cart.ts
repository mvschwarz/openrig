// Crash-cart cockpit RENDERER (5.2 Wave B, plan c015d9ed §C3) — model → rows, reproducing the
// approved mock (3d3c90a0) structure/ordering/emphasis in the TUI idiom. Glyph set ◌/▦/⏎/✓ and the
// section wording are CONTRACT; theme tokens only (no invented colors). Bold text carries a color
// token (`bright`) because a bold-only seg renders as plain ink in this pipeline.
import type { Token } from "../theme.js";
import type { CrashCartModel } from "./crash-cart-model.js";
import type { DaemonUnverifiedEvidence } from "./contract.js";
import type { RestoreLifecycleVM } from "./restore-lifecycle.js";
import { renderTriage } from "./triage.js";

interface Seg {
  text: string;
  token?: Token;
  bold?: boolean;
  bg?: Token;
  inverse?: boolean;
}
interface Line {
  text: string;
  segs?: Seg[];
  selected?: boolean;
}

/** Build a Line whose plain `text` is the concat of its segs (capture/width truth). */
function line(segs: Seg[], opts?: { selected?: boolean }): Line {
  return { text: segs.map((s) => s.text).join(""), segs, ...(opts?.selected ? { selected: true } : {}) };
}

/** The daemon-down header: `◌ daemon not running` (warn) + the dim status tail. The uptime + reason
 *  slots render EXPLICIT honest-unknown text (PM ruling) — structure/ordering per the mock. */
export function renderCrashCartHeader(model: CrashCartModel): Line {
  const h = model.header;
  return line([
    { text: "◌ daemon not running", token: "warn" },
    {
      text: ` — last seen ${h.lastSeen} (uptime ${h.uptimeText}) · reason: ${h.reasonText}`,
      token: "dim",
    },
  ]);
}

/** `FOUND ON THIS HOST` + one row per rig: `▦ <name>  <n> seats · last active <t> · <r> sessions resumable`.
 *  Name column is padded to the widest name + a 4-space gap so the details align (the mock's fixed columns). */
export function renderFoundOnHost(model: CrashCartModel): Line[] {
  const out: Line[] = [line([{ text: "FOUND ON THIS HOST", token: "dim" }])];
  const nameCol = Math.max(0, ...model.foundOnHost.map((r) => r.name.length)) + 4;
  for (const r of model.foundOnHost) {
    const pad = " ".repeat(Math.max(0, nameCol - r.name.length));
    out.push(
      line([
        { text: " ▦ " },
        { text: r.name, token: "bright", bold: true },
        { text: pad },
        {
          text: `${r.seatCount} seats · last active ${r.lastActive} · ${r.resumableCount} sessions resumable`,
          token: "dim",
        },
      ]),
    );
  }
  return out;
}

/** `WHERE WORK STOPPED (from the durable ledgers)` + one `◌ <session> — qitem in-progress: "<summary>" (<t>)`
 *  per in-progress item, then always the `✓ everything else idle-clean at stop` closing line. */
export function renderWhereWorkStopped(model: CrashCartModel): Line[] {
  const out: Line[] = [
    line([
      { text: "WHERE WORK STOPPED", token: "dim" },
      { text: " (from the durable ledgers)", token: "dim" },
    ]),
  ];
  for (const w of model.whereWorkStopped) {
    out.push(
      line([
        { text: " ◌ ", token: "warn" },
        { text: w.session },
        { text: ` — qitem in-progress: "${w.summary}" (${w.time})`, token: "dim" },
      ]),
    );
  }
  out.push(line([{ text: " ✓ ", token: "ok" }, { text: "everything else idle-clean at stop" }]));
  return out;
}

/** The actions block: the highlighted primary `⏎ RESTORE EVERYTHING …` row + the secondary key row. */
export function renderActions(): Line[] {
  return [
    line(
      [
        {
          text: " ⏎ RESTORE EVERYTHING — daemon + kernel + all rigs, sessions resumed in their seats ",
          bg: "accent",
        },
      ],
      { selected: true },
    ),
    line([
      { text: "  s start daemon only  ·  i inspect a rig  ·  n new here? onboarding" },
      { text: " (policy menu lives here now)", token: "dim" },
    ]),
  ];
}

/** First-run framing (DOWN + no DB): a fresh host, NOT a crash — onboarding, never a crash header or
 *  a RESTORE-of-nothing (PM ruling: crash language requires evidence of prior life). */
export function renderFirstRunView(): Line[] {
  return [
    line([
      { text: "◌ no daemon running", token: "warn" },
      { text: " — no rigs found on this host yet (a fresh host)", token: "dim" },
    ]),
    { text: "" },
    line([{ text: "Nothing to restore — this looks like a first run.", token: "dim" }]),
    { text: "" },
    line([{ text: " ⏎ n new here? onboarding (policy menu lives here now) ", bg: "accent" }], { selected: true }),
    line([{ text: "  s start daemon only" }]),
  ];
}

/** The whole crash-cart cockpit view: recovery = header → FOUND ON THIS HOST → WHERE WORK STOPPED →
 *  actions (mock-verbatim ordering); first-run = onboarding framing. */
export function renderCrashCartView(model: CrashCartModel): Line[] {
  if (model.mode === "first-run") return renderFirstRunView();
  return [
    renderCrashCartHeader(model),
    { text: "" },
    ...renderFoundOnHost(model),
    { text: "" },
    ...renderWhereWorkStopped(model),
    { text: "" },
    ...renderActions(),
  ];
}

/** Glyph for a per-rig progress row by its rollup outcome. */
function outcomeGlyph(outcome: string): { glyph: string; token: Token } {
  switch (outcome) {
    case "fully_restored":
      return { glyph: "✓", token: "ok" };
    case "partially_restored":
      return { glyph: "◑", token: "warn" };
    case "failed":
      return { glyph: "✗", token: "error" };
    default:
      return { glyph: "◌", token: "dim" }; // not_attempted
  }
}

/** The RESTORE LIFECYCLE view (B1 ROUND 2). While running: a live header + a per-rig progress list
 *  updated from each poll (the rollup stream) + the cancel affordance. When done: the verdict + counts
 *  and the SHIPPED keyboard-walkable triage list (renderTriage) — each seat/rig on its own row with its
 *  EXACT need, NOT a width-clipped one-line footer summary. */
export function renderRestoreLifecycleView(vm: RestoreLifecycleVM): Line[] {
  const c = vm.counts;
  const total = c.fully_restored + c.partially_restored + c.failed + c.not_attempted;
  const countsSeg: Seg = {
    text: `${c.fully_restored} restored · ${c.partially_restored} partial · ${c.failed} failed · ${c.not_attempted} not attempted`,
    token: "dim",
  };

  if (vm.phase === "running") {
    const out: Line[] = [
      line([
        { text: "⟳ RESTORING FLEET", token: "bright", bold: true },
        { text: `  — ${total} of the fleet done so far`, token: "dim" },
      ]),
      line([countsSeg]),
      { text: "" },
    ];
    for (const p of vm.progress) {
      const g = outcomeGlyph(p.outcome);
      out.push(line([{ text: ` ${g.glyph} `, token: g.token }, { text: p.rigId, token: "bright" }, { text: `  ${p.outcome}`, token: "dim" }]));
    }
    out.push({ text: "" });
    out.push(line([{ text: "  c cancel (stop-before-next-rig)  ·  restore continues per rig", token: "dim" }]));
    return out;
  }

  // done
  const out: Line[] = [
    line([
      { text: `✓ FLEET RESTORE: ${vm.verdict}`, token: "bright", bold: true },
      ...(vm.cancelled ? [{ text: " (cancelled)", token: "warn" as Token }] : []),
    ]),
    line([countsSeg]),
    { text: "" },
    // The shipped triage renderer — one keyboard-walkable row per need (seat + exact remediation),
    // or the all-clean line. This is the surface the door test asserts.
    ...renderTriage(vm.triage),
  ];
  return out;
}

/** The UNVERIFIED screen (planner+PM ruling): a minimal DISTINCT view — evidence VERBATIM + retry +
 *  quit + the rig-status hint, and ZERO recovery actions (never the cockpit, never RESTORE). */
export function renderUnverifiedView(evidence: DaemonUnverifiedEvidence): Line[] {
  return [
    line([
      { text: "◌ cannot verify the daemon", token: "warn" },
      { text: " — may be busy/wedged, not confirmed down", token: "dim" },
    ]),
    { text: "" },
    line([{ text: " pid:    ", token: "dim" }, { text: evidence.pidState }]),
    line([{ text: " probe:  ", token: "dim" }, { text: evidence.probeResult }]),
    line([{ text: " signal: ", token: "dim" }, { text: evidence.failedSignal }]),
    { text: "" },
    line([{ text: "  r retry  ·  q quit  ·  try: rig status", token: "dim" }]),
  ];
}

// The full-width Screen wrappers (renderCrashCartScreen/renderUnverifiedScreen/linesToScreen) were
// REMOVED in the shell-placement rework (ruling 3c6c2be0): the cockpit now renders as a content-pane
// view inside the standard shell (render.ts crashCartShell), so the content builders above produce
// Line[] and the shell owns the Screen. The full-width stylize branch that only they used is gone too.
