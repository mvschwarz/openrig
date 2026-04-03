# Using Rigged

You are running inside a Rigged-managed topology. These commands are your operating primitives.

## Identity

Run this first after launch or compaction to recover your identity:

```
rigged whoami --json
```

This returns your rig, pod, member, peers, edges, and transcript path. Treat it as ground truth.

## Communication

Send a message to a peer:
```
rigged send <session> "message" --verify
```

Read a peer's terminal output:
```
rigged capture <session>
```

Broadcast to all peers in your rig:
```
rigged broadcast --rig <name> "message"
```

## Transcript Recovery

Read recent transcript output:
```
rigged transcript <session> --tail 100
```

Search transcripts for specific content:
```
rigged transcript <session> --grep "pattern"
```

## After Compaction

If you lose context, run `rigged whoami --json` immediately. It tells you who you are, who your peers are, and how to reach them. Then use `rigged transcript` to recover recent history.
