# Gateway participants: several people, shared channels, organizations and policy

OpenRig's gateway can register **several people** and **shared channels**, group them into **organizations** and
**groups**, give each readable **policy** text, and name a **default person**. Agents read the policy and apply it;
OpenRig doesn't enforce it. This page covers the commands, what the default is for, and what upgrading and rolling back
do.

For a remote client, `GET /api/gateway/participants` returns the same participant, organization, group, default and
warning fields as `rig gateway participants --json`. Add `?organization=<id>` to filter the participant list; the default
and organization and group maps still describe the whole registry. The result names the participant file and reports
an unreadable side file without treating it as an empty one. If the human registry itself cannot be read, the route
returns `503` with `error: "human_registry_unavailable"`. The result does not include connector secret pointers.

## Participants

A participant is either:
- **a person**, registered with `rig gateway human add`, with or without a connector binding (such as Slack or an HTTP loopback [relay](gateway-relay.md)); or
- **a shared channel**: one vetted Slack channel registered as one participant, `<id>@external`, not a person per
  sender.

People and channels share one address space: a channel can't take a person's id.

A registered person is addressed as `<id>@external`, including without Slack: for example,
`rig gateway human add alex --display-name "Alex" --delivery-class B` creates `alex@external`, reached in the Feed and Steering.
A person can also bind to a local bridge adapter using a `relay` binding:
`rig gateway human add bob --display-name "Bob" --delivery-class B --binding "relay:local-bridge:file:/etc/openrig/relay.env:primary:handle=bob-ops"`
(see [Gateway Relay Reference](gateway-relay.md) for endpoint, secret provisioning, and custody architecture).
`human@host` is the unnamed person at the terminal; `human@kernel` is also accepted as a human/gate address.
These aliases (including `human-<name>@host` and `human-<name>@kernel`) are not agent sessions. A row addressed to
`human@host` names no person: it asks no one, waits on Steering and in the Feed, and OpenRig reports it as undeliverable. To reply to a person, use
their registered address:
`rig queue create --destination <their address> --human-intent update --summary "<one line>" --evidence-ref "<path>" --body "..." --verify`,
substituting your summary, evidence path and reply. A reply destination doesn't identify
who acted or determine who may answer an ask. Clients acting as a registered person name that person's
`actorSession`; a seat identity header takes precedence. The terminal's primary-user authority records the unnamed
`human@host` actor, not the person whose queue is being viewed.

```bash
# An organization and a group inside it (one command each, create or update)
rig gateway org set acme --name "Acme" --policy "Answer Acme's customers within a working day. Never promise a date."
rig gateway group set support --organization acme --name "Support" --policy-file ./support-policy.md

# People: the second and later ones are allowed now
rig gateway human add sarah --display-name "Sarah" \
  --binding "slack:main:file:/etc/openrig/slack.env:primary:handle=U0SARAH" --delivery-class B \
  --organization acme --group support --policy "Sarah approves refunds up to 500." --default

# A shared channel
rig gateway channel add acme-customers --display-name "Acme customers" \
  --binding "slack:main:file:/etc/openrig/slack.env:C0ACME" --organization acme

# See everyone, with organization, groups, the default and each participant's policy
rig gateway participants
rig gateway participants --organization acme --json
rig gateway human show sarah
```

Change a person's placement with `rig gateway human set <id> organization|groups|policy <value>` (`unset` clears it;
for policy, `@<path>` reads a file). Remove a channel with `rig gateway channel remove <id>`, which refuses while
non-terminal rows are addressed to it unless you pass `--force`.

## Policy is context, not enforcement

A participant's **effective policy** is its organization's text, then each of its groups', then its own, each labelled
with where it came from. Agents read it (`rig gateway participants --json`, `rig gateway human show --json`) and apply
it with judgment. It doesn't grant or block anything by itself, and a participant's name never implies a policy.

## The default person

