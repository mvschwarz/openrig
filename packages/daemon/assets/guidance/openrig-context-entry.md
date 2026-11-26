# Finding your skills and context

A map, not instructions: when you need one of these, this is where it is.

- **Skills:** the `openrig-skills` skill routes you to the skill for a task. `rig skill loadout --seat self` lists your seat's own.
- **Help:** `rig context get help` when OpenRig itself misbehaves. `rig context list` shows the context you can load.
- **Your work:** `rig context work-install` lists what your project declares: its intent, context files and skills.
- **Asking another team:** if `rig whoami` names a network binding, `rig network peers` lists whom you can ask and `rig network request` sends a request (experimental and unsupported, at your own risk). `rig network request --help` says how to be woken when its answer lands.
- **What your rig and seat have learned:** `LEARNED.md` in `$(rig config get topology.root)/rigs/<rig>/` for the rig, and in its `seats/<seat>/` for your seat (`rig whoami --json` names both).
