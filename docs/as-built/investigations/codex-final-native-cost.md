# Native Codex final-observation test cost

Investigation on 2026-11-07, based on fetched upstream/main `f5b62726ff759a857eeb76e2cbd654493fedba2f`.
Reference proposal: `80ffd0644` on `origin/test/codex-final-budget`; its five 40-second ceilings are not adopted.
Host: macOS, Node 24.21.0, tmux 3.8. Tests use isolated fixture homes, private tmux sockets and a scripted
Node executable named `codex`; no authenticated provider or installed daemon is involved.

## Cause and measurement

The fixture replaces the polling sleep but retains the default 26 loop observations and one final read.
Until capture 27, each capture returns the same waiting screen. The staging shell remains foreground and
is not idle. Each loop checks the shell and then looks for Codex, repeating native process enumeration.
The final observation also checks the shell; inconclusive output makes it check for Codex again.

Temporary timing wrappers delegated to the real tmux runner and `listNativeProcesses`, measured with
`performance.now()`. Separate timers measured session creation, teardown and the two readiness polls.
No results were substituted. Readiness time overlaps capture time and must not be added to it.
The normal 15-second outer timeout and both five-second readiness deadlines stayed in force.

| Case | Before (s) | Process listings | Listing time (s) |
|---|---:|---:|---:|
| Access-token refusal | 14.970 | 53 | 11.262 |
| Incompatible client | 13.355 | 53 | 10.196 |
| Missing session | 14.734 | 53 | 11.297 |
| Ready prompt | 12.882 | 53 | 9.553 |
| Occupied staging wrapper | 12.612 | 54 | 9.235 |

All five passed in 68.56 seconds of test time (70.39 seconds Vitest wall time).
The first case was only 29 ms below its timeout. Across these cases tmux command execution cost
2.8–3.4 seconds; readiness polling cost 0.34–0.63 seconds total per case. Session creation cost
18–51 ms, and teardown 8–15 ms. Startup is bounded by the first readiness poll, which also includes
capture execution and polling intervals; these measurements do not isolate Node boot CPU time.

## Design and regression contract

Keep all five native cases and all existing assertions. Configure the existing adapter options for
200 ms maxWaitMs and 200 ms pollMs: two loop observations, one polling step, then the final read.
The sleep remains a no-op. Release output only on capture three, assert that the polling step has
already occurred, wait for the real terminal to render it, and return a real capture. This retains
native command staging, exact launch arguments, terminal rendering/capture, foreground labels,
OS process enumeration and idle-shell rejection.

Keep default-budget arithmetic in a separate fast adapter test matrix, with 26 loop observations
and the 27th final read. Also test the native fixture's two-loop budget and the minimum one-loop
budget. Each case asserts the result, evidence or exact message, total captures and polling calls.
The matrix uses process rows for an occupied shell; it does not claim native process coverage.

| Case | Regression it catches | Why native coverage remains useful |
|---|---|---|
| Access-token refusal | Final refusal becomes timeout, fresh retry or readiness; evidence is lost | Late text survives actual terminal capture |
| Incompatible client | Final upgrade notice loses recoverable attention or evidence | Same, for a distinct classifier pattern |
| Missing session | Explicit final failure is not a fresh retry | Real terminal text overrides the occupied-shell fallback |
| Ready prompt | Final positive evidence is discarded | Real rendered prompt overrides the shell label |
| Inconclusive wrapper | Shell label is mistaken for idle or ready | Real foreground lineage rejects idle-shell proof |

The repetition count itself needs no native execution. Reducing only that repeated work is justified
by the default-budget matrix and mutation checks, rather than assuming fewer observations are equivalent.
The generic stub runtime cannot exercise `CodexResumeAdapter`'s native staging and process checks;
these private-terminal cases cover that boundary directly. They do not prove real Codex behavior.

## Separate production follow-up

The production path deserves a separate investigation: the attempt budget includes polling intervals
but does not bound cumulative observation cost. Native process enumeration can enrich the whole host's
process table before the caller selects the target pane. A fixture Node script does not itself need
Codex argv enrichment, yet the listing may launch macOS helpers for unrelated foreground processes.

Do not remove stable two-sample identity checks or cache process evidence across observations just to
speed this up. A possible design is to select the pane's candidate lineage before enriching argv or
executable paths, retaining fresh before/after samples and conservative behavior on missing evidence.
No production code is changed here, and this report does not claim that redesign has been validated.

## Revised measurements

With the same timing instrumentation, the revised native suite took 9.91 seconds (86% less).
The native suite plus all 15 budget cases passed in 11.08 seconds wall time; the matrix itself took
about 15 ms. The figures exclude time queued for `testlock`; other agents were active on the host.
They are measurements under varying host load, not a timing SLA.

