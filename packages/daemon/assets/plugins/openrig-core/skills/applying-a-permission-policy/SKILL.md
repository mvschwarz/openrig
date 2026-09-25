---
name: applying-a-permission-policy
description: >-
  Use when a user asks an agent to configure OpenRig command permissions, reduce
  repeated native approval prompts, or apply a selected rig/seat permission policy.
metadata:
  openrig:
    stage: established
    docs_checked: "2026-09-25"
    verification_status: "Verify the installed harness version and effective settings; a rule-parser result is not a native permission test."
---

# Applying a permission policy

Configure the user's chosen permissions in the harness that runs the agent.
OpenRig operating posture, native command rules, sandbox access and launch flags
are separate controls. A command rule grants execution capability, not authority
to invent tasks, publish work or change another host.

## Choose the intended scope

Use an existing explicit choice; otherwise explain these options and ask which
the user wants. Do not ask again for routine steps already authorized.

| Choice | What the agent configures |
| --- | --- |
| Keep prompts | Preserve current native settings and handle requests when they arise. |
| Remember selected commands | Add native allow rules for the chosen family or narrower verbs, leaving other rules and sandbox settings intact. |
| Broader permissive operation | Explain filesystem/network exposure and configure only the explicitly selected native mode and compatible launch settings. |

**Allowing the whole `rig` family covers all its verbs**, including lifecycle,
topology/config changes and commands that can launch other processes. It is not
a read-only grant. Offer narrower prefixes such as `rig ps` or `rig queue list`
when that better fits the request. Do not widen a choice to arbitrary shell
execution, an entire interpreter or a generic shell wrapper.

## Apply the choice for the user

1. Identify the target seat, executable/version, launch settings and config roots:
   `HOME`, `CODEX_HOME` or `CLAUDE_CONFIG_DIR` as applicable. They may differ between
   operator, daemon and seat. Resolve the intended user's/project's files before
   writing; do not repair another home to make the paths agree.
2. Read relevant existing permission rules and managed restrictions. Select the
   intended scope: one project or the user's sessions. Consult installed native
   help and official references below when formats differ.
3. Prepare a concrete diff. Preserve deny/ask rules, approval/sandbox posture,
   hooks, auth, MCP, model settings and unrelated values. An allow must not erase
   a stricter rule or managed requirement. Report a real conflict instead of
   silently bypassing it.
4. Back up touched files and merge only authorized additions, avoiding duplicates.
   The agent performs these edits; hand-editing is an option, not a required user
   chore. Apply the selected scope without another conversational permission round.
   Native enforcement still applies.
5. Read back the diff and validate the format. Confirm how that version loads
   changes. If it requires a new session, preserve work and use its supported
   resume path within the user's authority; a file write does not prove that an
   existing conversation loaded it.
6. Verify an ordinary matching operation twice in the target conversation and
   check that an unrelated command gained no matching rule. Use harmless reads,
   not destructive probes. Report effective settings and remaining prompts.
   A parser match alone does not establish native behavior.

For rollback, remove only this setup's additions, preserving later unrelated
edits. Builtin policy specs remain read-only; customize in user space.

## Codex command rules

