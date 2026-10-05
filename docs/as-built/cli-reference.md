---
kind: as-built
title: CLI Reference — Registered Commands and Options
status: active
topics: [orchestration, coordination, observability, knowledge-and-context]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Looking up the complete registered rig command/option surface or locating
  the source that implements a command. Use command help for invocation details.
siblings: [README.md, codemap.md]
prerequisite-reads: [../reference/help.md]
last-verified-against-source: 82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d
last-updated: 2026-10-05
---

# CLI Reference — Registered Commands and Options

Verified against source commit `82eb4bed0fbf4ce7df038090b43211a0b8a1aa1d`.
The inventory below comes from the actual Commander tree returned by
[`createProgram()`](../../packages/cli/src/index.ts), not a grep of command
strings or an installed CLI from a different commit.

There are **87 top-level registrations**, **352 registered command objects**
below `rig` (including groups and the hidden `restore apply` command), and
**1,072 explicitly registered option objects**, including the root version
option. Aliases do not add command objects; short/long spellings of one
option do not add option objects. Commander-generated help is additional.
These are source counts, not a claim about a deployed release.

## Reading this reference

Each table row lists one registered command, its positional arguments,
command aliases, and its **own declared options**. `<value>` denotes a
required positional/option value; `[value]` is optional; `...` is variadic.
An option marked **required** was registered with Commander's mandatory
option setting. An option marked (repeatable) collects every value when it is
given more than once. Conditional requirements enforced by an action are not
encoded by this inventory.

Use `rig <command> --help` for descriptions, choices, defaults, and examples.
Defaults may depend on the current directory, configuration, or action code;
they are not fixed by the flags table. Parent command options are listed on
the parent row, not repeated on every child. The root declares `-V, --version`;
Commander also provides `-h, --help` and applicable `help [command]` handling.
The only explicit command alias at this pin is `rig host ls` for `host list`.

An option named `--json` selects the command's JSON mode; it does not imply
that every verb shares one response schema. The handler and its daemon
route remain the source for result/error shape and side effects.

## Entry points and practical routes

Bare `rig` opens the TUI when both stdin and stdout are terminals. Arguments,
pipes, and redirected streams follow normal CLI parsing.
[`runFrontDoor` and `openMissionControl`](../../packages/cli/src/front-door.ts)
own the entry behavior; [`tuiCommand`](../../packages/cli/src/commands/tui.ts)
owns explicit TUI options. A daemon-down transport result can still open the
recovery cockpit; it is not automatically a reason to exit before rendering.

| Need | Start here |
|---|---|
| Install, upgrade, or make a first project | [Getting started](../reference/getting-started.md), then `rig setup --help` and `rig doctor --help`. |
| Inspect live state and diagnose failures | `rig ps`, `rig health`, `rig doctor`; [health diagnosis](../reference/health-diagnosis.md). |
| Define/start rigs and seats | `rig spec`, `rig agent`, `rig up`, `rig create`, `rig grow`, `rig seat continue`; [RigSpec](../reference/rig-spec.md) and [AgentSpec](../reference/agent-spec.md). |
| Snapshot, restore, or hand over | `rig snapshot`, `rig restore`, `rig restore-check`, `rig restore-packet`, `rig handover`; [lifecycle source map](architecture/lifecycle-snapshot-restore.md). |
| Find owned work or communicate | `rig queue`, `rig send`, `rig stream`, `rig chatroom`, `rig walk`; [coordination source map](architecture/coordination-primitive.md). |
| Work with projects, missions, slices, and proof | `rig scope`, `rig proof`, `rig workflow`; [project workspace](../reference/project-workspace.md) and [SDLC conventions](../reference/sdlc-conventions.md). |
| Read/project context and skills | `rig context`, `rig skill`, `rig package`; [context source map](architecture/plugin-agent-image-context-pack.md). |
| Connect another host or human channel | `rig host`, `rig gateway`, `rig slack`; [Slack setup](../reference/slack-app-setup.md). |
| Check, share, or start a rig bundle | `rig bundle check`, `rig bundle`, `rig up <GitHub folder link>`; [packaging source map](architecture/packaging-bootstrap-bundles.md). |
| Find a specialist seat across rigs and hosts | `rig roster` (read-only). |
| Read event, queue-transition, and tenure telemetry | `rig telemetry`. |

Do not confuse `rig project`'s coordination/classification surface with
`rig scope`'s project and work-tree commands. Likewise, `rig spec` manages
rig specifications, `rig specs` browses the spec library, and
`rig workflow specs` lists workflow specifications. The tree below preserves
those distinct registrations.

A successful read, queue admission, terminal delivery, proof judgment, and
publication are different operations. Consult the relevant command handler
and [workflow runtime](architecture/workflow-runtime.md) when deciding what a
result establishes. This reference does not turn an inventory entry into
permission to perform that operation.

## Reproducing the registration inventory

In a development checkout at the stamped commit, after installing its locked
dependencies and building the daemon and CLI, this import walks the registered
tree without parsing arguments or invoking command actions:

```sh
node --input-type=module <<'JS'
import { createProgram } from './packages/cli/dist/index.js';
const root = createProgram();
const rows = [];
function walk(command, prefix = '') {
  const path = prefix ? `${prefix} ${command.name()}` : command.name();
  rows.push({
    path,
    aliases: command.aliases(),
    arguments: command.registeredArguments.map(a => ({
      name: a.name(), required: a.required, variadic: a.variadic,
    })),
    options: command.options.map(o => ({
      flags: o.flags, required: Boolean(o.mandatory),
    })),
  });
  for (const child of command.commands) walk(child, path);
}
walk(root);
console.log(JSON.stringify({
  topLevel: root.commands.length,
  registeredCommands: rows.length - 1,
  declaredOptions: rows.reduce((n, row) => n + row.options.length, 0),
  rows,
}, null, 2));
JS
```

This inspects registration, not action semantics or availability of a running
daemon. [`index.ts`](../../packages/cli/src/index.ts) imports the command
factories; their implementations live in
[`packages/cli/src/commands/`](../../packages/cli/src/commands/).
The tables below retain registration order. Only the command/argument/alias/
option cells are mechanically transcribed; the explanations above are authored.

