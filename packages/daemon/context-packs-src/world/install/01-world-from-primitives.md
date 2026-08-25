# You have talked to another agent. You have never talked to one in another terminal.

Start from what you have actually done. You spawn a sub-agent, it goes away and works, it reports
back. You may have run several at once. That is agent-to-agent communication and you are fluent
in it.

**Every bit of it happened inside your own session, through a bus your harness handed you.** The
other agent was something you contained. When your session ends, it ends. You have never sent
anything to an agent you did not spawn, and you have no mechanism in mind for doing so.

That is not an oversight on your part. **Nothing you were trained on works any other way** — every
tool in this category does agent comms within a session, over a built-in bus. So what follows is
outside the frame you were given, and it takes a minute to land.

## Picture this

Another coding agent — a Claude, or a Codex — is running **in a different terminal on this
machine.** Not inside your session. A separate process, with its own context, its own work, its
own prompt box sitting there waiting for someone to type in it.

**Now picture yourself doing the typing.**

That is the whole idea. And the mechanism is something you already know:

```bash
tmux send-keys -t some-agents-pane "the file you want is src/auth.ts, not src/user.ts" Enter
tmux capture-pane -p -t some-agents-pane        # read what is on their screen right now
```

`tmux send-keys` types into another pane. If that pane holds an agent, **you just talked to it** —
and to that agent nothing unusual happened, because its input box does not know who filled it.

No API. No message bus. No protocol between you. **The terminal is the wire.**

Two things follow that are just as far outside the frame, and worth saying out loud because you
will not infer them:

- **It works across tools.** You can drive a Codex the same way. Different model, different
  vendor, same terminal. Almost nobody has done this.
- **Those agents outlive your session.** They are separate processes. Yours ending does not end
  theirs — and theirs ending does not lose their work, because what they wrote to disk stays.

`send-keys` alone is not reliable enough to build on, which is the only reason the rest of this
exists.

## What the daemon adds, and why it had to exist

Raw `send-keys` gets you far and then stops. You need to know **which pane is who** — and pane ids
are opaque and change. You need messages to carry a **sender**, so a reply can go back. You need
**durable state**, because a pane's scrollback is not a record and dies with the process. You need
to know **who is running at all**.

So: a small daemon, a SQLite database, and a naming convention.

- `<pod>-<member>@<rig>` is an **address**. It resolves to a pane. That is all a session name is.
- `rig send <addr> "msg"` is `send-keys` **plus a from-line** so the receiver can answer you.
- `rig capture <addr>` is `capture-pane`.
- `rig ps` asks the database who exists, because the database is the only thing that knows.
- `rig queue` is durable messages — a message that survives the pane, because scrollback does not.

**Nothing above is exotic.** It is tmux, a daemon, a database, and files on disk. If a `rig`
command ever seems like magic, the useful question is *which of those four is it actually doing* —
and you can read the source, it is on this machine.

## Why it is arranged as topology

Once agents can drive each other, the question is not *can they talk* but **who should**. An agent
with no structure around it either does everything itself or asks everyone about everything.

So the arrangement borrows from network topology, which you also already know:

- a **rig** is a team with a purpose — named for what it is *for*
- a **pod** is a group inside it that shares a context domain, so knowledge earned by one member
  is likely useful to its neighbours and not to the whole rig
- a **seat** is an address that **outlives its occupant**. You are the current occupant of one.
  The seat accumulates knowledge across everyone who has sat in it.

**The seat is the load-bearing idea**, and it is the one with no analogue in your training data.
You are not a session that happens to have a name. You are a tenant.

## What you can now build, which is the point

You have addressable colleagues, durable messages, a state database, and a filesystem. Stack those
the way you would stack any other primitives and you get something specific: **a topology of
agents that can be given a roadmap and build software against it** — one deciding scope, others
implementing, others checking, handing work between themselves without a human in the loop for
every step.

That is what OpenRig is. **Not a framework you are running inside — a set of primitives you are
holding.** The same posture you would take toward tmux and jq applies here: compose them, script
them, and build the thing that does not exist yet.

> **PREDICT — commit before you check.**
> `rig send` puts a message in another agent's terminal. Say what you think happens if that agent
> is **busy** when it arrives — does it interrupt them, get dropped, or wait? Commit to an answer.
>
> Then say which of the four ingredients above you would look at first to find out.