| Case | After (s) | Process listings | Listing time (s) |
|---|---:|---:|---:|
| Access-token refusal | 2.144 | 5 | 1.269 |
| Incompatible client | 2.645 | 5 | 1.399 |
| Missing session | 1.878 | 5 | 1.018 |
| Ready prompt | 1.587 | 5 | 0.833 |
| Occupied staging wrapper | 1.645 | 6 | 0.930 |

Adapter-runner tmux calls fell from 116–121 to 20–22 per case, plus two direct calls for session
creation/teardown. Capture counts include synchronization reads; those vary with terminal startup.
The product-facing capture count is exactly 27 before and exactly three after.

A further one-case run wrapped `readProcessTable`, `readNativeExecutablePaths` and
`readNativeProcessArguments`, delegating to their real implementations. Of 780 ms spent in five
listings, `ps` took 289 ms, executable-path helpers 238 ms, argv helpers 221 ms, leaving about
32 ms for other listing work. Each helper ran five times even though the fixture executable is Node.
This confirms host-wide enrichment contributes to the cost, rather than attributing all listing time
to `ps`. No command lines, process rows or credentials were included in the timing output.

## Proposed issue description (not filed)

Title: `Native Codex resume observations repeatedly enrich unrelated host processes on macOS`

At upstream `f5b62726f`, the private native final-observation fixture spends 9.2–11.3 seconds in
53–54 process listings per resume, even with polling sleep disabled. The observation checks whether
the staging shell is idle, then checks for Codex; both perform a fresh listing. `listNativeProcesses`
adds executable paths and exact argv for host-wide candidates before the target pane is selected.
In an instrumented reduced run, five listings launched five executable helpers and five argv helpers;
those helpers consumed 459 ms of the 780 ms listing total. The target fixture is a Node script.

Investigate target-scoped enrichment and unnecessary duplicate observations while retaining stable
identity samples, exact argv, ambiguity rejection and conservative unknown outcomes. Separately clarify
whether `maxWaitMs` is an attempt budget or an elapsed deadline: observation time is currently additive
to its polling intervals. Do not change that contract as a test-fixture fix.

Reproduce with the native final-observation test and timing wrappers around the existing tmux runner,
`listNativeProcesses` and its three underlying readers. Use a private tmux socket and isolated homes;
never launch an authenticated provider for this reproduction. Compare hosts with and without unrelated
foreground native processes. Validate any future optimization with changing/reused PIDs, foreground
changes, conflicting candidates and inaccessible argv; do not reuse stale proof across observations.

This issue is a separate performance investigation. The test-only change reduces redundant native
repetitions and preserves the default observation budget in a deterministic adapter matrix. It neither
fixes nor hides the measured per-observation production cost.

## Regression seeding and validation

Temporary production mutations were applied one at a time, both final-observation files were run,
and the original source was restored before the adjacent checks. Every seeded failure was an
assertion failure, not a timeout. The three matrix budgets account for three copies of each case,
plus its native copy.

| Seeded regression | Detected failures |
|---|---:|
| Replace final capture with empty content | All 20 cases |
| Skip final missing-session handling | Four missing-session cases |
| Return ready for final attention | Eight access-token/incompatible-client cases |
| Return attention for final readiness | Four ready-prompt cases |
| Treat final wrapper as a proven idle shell | Four occupied-shell cases |

After restoring production source, eight suites / 381 tests passed together, including all five
native cases, the 15 budget cases, `codex-resume`, `codex-resume-prove`, `codex-process-observation`,
`native-resume-probe`, `native-resume-probe-evidence`, and `codex-resume-command-daemon-flag`.
This uninstrumented native run took 9.52 seconds, with cases at 1.50–2.25 seconds; the combined
run took 11.29 seconds wall time. It exercises the native suite alongside seven other fixture suites.

All test and build/check invocations were prefixed with `testlock`; the mutation/check batch ran
under one `testlock python3` invocation, sequentially. No authenticated Codex or installed-daemon
changes were made. Full `npm test`, Linux execution and real-provider integration were not run.

`testlock npm run build`, `testlock npm run lint`, the documentation guard and `git diff --check`
also passed. No unrelated lint or test failures were encountered.

A sixth seed changed only the production default `maxWaitMs` from 5000 to 4800. All five
default-budget matrix cases failed while the ten explicitly configured cases passed. Restoring the
source returned all 15 to green. This demonstrates that reducing native repetition does not lose
protection of the original default boundary.