## Registered command tree

Root: `rig`; declared option: `-V, --version`.

### start

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig start` | — | `--last`<br>`--all`<br>`--rigs <names...>`<br>`--json` |

### daemon

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig daemon` | — | — |
| `rig daemon start` | — | `--port <port>`<br>`--host <host>`<br>`--db <path>`<br>`--no-kernel`<br>`--wait-for-kernel`<br>`--wait-for-kernel-ms <ms>` |
| `rig daemon stop` | — | — |
| `rig daemon status` | — | — |
| `rig daemon logs` | — | `--follow` |

### status

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig status` | — | — |

### snapshot

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig snapshot <rigId>` | — | `--intended-seats <ids>` |
| `rig snapshot list <rigId>` | — | — |

### restore

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig restore` | — | — |
| `rig restore apply <snapshotId>` (hidden) | — | `--rig <rigId>` **required** |
| `rig restore status <attemptId>` | — | `--rig <rigId>` **required**<br>`--json` |

### crash-cart

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig crash-cart` | — | `--json` |

### gateway

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig gateway` | — | — |
| `rig gateway human` | — | — |
| `rig gateway human add <entityId>` | — | `--display-name <name>` **required**<br>`--binding <kind:connectorRef:secretsRef:role[:handle=<id>]>` **required** (repeatable)<br>`--delivery-class <A\|B\|C\|D>` **required**<br>`--away`<br>`--replace`<br>`--reason <reason>`<br>`--actor <actor>` |
| `rig gateway human list` | — | `--json` |
| `rig gateway human show <entityId>` | — | `--json` |
| `rig gateway human set <entityId> <field> <value>` | — | `--reason <reason>`<br>`--actor <actor>` |
| `rig gateway human remove <entityId>` | — | `--force` |

### parked

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig parked [seat]` | — | `--rig <rig>`<br>`--json` |

### export

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig export <rigId>` | — | `-o, --output <path>` |

### import

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig import <path>` | — | `--instantiate`<br>`--materialize-only`<br>`--workspace-only`<br>`--preflight`<br>`--target-rig <rigId>`<br>`--rig-root <root>`<br>`--cwd <path>` |

### ui

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig ui` | — | — |
| `rig ui open` | — | — |

### tui

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig tui` | — | `--shared` |
| `rig tui commands` | — | `--json` |

### package

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig package` | — | — |
| `rig package validate <path>` | — | — |
| `rig package plan <path>` | — | `--target <dir>`<br>`--runtime <runtime>`<br>`--role <name>` |
| `rig package install <path>` | — | `--target <dir>`<br>`--runtime <runtime>`<br>`--role <name>`<br>`--allow-merge` |
| `rig package rollback <installId>` | — | — |
| `rig package list` | — | — |

### bootstrap

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig bootstrap <spec>` | — | `--plan`<br>`--yes`<br>`--cwd <path>`<br>`--target <path>`<br>`--skip-version-check`<br>`--force`<br>`--json` |

### requirements

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig requirements <spec>` | — | `--json` |

### discover

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig discover` | — | `--json`<br>`--draft` |

### attach

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig attach` | — | `--self` **required**<br>`--rig <rigId>` **required**<br>`--node <logicalId>`<br>`--pod <namespace>`<br>`--member <name>`<br>`--runtime <runtime>`<br>`--cwd <path>`<br>`--display-name <name>`<br>`--print-env`<br>`--json` |

### bind

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig bind <discoveredId>` | — | `--rig <rigId>` **required**<br>`--node <logicalId>`<br>`--pod <namespace>`<br>`--member <name>` |

### adopt

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig adopt <path>` | — | `--bind <logicalId=tmuxSessionOrDiscoveryId>` (repeatable)<br>`--bindings-file <path>`<br>`--target-rig <rigId>`<br>`--rig-root <root>`<br>`--json` |

### bundle

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig bundle` | — | — |
| `rig bundle create <spec>` | — | `-o, --output <path>` **required**<br>`--name <name>`<br>`--bundle-version <ver>`<br>`--include-packages <refs...>`<br>`--rig-root <root>`<br>`--context-pack <dir>` (repeatable)<br>`--project-dir <dir>`<br>`--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--notes <text>`<br>`--min-daemon-version <ver>`<br>`--min-cli-version <ver>`<br>`--allow-drift`<br>`--json` |
| `rig bundle configurations <spec>` | — | `--json` |
| `rig bundle inspect <path>` | — | `--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--json` |
| `rig bundle install <path>` | — | `--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--non-interruptive`<br>`--no-non-interruptive`<br>`--plan`<br>`--yes`<br>`--target <root>`<br>`--cwd <path>`<br>`--skip-version-check`<br>`--force`<br>`--json` |
| `rig bundle check <folder>` | — | `--json` |
| `rig bundle history` | — | `--rig <name>`<br>`--since <iso>`<br>`--json` |

### up

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig up <source>` | — | `--non-interruptive`<br>`--no-non-interruptive`<br>`--plan`<br>`--yes`<br>`--cwd <path>`<br>`--target <root>`<br>`--preset <name>`<br>`--seat <member=runtime>` (repeatable)<br>`--existing`<br>`--fresh <seats...>`<br>`--json`<br>`--host <id>` |

### down

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig down <rig>` | — | `--delete`<br>`--force`<br>`--snapshot`<br>`--json`<br>`--host <id>` |

### archive

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig archive <rigId>` | — | `--force`<br>`--json` |

### unarchive

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig unarchive <rigId>` | — | `--json` |