Codex command rules can allow matching commands outside the sandbox without
another prompt. They leave other sandbox/network settings unchanged.
Check `codex --version` and `codex execpolicy check --help`.
See the [official rules reference](https://learn.chatgpt.com/docs/agent-configuration/rules).

Choose the destination **before writing**, according to the user's scope:

- **This project only:** verify the installed version supports project rules and
  derive this session's actual project/worktree config root and trust state.
  Current docs describe `<repo>/.codex/rules/` in a trusted project config layer.
  Use that layer only after confirming it is supported, active and trusted for
  the intended project. If any of those facts is unsupported or unverified,
  report the limitation and leave user-layer rules unchanged; do not silently
  mark a project trusted or substitute a user-wide allowance.
- **Explicitly user-wide:** use `rules/` under the target user's actual
  `CODEX_HOME` (normally `~/.codex/rules`). This can affect other projects using
  that home. The TUI's remember-allow action also writes a user-layer rule;
  do not use it to implement a project-only request.

Merge the chosen rule into a `.rules` file in the selected layer. The prefix
itself has no project restriction; even a project-layer rule does not constrain
which targets an allowed `rig` command can affect:

```python
prefix_rule(pattern = ["rig"], decision = "allow")
```

For narrower access use `["rig", "ps"]` or `["rig", "queue", "list"]`, adjusting
examples. For absolute-path invocations, derive the target seat's actual `rig`
executable and add that exact path as a separate prefix; a bare rule does not
match it. Never copy another machine's path.

```sh
codex execpolicy check --pretty --rules /absolute/path/to/openrig.rules -- rig ps --json
codex execpolicy check --pretty --rules /absolute/path/to/openrig.rules -- printf permission-check
```

Inspect matches, not only exit status; repeat `--rules` for other effective
files. A matching `prompt` or `forbidden` overrides allow. Verify rule loading
in the target conversation after the required reload. For project-only scope,
confirm the layer is active there and absent from an unrelated project's active
layers. An evaluator given an explicit `--rules` file proves matching, not that
scope or automatic loading. Existing user-wide rules may already permit the
same command: preserve and disclose them, attribute matches, and do not claim
project isolation or remove those rules without a separate authorized choice.

The standalone evaluator checks supplied argv; native shell parsing can split
ordinary commands/chains first. A raw `zsh -lc` non-match does not prove that
native `rig && rig` fails. Verify both surfaces without broadening the rule to
`bash`, `sh`, `node` or generic wrappers.

## Claude Code command rules

Check `claude --version` and [official permission syntax](https://code.claude.com/docs/en/permissions).
Merge the chosen entry into existing `permissions.allow`; this fragment is not
a replacement settings file:

```json
{
  "permissions": {
    "allow": ["Bash(rig *)"]
  }
}
```

Current syntax uses ` *` for a command family; `Bash(rig:*)` is also supported.
Narrower examples are `Bash(rig ps *)` and `Bash(rig queue list *)`.
Preserve `deny`/`ask` entries and `defaultMode`; do not add `Bash(*)` or switch
to bypass to resolve a mismatch. Inspect native `/permissions` and verify the
actual command spelling.

Choose scope using the [settings reference](https://code.claude.com/docs/en/settings):
`.claude/settings.local.json` for personal project settings,
`.claude/settings.json` for deliberately shared project settings, or
`settings.json` under the target's `CLAUDE_CONFIG_DIR` (normally `~/.claude`).
Confirm the effective project root, especially for worktrees. Keep personal
settings out of commits. Managed restrictions and sandbox/network controls
still apply; a Bash allow is not a general network policy.

## Existing policies and broader modes

For a named policy, read its actual `permission_policy` spec and `source` marker.
Translate intended actions using supported native controls; do not collapse all
Codex policies to a single posture or claim shell patterns perfectly express
semantic actions such as force-push. Preserve stricter rules. If exact translation
is unavailable, explain the remaining choice instead of selecting broader access.

For explicitly chosen broader operation, inspect
`rig policy current --spec <user-owned-rig.yaml>` and the compatible getting-started guide's **Opt-in permissive
operation** section. OpenRig's Codex `builtin:yolo` supplies `-s danger-full-access`;
it does not itself select `approval_policy` and replaces a named
`codex_config_profile` argument. Claude's corresponding launch flag is
`--dangerously-skip-permissions`. Neither a resource `profile: default` nor OpenRig
operating posture is a native permission policy. Do not change shipped defaults
or assume editing a launch spec changes an existing seat.

A headless seat may wait at a native prompt. Arrange an answer path or choose
suitable command rules; unattended work is not implicit consent to bypass.
For Pi, the previously supported `--approve`/`--no-approve` surface concerns
project-resource trust, not shell permissions; verify its installed capabilities
instead of treating those flags as a command allowlist.
