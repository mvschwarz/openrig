# Non-interruptive mode

Use `rig up <source> --non-interruptive` or `rig bundle install <archive-or-link> --non-interruptive`
to accept supported harness first-launch warnings for this rig. Sessions remain interactive.
This does not sign in to a provider or change any seat's permission policy.

The option applies only to seats whose resolved launch posture is `full_bypass`.
This must be declared through `builtin:yolo`, a `full_bypass` flag policy, or an explicit `full_bypass` selection;
ambient `OPENRIG_YOLO` alone without an attached policy is not covered.

- Claude Code receives `--settings '{"skipDangerousModePermissionPrompt":true}'`, accepting its bypass-permissions warning.
  A seat with an explicitly selected native permission mode other than `bypassPermissions` doesn't get it.
- Codex receives per-launch `-c notice.…=true` overrides for the full-access and GPT-5.1 migration notices.
  The separate GPT-5.1-Codex-Max migration notice is not suppressed.
- Pi's existing launch flags are unchanged.

OpenRig saves the choice on the rig. Later launches, restores, forks and handovers keep it, including
when the option is omitted. To turn it off, first stop the rig with `rig down <rig-name>`, then run
`rig up <rig-name> --existing --no-non-interruptive`. The choice is cleared for this and subsequent
launches. If the rig is still running, the command is refused before the choice changes. `--plan`
changes nothing. Disabling the mode does not erase acceptance that a person previously saved in the harness.
Turning it on for an existing rig works the same way: `rig down <rig-name>`, then
`rig up <rig-name> --existing --non-interruptive`. Rigs created before this option existed start with it off.

For an operator default on **new rigs**, use `rig config set launch.non_interruptive true`, or set
`OPENRIG_LAUNCH_NON_INTERRUPTIVE` in the daemon's environment (it overrides the config file).
The default is false; an explicit positive or negative command-line flag overrides it. Existing rigs
keep their saved choice when the operator default changes. On a remote install the receiving daemon's
default applies.

`rig up` and `rig bundle install` print what happened as warnings: "Non-interruptive mode is saved for this rig…"
when it is on (also on each restore), "Non-interruptive mode is off for this rig's launches…" when you turn it off,
and, for each affected seat, "Non-interruptive: OpenRig accepted Claude's bypass-permissions warning" or "…hid
Codex's full-access and GPT-5.1 migration notices… no warning-acceptance settings were written."

A bundle's before-install view (`rig bundle inspect`) says when this option is available for its full-bypass
Claude and Codex seats, and that Claude Code asks once to accept its warning otherwise. See
[bundle formats](bundle-formats.md).

This feature writes no warning-acceptance settings to Claude or Codex files. It uses the launch-flag
surfaces checked in Claude Code 2.1.282 and Codex 0.153.4. Other notices introduced by later harness
versions, sign-in, and harness preconditions can still require attention. Ordinary launches without
an opt-in keep their existing behaviour.

## Bundle or rig default

A pod-aware `rig.yaml` may declare `non_interruptive: true` alongside its
permission policy. This saves the choice on the installed rig without requiring
a CLI flag. Explicit `--non-interruptive` or `--no-non-interruptive` wins over
the spec; a declared boolean wins over the machine's `launch.non_interruptive`
default. A declaration of `false` is distinct from omission. Exports include
`non_interruptive: true` when enabled; disabled or unset choices omit the key
because saved state does not distinguish their origin. Restores of the existing
rig retain its saved choice.

The before-install view reports this declaration as
`posture[].nonInterruptiveDefault` for full-bypass Claude/Codex seats, separately
from `nonInterruptive: available`. It leaves `nativeEffect: unknown`: explicit
launch choices, sign-in and unsupported harness notices still apply. This field
does not broaden the rig's permission policy or add warning flags to Pi.
