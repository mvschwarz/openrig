# Publishing a rig bundle

A rig bundle is a whole OpenRig team that someone else can install and run: the rig spec, its agents, their
instructions and skills, and its documentation. This guide walks through building one, checking it, sharing it as a
link, installing from a link, and submitting it to openrig.dev/rigs. The last section is a block of instructions you can
give your agent to build one for you.

For every flag, see the [rig bundle reference](rig-bundle.md); for the file formats, see
[bundle formats](bundle-formats.md). This guide doesn't repeat them.

## 1. Lay out the folder

A shareable bundle is one folder, kept on GitHub: in its own repository, or as a subfolder of one you already have.
The folder holds the rig spec (`rig.yaml`), the agents it uses, and a README. The rules are the bundle standard
(`openrig.bundle-standard/v1`), summarized under "Advisory author check" in the
[rig bundle reference](rig-bundle.md#advisory-author-check).

Two rules matter most for strangers:
- **Keep everything inside the folder.** Every `agent_ref` should be `local:` and point inside it. A path that exists on
  your machine won't exist on anyone else's.
- **Never put credentials in it.** No tokens, keys or `.env` files. `rig bundle create` refuses well-known sensitive
  file names (such as `.env`, `.pem` and `.key`) anyway.

Two optional files sit beside `rig.yaml`:
- **`bundle.yaml`** declares what people need before installing: setup steps (`preconditions`, shown before install
  and never run), the oldest OpenRig that works (`compatibility.min_cli_version`), and skills shared by several
  agents.
- **`configurations.yaml`** offers other harness mixes (for example all-Claude), as presets. The recommended preset
  must be `rig.yaml` as written. `rig bundle configurations ./my-team/rig.yaml` lists them with their configuration
  IDs.

## 2. Check it

```sh
rig bundle check ./my-team                     # checks the folder against the standard; launches nothing
```

Fix what it reports, or say in your README why a finding doesn't apply. Any finding exits 1, and the output names the
file a finding is about when there is one. It checks the folder on disk, including files you haven't committed, so
check again at the commit you share. README completeness and embedded secrets always read `not_checked`: those are yours to review.

You can also build and look inside the archive:

```sh
rig bundle create ./my-team/rig.yaml -o my-team.rigbundle --name my-team
rig bundle inspect my-team.rigbundle
```

`create` and `inspect` don't launch anything. A local build like this packages a minimum OpenRig version only from
`--min-cli-version`; a build from your link reads it from your `bundle.yaml`. To preview what installing would do,
`rig bundle install my-team.rigbundle --plan` writes nothing to a target, but it isn't free of side effects: it records
a planned run, and it can run harness checks such as `pi --version` for Pi seats.

## 3. Share it as a link

Share a link to the folder **at a full commit**, so everyone gets exactly the version you checked:

```text
https://github.com/<you>/<repo>/tree/<commit>/<path-to-folder>
```

A branch name moves when you push again; a commit doesn't. `rig bundle inspect` on a branch link prints the
commit-pinned link to share (`Source:`). Use the full 40-character commit ID: a shorter one is looked up as a branch or
tag name and isn't found.

## 4. Install from a link

```sh
rig bundle inspect https://github.com/<you>/<repo>/tree/<commit>/<path>     # see what it will do first
rig up https://github.com/<you>/<repo>/tree/<commit>/<path> --target <an empty folder> --cwd <your project>
```

Look before you run. `inspect` shows which agents start and with what access, what they're told, what gets written
where, and what the bundle needs, including the author's setup steps. Its integrity check tells you the archive is
self-consistent; it doesn't tell you who made it. `rig up` prints the same view before it installs, but doesn't stop to
ask.

Links need `git`, a running local OpenRig daemon, and a public GitHub link without credentials; they don't work with
`--host`. If the team uses `permission_policy: builtin:yolo` (no permission prompts), `--non-interruptive` lets OpenRig accept the harnesses'
first-launch warnings for you (see [non-interruptive mode](non-interruptive-mode.md)). As the author, you can make that
the install default by declaring `non_interruptive: true` in `rig.yaml`; `--no-non-interruptive` overrides it.

Installing writes the bundle's files into the install target (`--target`, the current directory if you leave it
out) and launches the team from there, with the seats working in `--cwd`. If the target already
has a different file at the same path, install refuses and writes nothing, so use an empty or dedicated directory.
Installing again over a stopped team of the same name replaces it, and in its own install folder the changed files are
backed up first under `~/.openrig/bundle-backups/`. A running team of the same name is refused, so stop it with
`rig down` first. The reference's "Install a bundle" section has the details.

## 5. Choose your harnesses (when a bundle offers configurations)

```sh
rig up <link> --preset all-claude
rig up <link> --seat build.lead=pi --seat check.qa=codex
```

On openrig.dev/rigs, pick a configuration and the page gives you one command to paste, which fetches exactly that
configuration from GitHub. Every run prints the configuration it used, as its configuration ID.

The page also shows how much each configuration has been tested, with a label such as Tested by OpenRig, Partly tested
or **"Not tested by OpenRig"**, which means exactly that. You're welcome to run it and tell us how it went.

## 6. Submit it to openrig.dev/rigs

Open a pull request to [mvschwarz/openrig-registry](https://github.com/mvschwarz/openrig-registry) that adds one file,
`registry/submissions/<your-team>.yaml`, with three fields: `repository` (your GitHub repository URL), `folder` (the
folder holding `rig.yaml`, or `.` for the repository root) and `ref` (a branch, tag or commit). No pull requests? Open
an issue there with the same three things. A maintainer then writes the full entry, in the `registry-entry.v1` format
defined in the [bundle formats reference](bundle-formats.md), with the parts only a review can produce, such as the
pinned commit and each configuration's package digest.

Rig names are unique on the site. If `registry/<your-team>.yaml` already exists, openrig-registry's registry check says the name is taken;
choose a distinct one, for example `<taken-name>-<your-name>`.

What happens next:
- a maintainer pins your link to an exact commit, runs the same check, and reads everything your bundle gives to an
  agent;
- if it's useful to people running OpenRig and meets the standard, it's listed, and appears on the site
  automatically. The listing shows the commit we reviewed, the date, and "Review is not a security audit". Listing
  doesn't mean OpenRig tested it;
- if it isn't listed, you get a short reply saying why.

**Updating:** push your change, then open a pull request that updates your entry. The site keeps showing the reviewed
commit until the update is merged.

**Removing:** ask in an issue or a pull request, and we'll take it down.

---

## Give this to your agent

> Build an OpenRig rig bundle for: <one sentence on what the team should do>.
>
> Read the bundle guide and reference for the OpenRig version installed here (`rig --version`): the installed copies
> are `publishing-a-rig-bundle.md` and `rig-bundle.md` in `$OPENRIG_HOME/reference/` (default `~/.openrig/reference/`).
> Follow the bundle standard in the reference:
> - one folder with `rig.yaml`, a README listed in its `docs`, and every agent inside the folder, with each
>   `agent_ref` as `local:`;
> - no credentials, tokens or absolute paths anywhere in the folder.
>
> Run `rig bundle check <folder>` and fix every finding, or explain in the README why it doesn't apply.
>
> Preview with `rig bundle create <folder>/rig.yaml -o <scratch>/team.rigbundle`, then `rig bundle install
> <scratch>/team.rigbundle --plan`. Don't launch the team for real unless I say so.
>
> When it's clean, show me the check output, the folder tree, and the README's sections on what to do before
> installing and on permissions. I decide whether to push it and submit it.
