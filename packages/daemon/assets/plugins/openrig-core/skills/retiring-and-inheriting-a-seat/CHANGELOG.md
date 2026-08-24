# Changelog — retiring-and-inheriting-a-seat

**`SKILL.md` carries the mechanic; this file carries how it got there.** Rationale, superseded
designs, and the incidents that produced a rule live here so the instruction surface stays
instructional.

---

## 2026-08-13 — wake is a verb now, and the packet must not bound the channel (Wake v0)

### Two corrections to the same section

**1 · The mechanism claim was stale.** The section read *"In v0 this is a practice + skill, not a
`rig` verb — wrap it in a verb only when convenience and consistency earn it."* `rig ask --wake`
had since shipped in CLI 0.5.1, with `--runtime` and `--wake-timeout` (default 180s). A retiring
agent reading the old line would have told its successor a verb existed only in principle.

The verb is a thin wrapper over the harness resume and is **not yet well-exercised** (mission owner,
2026-08-13), so the fallback to `claude -p --resume` is stated inline rather than left implied. **A
failing wrapper must never be read as a closed channel** — that inference was made once already and
cost a successor several turns.

**2 · The retiring side is where the reach-back failure is caused.** Across lineages on record, the
successor consulting its predecessor has almost never happened, and the packet is what suppresses
it. Two shapes, both observed in real packets on this rig:

- **Bounding the channel in time** — *"ask while the window is open"*, *"after this I am a
  transcript, not a conversation"*. Neither is true: a retired tenure stays resumable while its
  session record exists, and the only real bound is its own context wall hit while answering. The
  second phrasing measurably cost a successor a capability it had (see
  `orienting-to-an-inherited-seat/CHANGELOG.md`, 2026-08-13).
- **Offering access without a trigger** — *"predecessor consultation: not needed"* and *"you may
  consult your predecessor"* each produced **zero consultations** from otherwise capable successors.

The distinction worth preserving, because retiring agents keep collapsing it: *"treat my answers as
testimony"* is a **posture** claim and it is correct. *"You can no longer converse with me"* is a
**capability** claim and it is false. They get written as the same sentence.

### Why the guidance is phrased as what to write

Stated positively (*state that the channel does not expire; give your verbatim handle; pre-form the
questions*) rather than as a list of forbidden sentences. A prohibition list in `SKILL.md` would
draw attention to phrasings a retiring agent would otherwise never produce.

### Standing

The fix is unverified. The measurable outcome is whether the next successor asks unprompted, and
more than once — the baseline is zero.