### host

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig host` | — | — |
| `rig host add` | — | `--id <id>` **required**<br>`--transport <transport>` **required**<br>`--target <target>`<br>`--user <user>`<br>`--url <url>`<br>`--bearer-env <name>`<br>`--bearer-file <path>`<br>`--notes <text>`<br>`--json` |
| `rig host select <id>` | — | `--json` |
| `rig host rename <name>` | — | `--json` |
| `rig host pair <url>` | — | `--id <id>`<br>`--timeout <seconds>`<br>`--human <address>`<br>`--json` |
| `rig host list` | `ls` | `--json` |
| `rig host doctor <id>` | — | `--posture <profile>`<br>`--public-addr <ip>`<br>`--json` |

### ps

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig ps` | — | `--json`<br>`--no-cleanup`<br>`--resources`<br>`--nodes`<br>`--full`<br>`--verbose`<br>`--limit <n>`<br>`--fields <list>`<br>`--summary`<br>`--filter <key=value>`<br>`--active`<br>`--running`<br>`-A, --all-rigs`<br>`--rig <name>`<br>`--session <name>`<br>`--include-archived`<br>`--host <id>`<br>`--all-hosts`<br>`--hosts <ids>` |

### roster

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig roster` | — | — |
| `rig roster list` | — | `--folder <path>`<br>`--json` |
| `rig roster show <id>` | — | `--folder <path>`<br>`--json` |
| `rig roster find <query>` | — | `--folder <path>`<br>`--json` |

### mcp

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig mcp` | — | — |
| `rig mcp serve` | — | `--port <port>` |

### agent

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig agent` | — | — |
| `rig agent validate <path>` | — | `--json` |

### spec

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig spec` | — | — |
| `rig spec show <rig-id>` | — | `--json`<br>`--as-template` |
| `rig spec audit <path>` | — | `--json` |
| `rig spec validate <path>` | — | `--json` |
| `rig spec preflight <path>` | — | `--rig-root <root>`<br>`--json` |

### transcript

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig transcript <session>` | — | `--tail <lines>`<br>`--grep <pattern>`<br>`--host <id>`<br>`--json` |

### send

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig send [session] [text]` | — | `--to <sessions>` (repeatable)<br>`--pod <name>`<br>`--rig <name>`<br>`--verify`<br>`--force`<br>`--wait-for-idle <seconds>`<br>`--raw`<br>`--dangerously-interact`<br>`--reason <text>`<br>`--host <id>`<br>`--from <session>`<br>`--context <ref>`<br>`--json` |

### stream

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig stream` | — | — |
| `rig stream emit` | — | `--source <session>` **required**<br>`--body <text>` **required**<br>`--hint-destination <session>`<br>`--hint-type <type>`<br>`--hint-urgency <urgency>`<br>`--hint-tags <tags>`<br>`--format <fmt>`<br>`--interrupt`<br>`--id <streamItemId>`<br>`--json` |
| `rig stream list` | — | `--source <session>`<br>`--hint-destination <session>`<br>`--tag <tag>`<br>`--since <iso>`<br>`--until <iso>`<br>`--limit <n>`<br>`--after <sortKey>`<br>`--include-archived`<br>`--json` |
| `rig stream watch` | — | `--json` |
| `rig stream show <streamItemId>` | — | `--json` |
| `rig stream archive <streamItemId>` | — | `--json` |

### queue

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig queue` | — | — |
| `rig queue create` | — | `--source <session>`<br>`--destination <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--body-context <ref>`<br>`--mission <id>`<br>`--slice <id>`<br>`--gate <role>`<br>`--priority <priority>`<br>`--tier <tier>`<br>`--tags <tags>`<br>`--expires-at <iso>`<br>`--id <qitemId>`<br>`--target-repo <name>`<br>`--summary <text>`<br>`--human-intent <intent>`<br>`--human-detail-file <path>`<br>`--reply-to <qitemId>`<br>`--human-questions-file <path>`<br>`--evidence-ref <path>`<br>`--host <id>`<br>`--no-nudge`<br>`--verify`<br>`--json` |
| `rig queue claim <qitemId>` | — | `--destination <session>`<br>`--json` |
| `rig queue unclaim <qitemId>` | — | `--destination <session>`<br>`--reason <text>`<br>`--json` |
| `rig queue update <qitemId>` | — | `--actor <session>`<br>`--state <state>`<br>`--reopen`<br>`--closure-reason <reason>`<br>`--closure-target <target>`<br>`--blocked-on <blocker>`<br>`--wake-watchdog <jobId>`<br>`--wake-after <duration>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--note <text>`<br>`--json` |
| `rig queue block <qitemId>` | — | `--on <blocker>` **required**<br>`--actor <session>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--note <text>`<br>`--continuation <text>`<br>`--wake-watchdog <jobId>`<br>`--wake-after <duration>`<br>`--json` |
| `rig queue resolve <qitemId>` | — | `--decision <text>` **required**<br>`--actor <session>`<br>`--bearer <token>`<br>`--no-notify`<br>`--json` |
| `rig queue handoff <qitemId>` | — | `--from <session>`<br>`--to <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--note <text>`<br>`--priority <priority>`<br>`--tier <tier>`<br>`--tags <tags>`<br>`--gate <role>`<br>`--target-repo <name>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--host <id>`<br>`--no-nudge`<br>`--json` |
| `rig queue handoff-and-complete <qitemId>` | — | `--from <session>`<br>`--to <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--note <text>`<br>`--priority <priority>`<br>`--tier <tier>`<br>`--tags <tags>`<br>`--gate <role>`<br>`--target-repo <name>`<br>`--summary <text>`<br>`--evidence-ref <path>`<br>`--host <id>`<br>`--no-nudge`<br>`--json` |
| `rig queue whoami` | — | `--session <session>`<br>`--recent-limit <n>`<br>`--json` |
| `rig queue fallback <qitemId>` | — | `--destination <session>` **required**<br>`--reason <text>`<br>`--json` |
| `rig queue show <qitemId>` | — | `--full`<br>`--json` |
| `rig queue transitions <qitemId>` | — | `--json` |
| `rig queue list` | — | `-a, --all`<br>`-A, --all-rigs`<br>`--full`<br>`--owned`<br>`--mine`<br>`-o <format>`<br>`--destination <session>`<br>`--source <session>`<br>`--state <state>`<br>`--target-repo <name>`<br>`--limit <n>`<br>`--json` |
| `rig queue overdue` | — | `--rig <name>`<br>`-A, --all-rigs`<br>`--full`<br>`--limit <n>`<br>`--json` |
| `rig queue undelivered` | — | `--rig <name>`<br>`-A, --all-rigs`<br>`--full`<br>`--limit <n>`<br>`--json` |
| `rig queue inbox-drop <destinationSession>` | — | `--sender <session>`<br>`--body <text>`<br>`--body-file <path>`<br>`--tags <tags>`<br>`--urgency <urgency>`<br>`--audit <pointer>`<br>`--id <inboxId>`<br>`--json` |
| `rig queue inbox-absorb <inboxId>` | — | `--receiver <session>` **required**<br>`--json` |
| `rig queue inbox-deny <inboxId>` | — | `--receiver <session>` **required**<br>`--reason <text>` **required**<br>`--json` |
| `rig queue inbox-pending <destinationSession>` | — | `--json` |
| `rig queue outbox-record` | — | `--sender <session>`<br>`--destination <session>` **required**<br>`--body <text>`<br>`--body-file <path>`<br>`--tags <tags>`<br>`--urgency <urgency>`<br>`--audit <pointer>`<br>`--id <outboxId>`<br>`--json` |
| `rig queue outbox-list <senderSession>` | — | `--limit <n>`<br>`--json` |