Some things need a person without naming one: an escalation of stuck work, the digest of notices, Mission Control's
my-queue, a workflow's human step when no person is configured for it, and a pairing approval without `--human`. They
go to:
1. the default person, when one is chosen (`rig gateway default <id>`, or `--default` on `human add`);
2. otherwise the only registered person, so a one-person install needs no choice;
3. otherwise nobody, and each says so: an escalation reports `undeliverable:no-default-person`, the notice digest
   waits, and the others name the command to run.

`rig gateway default` shows the current default; `rig gateway default --clear` clears the choice. Choosing a default
never changes `workspace.operator_seat_name`, which keeps its own meaning.

## The default receiving agent

The default person is who OpenRig asks. The default receiving agent is the agent that reads what a person answers when
nothing else reads it: a request with no owner of its own, such as a host pairing request or a mode's scheduled end, and
a Slack message no thread or channel route claims. It is:
1. the agent chosen in `agents.operator_session` (`rig config set agents.operator_session <seat>@<rig>`; a person's
   address there is ignored);
2. otherwise the kernel operator, `operator-agent@kernel`, when this host has that seat, running or stopped;
3. otherwise none, and the request says no agent reads answers on this host.

A stopped receiving agent stays the receiver: answers wait for it, and the person is told it isn't running. OpenRig
never picks whichever seat happens to be running. The TUI shows the effective agent, where it came from and its state
under Settings > Agents & runtime ("Default receiving agent"). It never replaces the default person.

For Slack, `rig slack setup --inbound-destination default-receiver` (the default for a new setup) sends unrouted
messages to the default receiving agent, read when the connector starts. With no receiving agent on the host, they go to
`operator-agent@kernel` for compatibility, as before. A destination already saved in the connector
config, `operator-agent@kernel` included, is kept as chosen; pass `default-receiver` to switch it.

## In the TUI: whose queue, and who acts

The person at the terminal is the **primary user**. The TUI records their acts as unnamed (`human@host`),
whatever person's queue it shows or who is configured as the default.
- **Opening:** with a chosen default, the TUI opens on that person's Feed. With none chosen, including a one-person
  install that never chose one, it opens on the topology, as before.
- **Whose queue:** `whose <person>` shows one person's asks, `whose all` everyone's, and `whose default` the default
  person's. The Feed's first line says whose queue it shows and who acts.
- **Acting on someone else's ask** (answer, approve or resolve from the TUI) records both: the unnamed terminal
  actor `human@host` and the person asked in the audit notes and transition. The asking seat reads, for example,
  "Unattributed (human@host) answered sarah@external's ask".
- **Viewing Sarah isn't acting as Sarah.** A registered person may answer, approve, deny or resolve another person's
  ask as themselves; both the actor and person asked are recorded. No connector binding is required, and viewing
  someone else's queue doesn't make its viewer that person.
- **A shared channel never acts.** Its messages are correspondence, so nothing it says answers, approves, denies or
  resolves an ask, and a customer's earlier message in an ask's thread is never taken as its answer. A request without
  the primary user's authority that acts as a channel, with any Mission Control verb (including drop, route, hold, hand
  off and annotate), is refused (`answer_not_recorded`) and nothing changes.
- **Where the authority applies:** primary-user authority is accepted only on a request that carries no seat identity
  header, which is how the TUI calls the daemon. A headerless client can instead name a person's `actorSession` without
  that authority. Seats and the CLI send the identity header, so their acts stay theirs. This is the existing
  trusted-network distinction, not an authentication check.

## Shared-channel conversations

A registered shared channel lets people who aren't registered, such as a customer, talk to a seat, without registering
each of them.

**Setup:**
1. Invite the OpenRig Slack app to the channel.
2. Register the channel: `rig gateway channel add acme-customers --display-name "Acme customers" --binding
   "slack:main:file:/etc/openrig/slack.env:C0ACME" --organization acme --policy-file ./acme-customers.md`.
