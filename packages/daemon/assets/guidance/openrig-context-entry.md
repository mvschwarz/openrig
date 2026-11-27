# Finding your skills and context

- **Claude Code Bash:** one plain `rig` command per call; row text via `--body-file`. See `openrig-user` for the method and why compound commands can prompt.
- **Skills:** `openrig-skills` routes tasks; `rig skill loadout --seat self` lists your seat's skills.
- **Help:** `rig context get help` for OpenRig problems; `rig context list` lists available context.
- **Your work:** `rig context work-install` lists declared project intent, context and skills.
- **Asking another team:** if `rig whoami` names a network binding, `rig network peers` lists whom you can ask and `rig network request` sends a request (experimental and unsupported, at your own risk). `rig network request --help` says how to be woken when its answer lands.
- **What your rig and seat have learned:** `LEARNED.md` in `$(rig config get topology.root)/rigs/<rig>/` for the rig, and in its `seats/<seat>/` for your seat (`rig whoami --json` names both).