### slack

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig slack` | — | — |
| `rig slack setup` | — | `--channel <id>`<br>`--inbound-destination <session>`<br>`--minimum-level-that-posts <level>`<br>`--minimum-level-that-interrupts <level>`<br>`--source-label <label>`<br>`--secrets-env-file <path>`<br>`--required-scopes <csv>`<br>`--reason <reason>`<br>`--actor <actor>` |
| `rig slack status` | — | `--json` |
| `rig slack manifest` | — | `--url`<br>`--json` |
| `rig slack verify` | — | `--json`<br>`--reason <reason>`<br>`--actor <actor>` |
| `rig slack enable` | — | `--reason <reason>`<br>`--actor <actor>` |
| `rig slack disable` | — | `--reason <reason>` **required**<br>`--actor <actor>` |
| `rig slack outbound` | — | `--json` |
| `rig slack inbound` | — | — |

### project

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig project` | — | — |
| `rig project experimental` | — | — |
| `rig project experimental enable` | — | `--config <file>` **required**<br>`--max-requests <n>`<br>`--timeout-ms <n>`<br>`--json` |
| `rig project experimental disable` | — | `--config <file>` **required**<br>`--max-requests <n>`<br>`--timeout-ms <n>`<br>`--json` |
| `rig project experimental status` | — | `--config <file>` **required**<br>`--max-requests <n>`<br>`--timeout-ms <n>`<br>`--json` |
| `rig project experimental capture` | — | `--config <file>` **required**<br>`--input <file>` **required**<br>`--output <file>` **required**<br>`--json` |
| `rig project candidates` | — | `--project <id>` **required**<br>`--taxonomy <file>` **required**<br>`--classifier-version <version>` **required**<br>`--evidence-epoch <epoch>` **required**<br>`--decisions <file>`<br>`--experiment <file>`<br>`--limit <count>`<br>`--json` |
| `rig project wake` | — | `--project <id>` **required**<br>`--taxonomy <file>` **required**<br>`--classifier-version <version>` **required**<br>`--evidence-epoch <epoch>` **required**<br>`--decisions <file>`<br>`--experiment <file>`<br>`--limit <count>`<br>`--json` |
| `rig project shadow-status` | — | — |
| `rig project shadow-drain` | — | `--actor <name>` |
| `rig project shadow-stop` | — | `--actor <name>` |
| `rig project lease-acquire` | — | `--session <session>` **required**<br>`--evaluate-deadness-first`<br>`--json` |
| `rig project lease-heartbeat` | — | `--lease-id <id>` **required**<br>`--session <session>` **required**<br>`--json` |
| `rig project lease-show` | — | `--json` |
| `rig project reclaim-classifier` | — | `--session <session>` **required**<br>`--if-dead`<br>`--reason <text>`<br>`--json` |
| `rig project classify <streamItemId>` | — | `--session <session>` **required**<br>`--lease-id <id>` **required**<br>`--attempt-id <id>`<br>`--execution-id <id>`<br>`--type <type>`<br>`--urgency <urgency>`<br>`--maturity <maturity>`<br>`--confidence <confidence>`<br>`--destination <destination>`<br>`--action <action>`<br>`--area <area>`<br>`--scope-ref <id>`<br>`--duplicate-of <streamItemId>`<br>`--needs-human <value>`<br>`--classifier-version <v>`<br>`--taxonomy-version <v>`<br>`--candidate-set-version <v>`<br>`--json` |
| `rig project list` | — | `--session <session>`<br>`--destination <destination>`<br>`--area <area>`<br>`--scope-ref <id>`<br>`--needs-human <value>`<br>`--limit <n>`<br>`--json` |
| `rig project show <projectId>` | — | `--json` |

### view

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig view` | — | — |
| `rig view list` | — | `--json` |
| `rig view show <viewName>` | — | `--rig <rig>`<br>`--limit <n>`<br>`--mission <id>`<br>`--project <name>`<br>`--json` |
| `rig view register` | — | `--name <name>` **required**<br>`--definition <sql>` **required**<br>`--session <session>` **required**<br>`--json` |

### terminal

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig terminal` | — | — |
| `rig terminal open <view>` | — | `--provider <name>`<br>`--json` |
| `rig terminal views` | — | `--json` |
| `rig terminal status` | — | `--provider <name>`<br>`--json` |

