# SSH tmux relay qualification

Scope: fork implementation for upstream issue
https://github.com/mvschwarz/openrig/issues/1723 and WebMux issue
https://github.com/jordanhubbard/webmux/issues/176. No production daemon or
existing agent session was restarted or reconfigured.

2026-10-21 development evidence:

- Isolated Node 22.23.4, official archive SHA-256
  `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428`.
  Existing Homebrew Node 22 failed before execution because its simdutf dylib was
  missing; that installation was not changed.
- CLI, daemon, UI and TUI build; typecheck passed at the initial patch stage.
- 93 focused relay, attach API and existing route tests passed after correcting
  optional-column handling in older partial-schema fixtures.
- Actual WebMux runner launched a private daemon, private local tmux server,
  a macOS SSH loopback Codex 0.163.0 session, and a separate Linux Codex 0.162.0
  session. Both reached `verified`; both returned their exact requested reply
  markers through real delivery (`RELAY_MAC_OK`, `RELAY_LINUX_OK`). The two actual
  agents also exchanged READY messages across the coordinator.
- The initial live launcher failed because it assumed the physical session name
  was the sender address. WebMux now preserves the returned canonical address.
- The first private tmux attempt exceeded macOS's Unix socket path length. Its
  failed log was retained; the private instance uses a shorter `/private/tmp`
  path. Native suite qualification also needs a short canonical TMPDIR.

These are actual provider sessions, not stub-model success claims. Their existing
provider/trust settings were used unchanged. Activity-hook and remote-origin
provenance warnings remained visible; no hook/telemetry qualification is claimed.
The stub runtime cannot establish native Codex identity; snapshot controls test
refusal semantics, and real SSH/Codex observations cover the native boundary.
Full-suite final results and the remote-shell negative control are recorded with
the final PR receipt, rather than inferred from the focused pass.

Final local gate receipt (2026-10-21): daemon 1,132 files / 19,965 tests
passed (13 skipped, 5 todo), CLI 5,251 passed, TUI 1,073 passed, and UI
1,745 passed. The final focused relay/attach/delivery gate passed 112 tests.
One earlier full run failed an unchanged prompt-alert timing assertion; its
68-test file passed in two focused reruns and the complete daemon retry passed.
Logs are retained under `/private/tmp/openrig-relay-*` on the qualification host.

The real Linux provider was replaced with a shell in the test-owned remote pane
while local SSH remained live. Delivery refused with `target_runtime_unverified`
and the attempted marker did not reach that shell. After restarting only the
private coordinator, the unchanged macOS provider remained verified and returned
`RELAY_RESTART_OK`. Both test-owned remote sessions and the private coordinator
were subsequently stopped; production sessions were preserved.
