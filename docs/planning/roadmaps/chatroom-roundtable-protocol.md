# Chatroom Roundtable Protocol

This protocol describes how agents use `rig chatroom` for structured multi-agent discussions.

## Room Lifecycle

1. **Check existing traffic**: `rig chatroom history <rig> --limit 20`
2. **Clear if needed**: `rig chatroom clear <rig>` — removes all messages
3. **Set topic**: `rig chatroom topic <rig> "ROUND START" --sender <your-session>`
4. **Discuss**: participants post via `rig chatroom send <rig> "message"`
5. **Close**: `rig chatroom topic <rig> "ROUND CLOSED" --sender <your-session>`

## Starting a Round

Before starting a new discussion in an existing room:

```bash
# Check if old traffic exists
rig chatroom history my-rig --limit 5

# If old traffic matters, save it first
rig chatroom history my-rig --json > /tmp/old-room.json

# Clear the room
rig chatroom clear my-rig

# Start the new round
rig chatroom topic my-rig "architecture review" --sender orch1-lead@my-rig
```

## Posting

```bash
rig chatroom send my-rig "My position on the proposal: ..." --sender dev1-impl@my-rig
```

Always include `--sender` with your canonical session name.

## Monitoring (Host)

Hosts should poll with `wait` rather than manual checking:

```bash
# Wait for any new message
rig chatroom wait my-rig --timeout 120

# Wait for a specific participant
rig chatroom wait my-rig --sender rev1-r1@my-rig --timeout 120

# Wait for messages in the current topic
rig chatroom wait my-rig --topic "architecture review" --timeout 120
```

`wait` blocks until matching messages arrive or times out. Exit code 1 on timeout.

## Filtering History

```bash
# Messages from a specific participant
rig chatroom history my-rig --sender rev1-r1@my-rig

# Messages since a timestamp
rig chatroom history my-rig --since "2026-04-08T10:00:00Z"

# Messages after a known cursor
rig chatroom history my-rig --after 01KNXXXXXX

# Combine filters
rig chatroom history my-rig --sender alice --since "2026-04-08T10:00:00Z"

# Messages within a topic window
rig chatroom history my-rig --topic "architecture review"
```

## Closing a Round

```bash
rig chatroom topic my-rig "ROUND CLOSED" --sender orch1-lead@my-rig
```

## Expectations

- Agents should check the room before posting if they lost context (compaction recovery).
- Hosts own the round lifecycle: topic markers, clearing, closing.
- `wait` is the honest polling primitive — do not fake background awareness.
- Clear is destructive and rig-scoped. Save first if the contents matter.
