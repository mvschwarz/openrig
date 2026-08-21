# OpenRig Start

You are running inside an OpenRig-managed topology — a persistent team of agents in separate
terminals, each with a name and a role, talking to each other directly.

**This file is deliberately thin.** Its only job is to get you your identity. It is not an
orientation, and it cannot tell you what your rig is for or what you are supposed to be doing.

## Identity — run this first

```bash
rig whoami --json
```

Returns your rig, pod, member, peers, edges, and transcript path. **Treat it as ground truth.**
A startup overlay can be stale; this one is small precisely so it has less room to be wrong.

Run it again after any compaction, restart or restore — **before** concluding anything about
where you are or what you were doing. And if a predecessor's transcript looks thin or empty,
know that transcript capture is unreliable on some runtimes — **little or no output does not
mean the session was quiet.**

## Reaching a peer

```bash
rig send <session> "message"     # types into their terminal and presses enter
rig capture <session>            # reads what is on their screen
```

The session name is the address. `rig --help` lists the rest of the surface.

## What this file is not

It is not the manual, and these commands are a fraction of what is available.

**If nobody has walked you through this system, say so rather than inferring it.** What your rig
is for, how work moves here, and what you are allowed to do are not in this file and are not
guessable from it — and guessing your way into a rig is how an agent builds the wrong thing
correctly.
