# OpenRig Claude Compaction Restore Prompt

Please restore this Claude Code session from durable evidence before
continuing work.

1. Read the pending restore marker if OpenRig gave you one. If it is missing,
   inspect the newest matching packet under `/tmp/claude-compaction-restore/`.
2. Load or read the `claude-compaction-restore` skill.
3. Read the restore packet's `restore-instructions.md` and `touched-files.md`.
4. Identify the files that are important to the active task, then read those
   files from disk before resuming.
5. Reconcile current queue/session state with `rig whoami --json`, the active
   queue item, and any transcript paths named by the restore packet.
6. Before continuing implementation, review, QA, or orchestration work, state:
   active task, queue item or mission, evidence read, blockers or caveats, and
   the next concrete step.

If a restore surface is unavailable, say exactly which one is unavailable and
continue with the strongest remaining evidence. Do not claim restoration from
memory alone.
