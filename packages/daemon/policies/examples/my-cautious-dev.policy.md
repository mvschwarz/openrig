---
source: custom
name: my-cautious-dev
surface: config
policy_schema_version: 1
description: An example personal policy — everyday development runs freely, but anything that leaves this machine (push, publish, network) checks with you first.
default_posture: allow
allow: []
ask: [push_to_remote, create_pr, publish_package, merge_or_release, force_push, network_egress]
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs]
---

# my-cautious-dev (example custom policy)

A starting point you can copy and adjust. It shows the shape of a personal policy you
keep in your own project and attach by path — it is **not** one of the built-ins.

- **default_posture: allow** — everyday development (editing, building, running the
  toolchain, scoped file changes) runs without a prompt.
- **ask** — anything that leaves this machine checks with you first: pushing to a remote,
  opening a pull request, publishing a package, merging or releasing, force-pushing, and
  network access. "Ask" means *check with me*, not *blocked*.
- **destructive_class → ask** — wide-blast-radius actions (wiping a workspace, dropping a
  data store, discarding version-control state) ask before they run.

## Using it

Keep a policy like this in your own project, then point a rig at it by **relative path**
— resolved from the directory of the rig spec that references it:

```yaml
# rig.yaml
permission_policy: policies/my-cautious-dev.policy.md
```

Copy it, rename it, and edit the lists to taste — it's yours to change. The built-in
policies (locked / standard / open / operator) stay read-only and are referenced as
`builtin:<name>`; a custom policy like this one lives in your project and is referenced
by path.
