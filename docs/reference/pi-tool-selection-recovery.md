# Pi tool-selection recovery

Use this when a live Pi conversation has fewer active tools than its operator
currently intends. This does not establish why the selection changed or that
stock Pi/OpenRig lost tools. The motivating report used a customized Pi 1.4.0
deployment; it is not a stock cross-platform reproduction.

## Diagnose before changing the selection

Confirm the exact seat, occupant and conversation, then use an idle boundary.
Preserve pending work and reconcile unknown writes before any replacement.
Keep four things separate:

- **Configured:** the effective merged `defaultTools` setting. Do not infer it
  from one settings file; retain any unresolved patterns or modifiers as such.
- **Currently intended:** the tools the operator wants enabled now, including
  deliberate exclusions. Configuration alone does not establish that intention.
- **Registered:** names the current Pi runtime knows about.
- **Active:** names returned by `getActiveTools`, which can differ from both.

A live RPC connection does not prove the tools are usable. Record observation
time and conversation binding; an unavailable query stays unknown. Reloading
unchanged settings can retain session-disabled tools by design, so a reload
that restores nothing is not itself evidence of accidental loss.

## Choose the interface the seat actually has

Pi 1.4.0 includes an opt-in selector at
`packages/coding-agent/examples/extensions/tools.ts` in the Pi repository. Its
`/tools` command remembers selection per branch and needs Pi's own TUI. Use it
where that extension and native TUI are available. **Do not send `/tools` to an
agent OpenRig drives over RPC**: that interface cannot operate the selector.

For RPC seats, a community-maintained helper used to provide read-only status
and a command that added only named intended tools. That helper is no longer
available, and OpenRig doesn't bundle or replace it. If you load a different
extension for this, review it yourself, opt in through Pi's per-seat extension
configuration, and verify what the target session actually loaded after the
supported activation path.

For an agent OpenRig drives over RPC, send an extension's command with
`rig send <agent> --raw "<command>"` so it arrives without a messaging envelope;
the usual interactive-prompt guard still applies.

Whatever makes the change, add only the names that are intended now. Recovery
doesn't mean restoring every configured default: if `bash` was deliberately
disabled, leave it disabled unless the operator explicitly intends to add it
too. If the seat has no way to change and verify the selection in place, report
that capability gap, as the end of this page describes.

## Verify the recovery

1. Establish the explicit current intended names. Reject unregistered or hidden
   requested tools before changing anything; do not infer replacement names.
2. Preserve current active extras: `setActiveTools` **replaces** the selection,
   so pass the union of current active names and only the requested names. It can
   ignore names it cannot activate; sending the command is not proof of recovery.
3. Read `getActiveTools` back. Retain a before/after receipt with the intended
   names and any missing names, then make a harmless actual call to a recovered
   tool within the existing task authority. Listed-active is not proof of usable
   permissions or working execution.

This changes tool selection, not permission policy, task authority or conversation
identity. It does not automatically persist a new branch selection; verify again
after branch navigation or reload. If the runtime cannot support or verify this
in place, report that capability gap and follow its supported replacement path
with retained work. Do not manufacture a fresh conversation or claim that another
harness has Pi's capabilities.