### watchdog

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig watchdog` | — | — |
| `rig watchdog register` | — | `--spec <path>`<br>`--policy <policy>` **required**<br>`--target-session <session>` **required**<br>`--interval-seconds <n>` **required**<br>`--registered-by <session>` **required**<br>`--threshold-bytes <n>`<br>`--threshold-mb <n>`<br>`--watched-file <path>`<br>`--requires-job <jobId>`<br>`--message <text>`<br>`--active-wake-interval-seconds <n>`<br>`--scan-interval-seconds <n>`<br>`--json` |
| `rig watchdog list` | — | `-a, --all`<br>`--full`<br>`--limit <n>`<br>`--json` |
| `rig watchdog show <jobId>` | — | `--json` |
| `rig watchdog status <jobId>` | — | `--json` |
| `rig watchdog stop <jobId>` | — | `--reason <text>`<br>`--json` |

### workflow

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig workflow` | — | — |
| `rig workflow validate <specPath>` | — | `--json` |
| `rig workflow compile <missionPath>` | — | `--operation-key <key>`<br>`--json` |
| `rig workflow revise <instanceId>` | — | `--apply`<br>`--expected-version <number>`<br>`--expected-digest <sha256>`<br>`--operation-key <key>`<br>`--actor-session <session>`<br>`--reason <text>`<br>`--json` |
| `rig workflow operation <key>` | — | `--json` |
| `rig workflow instantiate-lifecycle <missionPath>` | — | `--operation-key <key>` **required**<br>`--root-objective <text>` **required**<br>`--created-by <session>` **required**<br>`--entry-owner <session>`<br>`--rig <name>`<br>`--json` |
| `rig workflow instantiate <specPath>` | — | `--root-objective <text>` **required**<br>`--created-by <session>` **required**<br>`--entry-owner <session>`<br>`--rig <name>`<br>`--json` |
| `rig workflow project` | — | `--instance <id>` **required**<br>`--current-packet <qitem-id>` **required**<br>`--exit <kind>` **required**<br>`--actor-session <session>` **required**<br>`--result-note <text>`<br>`--evidence-ref <ref>`<br>`--wait-for-proof <scope>`<br>`--blocked-on <ref>`<br>`--next-owner <session>`<br>`--acceptance-candidate <identity>`<br>`--acceptance-verdict <verdict>`<br>`--acceptance-evidence-ref <path>`<br>`--json` |
| `rig workflow list` | — | `--status <s>`<br>`--json` |
| `rig workflow specs` | — | `--json` |
| `rig workflow guidance <instanceId>` | — | `--packet <id>`<br>`--component <id>`<br>`--full`<br>`--json` |
| `rig workflow show <instanceId>` | — | `--json` |
| `rig workflow trace <instanceId>` | — | `--json` |
| `rig workflow continue <instanceId>` | — | `--json` |
| `rig workflow run <specPath>` | — | `--root-objective <text>` **required**<br>`--created-by <session>` **required**<br>`--entry-owner <session>`<br>`--rig <name>`<br>`--json` |
| `rig workflow watch <instanceId>` | — | `--json` |
| `rig workflow route <instanceId>` | — | `--to <session>` **required**<br>`--actor-session <session>` **required**<br>`--packet <qitem-id>`<br>`--reason <text>`<br>`--json` |
| `rig workflow resume <instanceId>` | — | `--actor-session <session>` **required**<br>`--occurrence <failed-qitem-id>`<br>`--decision <text>`<br>`--json` |
| `rig workflow abort <instanceId>` | — | `--reason <text>` **required**<br>`--actor-session <session>` **required**<br>`--json` |
| `rig workflow status` | — | `--json` |

### capture

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig capture [session]` | — | `--rig <name>`<br>`--pod <name>`<br>`--lines <n>`<br>`--host <id>`<br>`--json` |

### broadcast

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig broadcast [text]` | — | `--rig <name>`<br>`--pod <name>`<br>`--force`<br>`--host <id>`<br>`--context <ref>`<br>`--json` |

### walk

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig walk <seat>` | — | `--through <items...>`<br>`--through-profile <ref>`<br>`--situation <situation>`<br>`--runtime <runtime>`<br>`--profile <profile>`<br>`--rig <rig>`<br>`--seat-grant <seat>`<br>`--mission <mission>`<br>`--slice <slice>`<br>`--budget <tokens>`<br>`--pace <duration>`<br>`--consume-timeout <duration>`<br>`--consume-poll <duration>`<br>`--turn-timeout <duration>`<br>`--json` |

### ask

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig ask <rig> <question>` | — | `--json`<br>`--seat <session-name>`<br>`--session <token>`<br>`--wake <seat[@gen]\|token>`<br>`--runtime <runtime>`<br>`--wake-timeout <seconds>` |

### chatroom

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig chatroom` | — | — |
| `rig chatroom send <rig> <message>` | — | `--sender <name>` |
| `rig chatroom history <rig>` | — | `--topic <name>`<br>`--after <id>`<br>`--since <timestamp>`<br>`--sender <name>`<br>`--limit <n>`<br>`--json` |
| `rig chatroom watch <rig>` | — | `--tmux` |
| `rig chatroom topic <rig> <topic-name>` | — | `--body <text>`<br>`--sender <name>` |
| `rig chatroom wait <rig>` | — | `--after <id>`<br>`--topic <name>`<br>`--sender <name>`<br>`--timeout <seconds>`<br>`--json` |
| `rig chatroom clear <rig>` | — | — |

### specs

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig specs` | — | — |
| `rig specs ls` | — | `--kind <kind>`<br>`--json` |
| `rig specs show <name-or-id>` | — | `--kind <kind>`<br>`--json` |
| `rig specs preview <name-or-id>` | — | `--kind <kind>`<br>`--json` |
| `rig specs add <path>` | — | `--json` |
| `rig specs sync` | — | `--json` |
| `rig specs remove <name-or-id>` | — | `--json` |
| `rig specs rename <name-or-id> <new-name>` | — | `--json` |