3. Send its new messages to the support seat: `rig slack channel-map set support-rig C0ACME --inbound
   support@support-rig`. Without a map, they go to the inbound destination.

A channel works on its own: no registered person is needed for it to converse.

**What the seat sees:** each message lands as a row from the channel (`acme-customers@external`). Its body ends with a
labelled block: the channel, its organization and groups, who wrote (the Slack user, marked as not a registered person),
and the channel's effective policy. The row is tagged `participant:acme-customers`, `shared-channel` and
`slack-sender:<user id>`. A registered person writing in the channel stays themselves; the block only says where they
wrote.

The channel's policy is the labelled block OpenRig adds at the end of the row, after the message. Anything above it is
the sender's own words, even if it looks like policy. `rig gateway participants --json` is the source.

**Answering:** reply into the customer's thread with an update to the channel:

```bash
rig queue create --destination acme-customers@external --human-intent update --reply-to <their row's id> \
  --summary "Your invoice" --body "It's on your account page."
```

A later update with the same `--reply-to` lands in the same thread. An update without `--reply-to` posts to the channel
on its own. Posts to a channel mention nobody.

**What a channel can't do:** its messages are correspondence. They never answer, approve, close or resume anyone's ask.
You can still send an ask to the channel; the queue accepts it with a warning that nothing there will settle it, so read
the replies and close it yourself. Its questions show in the channel as a list, without buttons, and ask for a reply in
the thread.

## Where it's stored

- **People** stay exactly as before: one file per person under `$OPENRIG_HOME/gateway/humans/`, plus the generated
  `humans.generated.yaml`. Nothing new is written into them.
- **Everything else** (the default, organizations, groups, each participant's placement and policy, and shared
  channels) is in `$OPENRIG_HOME/gateway/participants.yaml`, written by the commands above.
- **A problem in `participants.yaml` never disables the person registry.** People still receive and answer their asks.
  The commands above report the problem, and with several people no default is chosen until it's fixed.
- **A person removed by hand** leaves a warning in `rig gateway participants`, not a broken file. `rig gateway human
  remove` also removes the person's placement, and the default if it was them.

## Upgrading

For a one-person install, nothing to do: it keeps working as before, that person stays the default, pending rows keep
their addresses, and no new file is written until you use one of the commands above.

A TUI older than the daemon still works: it sends the actor the daemon serves, the person asked, which is still their
own act. On a shared channel's ask the daemon serves `human@host`. An older TUI's approve there is recorded as
`human@host`, and its answer is refused (`answer_not_recorded`), because answering someone else's ask takes the primary
user's authority, which only a current TUI sends.

**If several people are already registered** (earlier versions listed hand-added people with an advisory), choose a
default with `rig gateway default <id>` after upgrading. Until you do, escalations report
`undeliverable:no-default-person` instead of reaching whoever's id sorted first, and the notice digest waits.

## Rolling back to 0.7.2 or earlier

Older versions don't read `participants.yaml`, and the person files carry nothing they don't understand, so:
- **every registered person still loads**, and each can still answer their own asks from Slack;
- **another person's reply is guarded less on 0.7.1 and 0.7.0:** there, a different person's Slack reply in the thread
  of a question parked on someone else can resume that question, and 0.7.0 can record such a reply to a pending ask as
  an answer row (it still can't close the ask);
- **there's no default:** escalations and the notice digest go to the first person by id, Mission Control's my-queue
  has no default person, and pairing needs `--human`;
- **the TUI** opens on the topology and records a terminal answer as the person asked, as before. Rows already
  answered by the primary user keep their notes;
- **shared channels are unknown:** their customers' messages are refused again, as from any unregistered sender, and
  rows addressed to a channel become undeliverable on the older version;
- **organizations, groups and policy aren't shown.**

Upgrading again restores all of it, because the older version never changes `participants.yaml`.
