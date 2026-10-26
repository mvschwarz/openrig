# Gateway participants: several people, shared channels, organizations and policy

OpenRig's gateway can register **several people** and **shared channels**, group them into **organizations** and
**groups**, give each readable **policy** text, and name a **default person**. Agents read the policy and apply it;
OpenRig doesn't enforce it. This page covers the commands, what the default is for, and what upgrading and rolling back
do.

## Participants

A participant is either:
- **a person**, registered with `rig gateway human add` as before, with their own Slack binding; or
- **a shared channel**: one vetted Slack channel registered as one participant, `<id>@external`, not a person per
  sender.

People and channels share one address space: a channel can't take a person's id.

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

**If several people are already registered** (earlier versions listed hand-added people with an advisory), choose a
default with `rig gateway default <id>` after upgrading. Until you do, escalations report
`undeliverable:no-default-person` instead of reaching whoever's id sorted first, and the notice digest waits.

## Rolling back to 0.7.1 or 0.7.0

Older versions don't read `participants.yaml`, and the person files carry nothing they don't understand, so:
- **every registered person still loads**, and each can still answer their own asks from Slack;
- **another person's reply is guarded less:** on an older version, a different person's Slack reply in the thread of a
  question parked on someone else can resume that question, and 0.7.0 can record such a reply to a pending ask as an
  answer row (it still can't close the ask). Those protections are newer than 0.7.1;
- **there's no default:** escalations and the notice digest go to the first person by id, Mission Control's my-queue
  has no default person, and pairing needs `--human`;
- **shared channels are unknown:** rows addressed to one become undeliverable on the older version;
- **organizations, groups and policy aren't shown.**

Upgrading again restores all of it, because the older version never changes `participants.yaml`.