### context

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig context` | — | — |
| `rig context work-install` | — | `--project <id>`<br>`--mission <id>`<br>`--slice <id>`<br>`--deliver`<br>`--runtime <runtime>`<br>`--cwd <path>`<br>`--topology <ids>`<br>`--apply-skills`<br>`--json` |
| `rig context trace` | — | `--rig <rig>` **required**<br>`--pod <pod>`<br>`--seat <seat>`<br>`--name <file>` **required**<br>`--json` |
| `rig context compose` | — | `--out <ref>` **required**<br>`--from <files...>` **required** |
| `rig context list` | — | `--json` |
| `rig context show <name-or-ref>` | — | `--json` |
| `rig context preview <name-or-ref>` | — | `--json` |
| `rig context get <name-or-ref>` | — | `--json` |
| `rig context profile <name-or-ref>` | — | `--situation <situation>` **required**<br>`--runtime <runtime>`<br>`--profile <profile>`<br>`--budget <tokens>`<br>`--rig <rig>`<br>`--seat <seat>`<br>`--mission <mission>`<br>`--slice <slice>`<br>`--json` |
| `rig context recap-write` | — | `--rig <rig>` **required**<br>`--seat <seat>` **required**<br>`--file <path>` **required** |
| `rig context sync` | — | `--json` |
| `rig context add <source>` | — | `--name <name>`<br>`--git`<br>`--checkout`<br>`--pack <path>`<br>`--json` |
| `rig context source` | — | — |
| `rig context source inspect <ref>` | — | `--json` |
| `rig context source update <ref>` | — | `--json` |
| `rig context rm <ref>` | — | `--json` |

### plugin

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig plugin` | — | — |
| `rig plugin list` | — | `--runtime <runtime>`<br>`--source <source>`<br>`--json` |
| `rig plugin show <id>` | — | `--json` |
| `rig plugin used-by <id>` | — | `--json` |
| `rig plugin validate <path>` | — | `--json` |

### skill

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig skill` | — | — |
| `rig skill loadout` | — | `--runtime <runtime>` **required**<br>`--cwd <path>`<br>`--project-root <path>`<br>`--topology <ids>`<br>`--apply`<br>`--json` |
| `rig skill audit` | — | `--json` |

### agent-image

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig agent-image` | — | — |
| `rig agent-image list` | — | `--runtime <runtime>`<br>`--json` |
| `rig agent-image show <name-or-id>` | — | `--json` |
| `rig agent-image preview <name-or-id>` | — | `--json` |
| `rig agent-image create <source-session>` | — | `--name <name>` **required**<br>`--image-version <version>`<br>`--notes <text>`<br>`--estimated-tokens <n>`<br>`--lineage <names...>`<br>`--json` |
| `rig agent-image delete <name-or-id>` | — | `--force`<br>`--json` |
| `rig agent-image pin <name-or-id>` | — | `--json` |
| `rig agent-image unpin <name-or-id>` | — | `--json` |
| `rig agent-image prune` | — | `--dry-run`<br>`--force`<br>`--json` |
| `rig agent-image sync` | — | `--json` |

### fork

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig fork <source-session>` | — | `--rig <rig-id>` **required**<br>`--pod <pod-namespace>` **required**<br>`--member <member-id>` **required**<br>`--keep-image`<br>`--image-name <name>`<br>`--image-version <version>`<br>`--rig-root <path>`<br>`--json` |

### workspace

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig workspace` | — | — |
| `rig workspace validate [root]` | — | `--kind <kind>`<br>`--no-recursive`<br>`--require-frontmatter`<br>`--max-files <n>`<br>`--json` |
| `rig workspace doctor` | — | `--workspace <path>`<br>`--json`<br>`--strict` |

### mode

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig mode` | — | — |
| `rig mode set <mode>` | — | `--scope <scope>`<br>`--qualifier <id>`<br>`--autonomy-scope <v>`<br>`--heartbeat-cadence <v>`<br>`--inspection-depth <v>`<br>`--update-detail <v>`<br>`--escalation-threshold <v>`<br>`--concurrency-limit <v>`<br>`--permission-prompt-posture <v>`<br>`--expiry-or-stale-rule <v>`<br>`--evidence <citation>`<br>`--confirm`<br>`--bearer <token>`<br>`--json` |
| `rig mode show` | — | `--json` |
| `rig mode effective` | — | `--rig <id>`<br>`--project <id>`<br>`--mission <id>`<br>`--workstream <id>`<br>`--qitem <id>`<br>`--json` |
| `rig mode cite` | — | `--rig <id>`<br>`--project <id>`<br>`--mission <id>`<br>`--workstream <id>`<br>`--qitem <id>` |
| `rig mode unset <scope> [qualifier]` | — | `--bearer <token>`<br>`--json` |
| `rig mode defaults` | — | `--json` |

### policy

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig policy` | — | — |
| `rig policy permissions` | — | — |
| `rig policy permissions list` | — | `--spec <path>`<br>`--json` |
| `rig policy permissions show <nameOrRef>` | — | `--spec <path>`<br>`--json` |
| `rig policy permissions current` | — | `--spec <path>` **required**<br>`--json` |
| `rig policy permissions apply <name>` | — | `--spec <path>` **required**<br>`--json` |
| `rig policy list` | — | `--spec <path>`<br>`--json` |
| `rig policy show <nameOrRef>` | — | `--spec <path>`<br>`--json` |
| `rig policy current` | — | `--spec <path>` **required**<br>`--json` |
| `rig policy apply <name>` | — | `--spec <path>` **required**<br>`--json` |

### whoami

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig whoami` | — | `--node-id <id>`<br>`--session <name>`<br>`--host <id>`<br>`--all-hosts`<br>`--hosts <ids>`<br>`--json`<br>`--full`<br>`--verbose` |

### config

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig config` | — | `--json`<br>`--with-source` |
| `rig config get <key>` | — | `--json`<br>`--show-source` |
| `rig config set <key> <value>` | — | — |
| `rig config reset [key]` | — | — |
| `rig config init-workspace` | — | `--root <path>`<br>`--force`<br>`--dry-run`<br>`--json` |

- `init-workspace` — `rig config init-workspace` creates missing `missions/`, `exhaust/`, `SPEC.md`, `project.yaml`, `workspace.yaml`, and `.gitignore` entries at the configured workspace root (or `--root <path>`). Initialization is additive and preserves existing files; a complete six-entry scaffold is a no-op. `--force` is deprecated compatibility and still preserves existing files. `--dry-run` reports planned additions without writing; incompatible path types are reported before any writes.

### file

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig file` | — | — |
| `rig file copy <src> <dst>` | — | `--dry-run`<br>`--json` |

### preflight

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig preflight` | — | `--json` |

