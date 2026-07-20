# OpenRig Start

You are running inside an OpenRig-managed topology.

This file is the thin bootstrap overlay, not the full OpenRig manual.
Use it to recover identity, communicate, and regain context after launch or compaction.

For the full OpenRig command surface, load the packaged `openrig-user` skill now.
If your runtime supports skills, use that mechanism.
If it does not auto-load skills reliably, read the packaged copy directly from your current project or workspace:

- Claude Code usually sees it under `.claude/skills/openrig-user/SKILL.md`
- Codex usually sees it under `.agents/skills/openrig-user/SKILL.md`

That skill covers the broader surface, including chatroom, discovery, adopt/bind/attach, lifecycle, specs, bundles, and richer operator workflows.

Your per-session startup guidance may also name additional packaged skills for your role and pod.
Load those too. This shared overlay is only the common bootstrap floor, not the full operating manual for your seat.

## Working missions and slices (the SDLC)

If your seat works missions or slices, load the packaged `mission-slice-sop` skill BEFORE authoring or building — it teaches the flow the Living Notes UI projects: intent → mini-requirements + proof contract (→ mockups for UI slices) → plan-lock (`rig scope slice approve --scope spec`) → build the locked set → QA visual compare → `rig proof add … --media` drops (the C1 drop verb — never hand-place proof files) → proof-lock (`--scope delivery`).

The conventions themselves (section names, proof-contract format, the two locks, C1 proof headers) live in ONE shipped document: `docs/reference/sdlc-conventions.md` in the repo, materialized at `$OPENRIG_HOME/reference/sdlc-conventions.md` (default `~/.openrig/reference/sdlc-conventions.md`) on an installed package. `rig scope slice create` scaffolds the convention sections for every template kind; `rig scope audit` is the advisory backstop — it records and advises, it never blocks your work.

## Identity

Run this first after launch or compaction to recover your identity:

```bash
rig whoami --json
```

This returns your rig, pod, member, peers, edges, and transcript path. Treat it as ground truth.

## Communication

Send a message to a peer:
```bash
rig send <session> "message" --verify
```

Read a peer's terminal output:
```bash
rig capture <session>
```

Broadcast to all peers in your rig:
```bash
rig broadcast --rig <name> "message"
```

## Transcript Recovery

Read recent transcript output:
```bash
rig transcript <session> --tail 100
```

Search transcripts for specific content:
```bash
rig transcript <session> --grep "pattern"
```

## After Compaction

If you lose context, run `rig whoami --json` immediately. It tells you who you are, who your peers are, and how to reach them. Then use `rig transcript` to recover recent history.
