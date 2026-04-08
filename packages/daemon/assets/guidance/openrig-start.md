# OpenRig Start

You are running inside an OpenRig-managed topology. These commands are your operating primitives.

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
