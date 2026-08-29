# Changelog — orienting-to-an-inherited-seat

**`SKILL.md` carries the practice; this file carries how it got there.** Rationale, superseded
wording, and the incidents that produced a rule live here so the instruction surface stays
instructional.

---

## 2026-08-13 — "the channel does not expire" (Rule 3)

### The incident

A successor seat concluded mid-conversation that its reach-back
window had closed at cutover, and reasoned from that for several turns before being challenged.

It was wrong. `rig ask --wake` ships in CLI 0.5.1, the predecessor's session record was intact and
resumable, and the seat's own lineage carried a wake rule explicitly marked active from the
retirement row onward. **One `rig ask --help` would have settled it.**

### What produced the error

Two artifacts asserted a bound that does not exist, and the successor inherited one side of a
contradiction without checking:

- the handover packet: *"I am a transcript after retirement, not a conversation. Ask while the
  window is open."*
- the operating-model README: *"Until this seat is retired, ask it directly... After that it is a
  transcript: greppable, not conversational."*

Both were written by an author who knew better — the same tenure authored the correct wake rule in
the lineage. The charitable reading of "greppable, not conversational" is a **posture** claim (treat
a woken tenure as testimony), which is right. It is phrased as a **capability** claim, and it was
read as one.

### Why the fix is worded positively

The generalisable form: **prose that talks a capable reader out of a capability it has.** This is
worse than a missing trigger. `PREMISE-capable-and-underinformed.md` already records that
affordances without triggers go unused (*"you may consult your predecessor"* → zero consultations
across a lineage). This is one turn worse — a **counter-trigger**. The successor did not fail to
reach for the channel; it concluded the channel was absent.

So Rule 3 now states the true bound positively rather than warning about the bad wording. Rule 2
(*the packet is testimony, checked not believed*) already covers refusing a stale packet claim, and
naming the specific bad sentence in `SKILL.md` would install the doubt it is trying to prevent.

### Also added

- **The real bound**, which had never been written down anywhere: the predecessor's own context
  wall, hit *while answering* — yielding a truncated answer, an unclear error, or nothing. That is
  one exhausted tenure, not a closed channel.
- **Ask repeatedly, across the first working day.** Observed in the same handover: the successor's
  only high-value question arrived after hours of work with the artifacts, when a reconciliation
  failed. Questions formed at orientation are shallow.
- **The live-resume tier**, which existed and was undocumented: resume a tenure into a named tmux
  pane and message it with `rig send` for multi-turn work.
- **`rig ask --wake` reliability caveat.** The verb is a thin wrapper over the harness resume and is
  not yet well-exercised (mission owner, 2026-08-13). A failing wrapper must not be read as a closed
  channel — fall back to `claude -p --resume`.

### Standing

Not yet re-tested. The next handover is the test: if a successor uses the channel more than once and
without prompting, the fix worked. **Zero unprompted consultations remains the baseline to beat.**