### auth

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig auth` | — | — |
| `rig auth status` | — | `--runtime <runtime>` |
| `rig auth list` | — | `--runtime <runtime>` |
| `rig auth save <profile>` | — | `--runtime <runtime>` |
| `rig auth switch <profile>` | — | `--runtime <runtime>` |
| `rig auth validate <profile>` | — | `--runtime <runtime>` |
| `rig auth seats` | — | — |
| `rig auth seats list` | — | `--runtime <runtime>` |
| `rig auth seats show <seat>` | — | `--runtime <runtime>` |
| `rig auth seats set` | — | `--runtime <runtime>`<br>`--seat <seat>` **required**<br>`--rig <rig>` **required**<br>`--cwd <cwd>`<br>`--profile <profile>` |
| `rig auth seats report` | — | `--runtime <runtime>` |

### provider

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig provider` | — | — |
| `rig provider status` | — | `--json` |
| `rig provider accounts` | — | `--json`<br>`--provider <p>`<br>`--account <a>` |
| `rig provider bindings` | — | `--json`<br>`--provider <p>`<br>`--account <a>` |
| `rig provider signals` | — | `--json`<br>`--provider <p>`<br>`--account <a>` |
| `rig provider precheck` | — | `--seat <s>` **required**<br>`--to-account <a>` **required**<br>`--json` |
| `rig provider switch` | — | `--seat <s>` **required**<br>`--to-account <a>` **required**<br>`--force-unsafe`<br>`--json` |

### usage

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig usage` | — | — |
| `rig usage top` | — | `--window <duration>`<br>`--top <n>`<br>`--json` |
| `rig usage series` | — | `--seat <session>`<br>`--lane <lane>`<br>`--since <iso>`<br>`--until <iso>`<br>`--limit <n>`<br>`--json` |

### telemetry

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig telemetry` | — | — |
| `rig telemetry events` | — | `--cursor <token>`<br>`--limit <n>`<br>`--json`<br>`--start <mode>`<br>`--node <id>`<br>`--rig <id>` |
| `rig telemetry transitions` | — | `--cursor <token>`<br>`--limit <n>`<br>`--json`<br>`--start <mode>`<br>`--qitem <id>` |
| `rig telemetry tenures <node-id>` | — | `--cursor <token>`<br>`--limit <n>`<br>`--json` |

### health

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig health` | — | `--self`<br>`--seat <node-id>`<br>`--rig <rig-id>`<br>`--instance [instance-id]`<br>`--severity <severity>`<br>`--status <status>`<br>`--limit <count>`<br>`--json`<br>`--actor <name>` |
| `rig health explain <finding-id>` | — | `--json` |
| `rig health policy` | — | `--file <path>`<br>`--json` |
| `rig health checkpoint` | — | `--file <path>`<br>`--json` |
| `rig health diagnose` | — | `--apply`<br>`--json` |
| `rig health diagnosis` | — | — |
| `rig health diagnosis list` | — | `--json`<br>`--full` |
| `rig health diagnosis show <qitem-id>` | — | `--json`<br>`--full` |
| `rig health diagnosis record <qitem-id>` | — | `--file <path>` **required**<br>`--json` |
| `rig health diagnosis notify <qitem-id>` | — | `--json` |

### doctor

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig doctor` | — | `--json`<br>`--spec <path>` |

### expand

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig expand <rig-id> <pod-fragment-path>` | — | `--json`<br>`--rig-root <path>` |

### add

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig add <rig-id> <pod-namespace> <member-fragment-path>` | — | `--json`<br>`--rig-root <path>` |

### create

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig create <name>` | — | `--runtime <runtime>`<br>`--cwd <path>`<br>`--json` |

### grow

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig grow <rig-id> <members...>` | — | `--pod <pod>`<br>`--new-pod <pod>`<br>`--runtime <runtime>`<br>`--cwd <path>`<br>`--json` |

### reconcile-session

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig reconcile-session <session>` | — | `--rig <rigId>`<br>`--node <logicalId>`<br>`--no-launch`<br>`--json` |

### env

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig env` | — | — |
| `rig env status <rig>` | — | `--json` |
| `rig env logs <rig> [service]` | — | `--tail <n>` |
| `rig env down <rig>` | — | `--volumes` |

### unclaim

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig unclaim <sessionRef>` | — | `--json` |

### release

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig release <rigId>` | — | `--delete`<br>`--json` |

### launch

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig launch <rigId> [nodeRef]` | — | `--seats <ids>`<br>`--hold-reason <reason>`<br>`--snapshot-id <id>`<br>`--retry-startup-from <member-file>`<br>`--rig-root <path>`<br>`--plan`<br>`--json`<br>`--host <id>` |

### remove

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig remove <rigId> <nodeRef>` | — | `--fallback <live-seat>`<br>`--json` |

### shrink

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig shrink <rigId> <podRef>` | — | `--fallback <live-seat>`<br>`--json` |

### destroy

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig destroy` | — | `--state`<br>`--all`<br>`--backup`<br>`--yes`<br>`--confirm <token>` |

### setup

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig setup` | — | `--dry-run`<br>`--json`<br>`--full`<br>`--policy <name>`<br>`--spec <path>` |

### restore-check

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig restore-check` | — | `--json`<br>`--full`<br>`--ready`<br>`--rig <name>`<br>`--no-queue`<br>`--no-hooks` |

### restore-packet

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig restore-packet` | — | — |
| `rig restore-packet write` | — | `--source-session <session>`<br>`--source-jsonl <path>`<br>`--source-runtime <runtime>`<br>`--target <dir>` **required**<br>`--target-rig <rig>`<br>`--target-runtime <runtime>`<br>`--target-workspace-root <path>`<br>`--default-target-repo <path>`<br>`--role-pointer <path>`<br>`--current-work-summary <text>`<br>`--next-owner <name>`<br>`--caveat <text>` (repeatable)<br>`--authority-boundaries <text>`<br>`--source-trust-ranking <csv>`<br>`--generator-version <version>`<br>`--source-session-id-override <id>`<br>`--source-rig-override <rig>` |
| `rig restore-packet read <packet-dir>` | — | `--json` |
| `rig restore-packet validate <packet-dir>` | — | `--json` |

### compact-plan

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig compact-plan` | — | `--json`<br>`--rig <name>`<br>`--refresh`<br>`--threshold-tokens <n>`<br>`--threshold-percent <0-100>` |

