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
