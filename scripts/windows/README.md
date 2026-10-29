# Optional psmux private-environment candidate

`psmux-envfile-v1.patch` is an experimental source delta against psmux **v3.4.0**,
peeled commit `20aa1d7254ee93f64dafa059ef89341d9767470a`. It is not part of the
stock release and OpenRig does not install or replace a multiplexer binary.
The psmux source is MIT licensed; retain its upstream license when building or
redistributing it.

In a separate, clean psmux source checkout at that exact commit, apply and build:

```powershell
git apply --unidiff-zero --check C:/path/to/openrig/scripts/windows/psmux-envfile-v1.patch
git apply --unidiff-zero C:/path/to/openrig/scripts/windows/psmux-envfile-v1.patch
cargo check --locked --bin psmux
cargo test --locked --bin psmux private_env::tests
cargo build --locked --bin psmux
./target/debug/psmux.exe openrig-private-environment-capability
```

The final command must print exactly
`openrig-envfile-v1:new-session,respawn-pane`. Do not run the broad psmux test
suite against an operator's default server. Native session tests need their own
unique `-L` namespace and process/session cleanup. Building is not deployment;
changing an actual operator runtime requires its own authorization.

The protocol uses `-e @openrig-env-v1:<absolute-file-path>` instead of literal
values. The UTF-8 JSON object has schema `openrig.psmux.environment/v1` and an
ordered `entries` array of `[key, value]` pairs. Files are limited to 1 MiB;
invalid keys, NUL values, malformed JSON and unknown fields fail with a fixed
diagnostic without echoing the payload. `--` ends option parsing. The manifest
is read in the client and, when needed, the server; values do not enter server
argv. Session values are applied before initial pane creation without changing
the server process environment. Respawn values affect only the new pane.

OpenRig creates the file in a protected current-SID directory before writing
values. It removes the file after a successful command response, and retains it
after failure/unknown consumption rather than racing an in-flight server read.
Once this protocol is selected, neither file creation nor command failure falls
back to literal values. A failed capability observation also stops the attempt.
Stock 3.4.0's explicit unknown-command response retains its existing experimental
literal transport; that path still exposes initial/respawn values in argv.

Native synthetic tests on the candidate cover exact empty/Unicode/LF/CR values,
a manifest path containing spaces, user-config precedence, routing-variable
separation, later panes after manifest disposal, a verified warm-server claim,
invalid-file rejection before mutation, direct respawn and argv inspection.
They also exercise OpenRig's capability selection and successful file disposal.
They do not prove general Windows acceptance. An earlier apparent interactive
respawn-readiness failure was traced to the first-target routing defect in the
OpenRig adapter: session-only routing lost the inactive pane target for Enter.
The adapter now includes the immutable pane ID in its initial psmux target;
isolated stock 3.4.0 and candidate probes deliver to the inactive pane without
selecting it or submitting input to its active-window decoy.
