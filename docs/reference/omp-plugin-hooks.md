# Plugin hooks in OMP

Selected Claude and Codex plugin hooks run inside seats configured with `runtime: omp-tui` through
`assets/omp/openrig-plugin-hooks.js`. A plugin with an applicable native OMP extension uses
that extension first. A dual Claude/Codex manifest defaults to Claude; an explicit
`plugin_type` selects the requested manifest. Each registry file is loaded once.

The adapter loads `hooks/hooks.json` and the selected manifest's inline or file-based
`hooks` declaration, copies the complete plugin with binary bytes and executable modes,
and records the current selection in `selected-plugin-hooks.json`. Deselected hook plans
are removed on projection. Portable skills continue to load without an extension warning.

Command hooks receive JSON on stdin, the seat's working directory, session identity,
plugin-root environment variables and translated native tool names. Results can block a
prompt/tool, revise tool input, supply model context, or request Stop continuation. Matching
commands run concurrently; a denial wins over an allowance. Failures and malformed output
are recorded as `openrig-plugin-hook-error` entries. A nonzero exit other than 2 reports an
error; exit 2 blocks at a blocking event. Runtime-specific tool arguments are mapped for
ordinary command/file tools; this does not translate an entire foreign tool implementation.

| Foreign event | OMP event |
| --- | --- |
| SessionStart / SessionEnd | session_start, session_switch, session_branch / session_shutdown |
| UserPromptSubmit | input (interactive TUI and RPC; not print/JSON on stock OMP) |
| PreToolUse | tool_call |
| PostToolUse / PostToolUseFailure | tool_result, according to isError |
| PostToolBatch | turn_end with tool results |
| Stop | session_stop |
| StopFailure | agent_end with a terminal error |
| PermissionRequest / permission Notification | tool_approval_requested |
| PreCompact / PostCompact | session_before_compact / session_compact |
| SubagentStart / SubagentStop | session_start / subagent_stop in a child session |

Stock OMP 18.21.0 is the supported baseline. No OMP source patch or custom API is
required. PermissionRequest and SubagentStop hooks are skipped with startup warnings
on stock OMP. PreToolUse deny and input rewrites work; an allow result does not bypass
OMP's native approval prompt. Notification hooks still observe permission requests.
Warnings appear in the TUI and as `openrig-plugin-hook-warning` session entries.
The seat sidecar reports the baseline approval, child-stop and timeout capabilities.
Explicit native APIs, when available, remain feature-detected by the bridge.

HTTP hooks send the same input as a JSON POST, bound response size, and interpolate header
variables only from `allowedEnvVars`. Prompt hooks use an isolated native model session
without tools; agent hooks expose only read, grep and glob. Both honor the selected model,
deadline and `{ok, reason}` response, and do not discover extensions recursively.
Command handlers support shell and executable/args forms, background execution,
`asyncRewake`, and explicit `onFailure: "block"`. Background outputs reach a subsequent
model request; decisions cannot block an already running tool. Background children are
cancelled on session switch and shutdown. The eight-background-job bound reports overflow.
`once` is ignored in plugin/settings registries, matching its skill-only scope.

Stock blocking hooks have a shared 25-second dispatch budget and a 1.5-second shutdown
budget. Background command hooks can use their configured timeout, but cannot block a
tool that has already started. Output is capped at 1 MiB, with process-group cleanup
on cancellation, timeout or overflow.

Unsupported event names, conditional `if` handlers and `mcp_tool` handlers are skipped
individually with projection warnings; supported hooks and conventional plugin skills
remain available. Malformed manifests, invalid matchers and escaping paths still fail
projection. Permission-stage input and persistent permission rewrites are unsupported.
Foreign transcripts remain OMP transcripts; aliases do not translate every tool schema.
Custom plugin skill paths and runtime-resource/subagent projection remain gaps.

Managed seat skills use stock extension-package discovery (`-e` with the seat's
managed storage root, which contains `skills/`). This adds the seat's skills without
replacing native `skills.customDirectories` or editing the user's settings. `rig skill`
can inspect and reconcile OMP seat storage; newly installed skills require a native
reload or relaunch. Fresh launch and resume both include the same managed root.
Both OMP modes default to `always-ask` outside the kernel rig. The kernel rig defaults to `yolo`. An explicit member or rig permission policy controls its seat’s launch posture.

The shared projection and executable-mode tests run identical fixtures through
ClaudeCodeAdapter, CodexRuntimeAdapter and OmpTuiRuntimeAdapter. These are adapter tests.
Native OMP tests separately exercise real commands and an offline custom provider;
they do not certify live Claude/Codex providers or deployment to an existing rig.