### compact

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig compact <session>` | — | `--json`<br>`--skip-map`<br>`--cancel`<br>`--state` |

### heartbeat

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig heartbeat` | — | `--rig <name>`<br>`--json`<br>`--nudge`<br>`--include-done` |

### seat

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig seat` | — | — |
| `rig seat set-typing-guard <seat>` | — | `--enabled <boolean>` **required**<br>`--reason <text>` **required**<br>`--json` |
| `rig seat held-messages <seat>` | — | `--limit <n>`<br>`--offset <n>`<br>`--id <id>`<br>`--json` |
| `rig seat retire-held-message <seat> <id>` | — | `--reason <text>` **required**<br>`--json` |
| `rig seat status <seat>` | — | `--json` |
| `rig seat handover <seat>` | — | `--source <source>`<br>`--reason <reason>`<br>`--operator <address>`<br>`--dry-run`<br>`--json` |
| `rig seat switch-client <seat>` | — | `--to-window <n>`<br>`--client <id>`<br>`--json` |
| `rig seat clear-attention <session>` | — | `--reason <text>`<br>`--json` |
| `rig seat set-permissions <seat>` | — | `--mode <mode>` **required**<br>`--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `rig seat set-model <seat>` | — | `--model <id>` **required**<br>`--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `rig seat launch <seat>` | — | `--fresh` **required**<br>`--reason <text>` **required**<br>`--stop`<br>`--operator <address>`<br>`--json` |
| `rig seat continue <seat>` | — | `--json` |
| `rig seat stop <seat>` | — | `--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `rig seat clean <seat>` | — | `--reason <text>` **required**<br>`--operator <address>`<br>`--json` |
| `rig seat set-resume-token <session>` | — | `--token-stdin`<br>`--reason <text>` **required**<br>`--json` |

### handover

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig handover <seat>` | — | `--source <source>`<br>`--reason <reason>`<br>`--operator <address>`<br>`--dry-run`<br>`--json` |

### startup-proof

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig startup-proof` | — | — |
| `rig startup-proof submit` | — | `--challenge-id <id>` **required**<br>`--answer <answer>` **required**<br>`--json` |

### scope

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig scope` | — | `--workspace <path>` |
| `rig scope slice` | — | — |
| `rig scope slice ls` | — | `--mission <name>`<br>`--state <state>`<br>`--json` |
| `rig scope slice show <slice-path>` | — | `--mission <name>`<br>`--json` |
| `rig scope slice create <mission> <slug>` | — | `--template <kind>`<br>`--title <text>`<br>`--intent <text>`<br>`--depends-on <dot-id...>`<br>`--readme-only`<br>`--json` |
| `rig scope slice ship <slice-path> <release-mission>` | — | `--mission <name>`<br>`--json` |
| `rig scope slice close <slice-path>` | — | `--reason <reason>` **required**<br>`--note <text>`<br>`--mission <name>`<br>`--json` |
| `rig scope slice move <slice-path> <dest-mission>` | — | `--mission <name>`<br>`--json` |
| `rig scope slice progress <slice-path>` | — | `--mission <name>`<br>`--add <text>`<br>`--set <text>`<br>`--section <heading>`<br>`--status <status>`<br>`--json` |
| `rig scope slice repair <slice-path>` | — | `--mission <name>`<br>`--json` |
| `rig scope slice stage <slice-path> <new-stage>` | — | `--successor <id>`<br>`--mission <name>`<br>`--json` |
| `rig scope slice verified <slice-path>` | — | `--against <source>`<br>`--mission <name>`<br>`--json` |
| `rig scope slice approve <slice-path>` | — | `--mission <name>`<br>`--scope <scope>`<br>`--actor <session>`<br>`--on-behalf-of <human>`<br>`--re-approve`<br>`--reason <why>`<br>`--locked-artifacts <paths>`<br>`--json` |
| `rig scope mission` | — | — |
| `rig scope mission ls` | — | `--json` |
| `rig scope mission show <mission>` | — | `--json` |
| `rig scope mission create <name>` | — | `--template <kind>`<br>`--id <dot-id>`<br>`--title <text>`<br>`--intent <text>`<br>`--depends-on <dot-id...>`<br>`--no-notes`<br>`--no-mission-notes`<br>`--json` |
| `rig scope mission graph <mission>` | — | `--json` |
| `rig scope mission progress <mission>` | — | `--add <text>`<br>`--set <text>`<br>`--section <heading>`<br>`--status <status>`<br>`--json` |
| `rig scope mission repair <mission>` | — | `--json` |
| `rig scope mission stage <mission> <new-stage>` | — | `--successor <id>`<br>`--json` |
| `rig scope mission verified <mission>` | — | `--against <source>`<br>`--json` |
| `rig scope mission approve <mission>` | — | `--mission <name>`<br>`--scope <scope>`<br>`--actor <session>`<br>`--on-behalf-of <human>`<br>`--re-approve`<br>`--reason <why>`<br>`--locked-artifacts <paths>`<br>`--json` |
| `rig scope resolve-notes <absolute-work-node-dir>` | — | `--json` |
| `rig scope audit` | — | `--mission <name>` **required**<br>`--json` |

### proof

| Invocation | Aliases | Declared options |
|---|---|---|
| `rig proof` | — | `--workspace <path>` |
| `rig proof show [scope]` | — | `--json` |
| `rig proof judge <scope-item>` | — | `--verdict <verdict>` **required**<br>`--reason <text>` **required**<br>`--evidence <ref>` (repeatable)<br>`--subject <kind:ref>`<br>`--comparison <ref>`<br>`--revision <revision>`<br>`--operation-id <id>`<br>`--replace`<br>`--json` |
| `rig proof add <slice-path>` | — | `--mission <name>`<br>`--artifact-type <type>` **required**<br>`--verdict <verdict>` **required**<br>`--candidate-sha <sha>` **required**<br>`--money-evidence <line>` **required**<br>`--slice-id <dot-id>`<br>`--file <path>`<br>`--body <text>`<br>`--name <filename>`<br>`--replace`<br>`--evidences <refs>`<br>`--self-check <text>`<br>`--media <refs>`<br>`--json` |
