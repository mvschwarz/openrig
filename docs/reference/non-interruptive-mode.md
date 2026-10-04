# Non-interruptive mode

Use `rig up <source> --non-interruptive` or `rig bundle install <archive-or-link> --non-interruptive`
to accept supported harness first-launch warnings for this rig. Sessions remain interactive.
This does not sign in to a provider or change any seat's permission policy.

The option applies only to seats whose resolved launch posture is `full_bypass`.
This must be declared through `builtin:yolo`, a `full_bypass` flag policy, or an explicit permission selection;
ambient `OPENRIG_YOLO` alone without an attached policy is not covered.

- Claude Code receives `--settings '{"skipDangerousModePermissionPrompt":true}'`, accepting its bypass-permissions warning.
- Codex receives per-launch `-c notice.…=true` overrides for the full-access and GPT-5.1 migration notices.
  The separate GPT-5.1-Codex-Max migration notice is not suppressed.
- Pi's existing launch flags are unchanged.

OpenRig saves the choice on the rig. Later launches, restores, forks and handovers keep it, including
when the option is omitted. `rig up <rig-name> --existing --no-non-interruptive` turns it off for that
rig's subsequent launches. `--plan` changes nothing. Disabling the mode does not erase acceptance
that a person previously saved in the harness.

For an operator default on **new rigs**, use `rig config set launch.non_interruptive true`.
The default is false; an explicit positive or negative command-line flag overrides it. Existing rigs
keep their saved choice when the operator default changes. On a remote install the receiving daemon's
default applies.

This feature writes no warning-acceptance settings to Claude or Codex files. It uses the launch-flag
surfaces checked in Claude Code 2.1.282 and Codex 0.153.4. Other notices introduced by later harness
versions, sign-in, and harness preconditions can still require attention. Ordinary launches without
an opt-in keep their existing behaviour.
