# An example runner for DeepSeek Harness (dsh)

`openrig-dsh-runner.mjs` is a small runner for the draft [harness and runner contract](../../harness-runner-contract.md).
It runs in the seat's pane, hosts `dsh --profile acp` over ACP on stdio, and does the runner's part of each contract
section:
- **identity:** the launch record, written once the conversation is open;
- **one prompt per block:** each submitted block becomes one `session/prompt`, using bracketed paste in a TTY;
- **turn boundaries:** reported as activity hooks;
- **cancel:** `/abort` or Ctrl-C sends `session/cancel`, and a turn reads cancelled only when dsh says so;
- **permissions:** each request goes to a person through OpenRig;
- **resume:** it reopens the exact conversation, or says honestly that it couldn't.

It has no dependencies, and it isn't installed by OpenRig. Copy it with [`dsh.yaml`](dsh.yaml) and maintain both as your
own. [bpamiri/dsh-seat](https://github.com/bpamiri/dsh-seat) is a fuller dsh runner by its own maintainer.

## Set it up

1. **Install dsh and Node.** Install Node 22 or later, then `npm i -g @deepseek-ai/dsh@0.2.1-rc.2`. This is the version
   it was written for, and it has been checked only against a stand-in agent.
2. **Install the runner and preset.** Make the runner executable and put it on the seat's `PATH`. Copy `dsh.yaml` to
   `$OPENRIG_HOME/community-harnesses/`. Then declare a member with `runtime: dsh`.
3. **Give the seat credentials.** Each seat gets its own dsh home, at `$OPENRIG_HOME/state/dsh/<node>/home`, because dsh
   rewrites its profile there on every start. Put a `.credentials.yaml` there, or put a provider key in the seat's
   `env:`. To use a home you prepared yourself, set `OPENRIG_DSH_HOME`. `OPENRIG_DSH` names another `dsh` binary.

The runner's own defaults for dsh:
- **Uploads:** the seat home gets a `cordis.patch.yml` that turns off dsh's session-log and plugin-list uploads to
  DeepSeek, and the runner starts dsh with `DSH_TELEMETRY_DISABLED=1`.
- **Permission mode:** `DSH_PERMISSION_MODE` is `workspace-write` unless you set it.
- **The hook token:** OpenRig's activity token isn't passed to dsh, whose shell tool inherits the runner's environment.

## Permissions

The runner submits each request to OpenRig, which asks one person:
- the default person;
- or the person chosen for the seat with `rig seat set-permissions-to <seat> --to <person> --reason "…"`.

That person answers one of the options dsh offered, and the runner gives that answer to the same live request, once.

**When no one can be asked, the request is permitted** with dsh's own allow option: `allow_once` when dsh offers it,
else `allow_always`. That's OpenRig's default. The runner does the same when OpenRig can't answer: an older OpenRig
without this path, an OpenRig it can't reach, or a refusal other than `--deny`.

**`allow_always` creates a standing grant in dsh.** OpenRig doesn't record or revoke it, which is why the runner prefers
`allow_once`. Where dsh keeps the grant, and for how long, isn't checked.

**The runner refuses** only when the seat's operator opted in to refusal, with `rig seat set-permissions-to <seat>
--deny`, or when dsh offered no allow option. A refused request is shown in the pane, and the seat reads needs input
until the next prompt.

**The runner answers cancelled, holding nothing,** when the person says no and dsh offered no reject option, or when
OpenRig says the request isn't the seat's current occupant's (for example, after a relaunch).

## Before you declare resume

The preset leaves `resume` out. The runner reopens a conversation by the method dsh advertises: `session/resume`, or
`session/load`. When dsh advertises neither, it tries `session/resume`. It reports a conversation missing only on dsh's
own not-found error (`-32002`); any other failure leaves the resume unconfirmed, and it never starts a new conversation
on a resume. Add `resume: true` after a real dsh has reopened a conversation and refused a missing one.

## Check it without a model

Point dsh's `DEEPSEEK_BASE_URL` at a local server that speaks DeepSeek's Anthropic-compatible Messages API. Then run the
contract's real check:
- a seat reads ready only after the handshake;
- one multi-line message becomes one prompt;
- the seat reads working, then idle;
- a refused permission reads needs input;
- `/abort` ends a turn as cancelled.

`packages/daemon/test/community-harness-dsh-example.test.ts` runs the same cases against a stand-in agent.
