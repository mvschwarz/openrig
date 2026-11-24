---
name: rigs
description: Use when a person in their own Claude Code, Codex or OMP (Oh My Pi) session mentions OpenRig, rigs or the rig command, or wants a team of coding agents (Claude Code, Codex) on their project. That includes installing, setting up, starting or updating OpenRig, seeing, getting back to or re-attaching to their OpenRig agents (including bringing a stopped team back), TUI or operator, starting or sharing a team, and joining this session to one. Operating a running rig from inside it (fleet recovery, seat handover, watchdog wakes, in-rig upgrades) is the openrig-skills skill.
---

# rigs: your route into OpenRig

OpenRig runs a team of coding agents (Claude Code, Codex and others) side by side in tmux. A local daemon keeps their
tasks, messages and state, so the team keeps working across restarts. This skill gets OpenRig installed, gets a team
working on what the person wants, and shows how to work with that team from here.

**The goal is a team doing the person's work, not just an install.** Go through the steps in order and stop early only
if the person asks. Give what they want built to OpenRig's operator (step 2) instead of building it yourself.

**The team's questions are the person's.** Hold to this from the first handoff, even if you read nothing else here:
- **Ask before answering any prompt.** A seat's permission, trust or hook-review prompt is theirs to answer: show it
  to them and send only the choice they made. Approving a plan, a task or "go ahead" isn't an answer to the prompts
  that work raises: each one still goes to them. Never tell the team they approved something, or will answer a prompt,
  unless they said so.
- **An answer covers exactly the prompt it answered.** A later prompt, even one like it, goes back to them, unless
  they told you outright to decide that kind of prompt (step 2). If they want fewer prompts, the operator offers once
  to allow the commands that keep asking, for their project only (step 2).
- **Hand work over with a return route** (`--return-route auto`, or `self` if this session joined; step 2), so most of
  the team's questions come to this conversation's address (choice dialogs and other hosts keep their path), and its
  result is in the handed-over task's resolution. Set it before you promise to report back. Where your app wakes you
  when a background command ends (Claude Code versions that do), start this wait with your shell tool's background
  option right after the handover, with your address in place of `<address>`, so you hear when the work moves:

      until OPENRIG_SESSION_NAME='<address>' rig queue list --owned --state pending --json 2>/dev/null | grep -q '"qitemId"'; do sleep 20; done

  When it ends, claim each pending task at once (claiming isn't answering), handle it, then start the wait again
  (step 2, "Get woken when a task arrives at your address"). Elsewhere this chat has no wake of its own: say you'll
  check when they ask, and each turn list your address's tasks, read the handed-over task (`rig queue show <id>
  --full`, following its successors) and check the seats.
- **Don't send them to attach** to a seat's terminal to answer, and with no display (headless or SSH) they answer here
  too: don't tell the operator they'll answer in its pane unless they chose that. Bring the prompt here. If the
  operator or a seat sent it to you, record their words and let that sender pass them on; otherwise send their choice
  yourself, with `rig send`, not raw tmux keys into a seat's terminal. If your own app refuses that send (an auto-mode
  check, say), tell them what it refused and why, and let them choose: approve it there, or answer in the team's
  terminals the operator opened. Don't retry it another way.

The full rules are in step 2, "Bring seat permission prompts to the person here".

**If `/rigs` or your skill tool said this skill doesn't exist** right after it was added to a running Claude Code
session: that session doesn't see a skills folder created after it started. Ask the person to type `/reload-skills`
(Claude Code 2.1.152 or later), or start a new session, then `/rigs`. Until then, read this whole file before you act on
it; a step skipped here changes where the person answers the team.

Tell the person what you're about to run and why before you run it. Don't install system packages or change their
machine without a yes, and don't start a team, including `rig up`, without their yes to what it will start; a yes they
already gave for that same launch counts, so don't ask twice. Starting OpenRig and a team writes files: Codex hooks and settings in
`~/.codex/config.toml`, Claude Code workspace trust in `~/.claude.json`, discovery skills in `~/.claude/skills` and
`~/.agents/skills`, and, in the repository, managed guidance in `AGENTS.md` or `CLAUDE.md`, activity hooks in
`.claude/settings.local.json` and a status line there unless the project already has its own, plus the team's skills
and plugins. Unless a permission policy, a per-seat choice or (for Codex) a named profile applies, the kernel's own
seats run with an operational default: Codex with `-s danger-full-access -a never`, and Claude Code with its file
tools, web fetches and operational commands, including reads under the home folder, allowed without asking. Say so
before you start OpenRig ([the full list](https://github.com/mvschwarz/openrig#what-openrig-changes-on-your-machine)).

**If they want changes kept inside their project:** before setup or the first daemon/kernel start, name the selected
Codex config path (`CODEX_HOME/config.toml`, default `~/.codex/config.toml`) and explain the independent writes.
Setup adds `~/.tmux.conf`; Codex seat startup adds workspace trust and any declared config fragments, including MCP,
even when setup was skipped or `runtime.codex.hooks_enabled` is false. That setting controls hooks, not all config
writes. These settings can reach their other sessions using the same Codex home. Reuse a yes that already covered
these writes; an explicit project-only request doesn't cover them. If they decline, don't launch that same path or
remove the writes afterwards as a substitute for consent. Explain that setup has no project-only mode. A git worktree
or project `.codex/config.toml` doesn't redirect these writes.

**Keep their own login:** a team runs on the person's existing login through the home that holds it (`~/.codex` or
their `CODEX_HOME`; for Claude Code, `~/.claude` or their `CLAUDE_CONFIG_DIR`). Keeping that home and asking once about
these writes is how someone who wants changes kept in their project still gets a working team. Don't make a new
`CODEX_HOME` or `CLAUDE_CONFIG_DIR` to avoid the writes, inside the project or anywhere else: a new home has no login,
and the team can't start until someone signs it in. Never copy credentials into a new home or the project. A separate
home helps only if they already have one that is signed in; it keeps that home's config, login and sessions together
and doesn't relocate `~/.tmux.conf`. If they decline the writes and have no such home, say plainly that the team can't
start here without their yes to the writes or a sign-in they choose to do, and let them choose. Don't offer a route
that needs a new sign-in, or a large download such as a local model, without saying so first. Carry the person's scope
constraint to the operator.

**Codex individual approvals:** explain before installation that even reads may ask repeatedly during setup and
follow-up, separately from the team's permissions. Use plain, separate commands so each request is readable.
The one optional six-command approval offer below still applies; don't enable general network access or broaden
other permission settings to avoid prompts.

When you give the person a file or a command to run in their own terminal, use a path that exists on their side. A
file a sandboxed agent writes under `/tmp` may not exist in the person's terminal (seen with Codex), so put files the
person needs in their project or home folder and name that path.

## 1. Install OpenRig, if it isn't installed

- **Check first:** `rig --version`. If it prints a version, go to step 2.
- **What it needs:** macOS or Linux, Node.js 22 or 24, tmux, and Claude Code or Codex signed in. Check only what's
  missing: `node --version`, `tmux -V`, `claude auth status` or `codex login status`.
- **A check that needs the network** (`gh auth status`, a registry or other fetch) can fail falsely in a sandbox without
  network access, such as Codex's default one. Re-run that one command with network access before you tell the person
  to sign in again or fix anything.
- **Install:** `npm install -g @openrig/cli`, then `rig setup --providers codex` (or `claude`, or `both`: the harness
  the person uses). If the global install fails because npm's global prefix isn't writable (often a system Node with
  prefix `/usr`), first point npm's prefix at a folder the person owns whose `bin` is on their login PATH, for example
  `npm config set prefix ~/.local` when `~/.local/bin` is on it; say first that this changes their npm settings, and
  their shell profile if `~/.local/bin` isn't on the login PATH. If they use a Node version manager such as nvm,
  install with its Node instead; nvm refuses an npm `prefix` setting. Install inside the project only if neither is
  possible: Codex seats can then report `rig: command not found`. Setting and checking the login PATH: "Before you
  start" in https://github.com/mvschwarz/openrig/blob/main/docs/reference/getting-started.md#before-you-start. Setup
  checks Node, tmux and the logins. It installs tmux (with Homebrew, when present) or the chosen harness (with npm) if
  either is missing, installs Herdr for the OpenRig view unless they decline it (`--no-herdr`), and adds an OpenRig
  block to `~/.tmux.conf`, so say all of that first. It doesn't start the daemon. Then `rig doctor`. A login it reports
  missing isn't harmless: say which one, and that a team may need it (`starter` runs its reviewer on Codex). Pass it on
  in the handoff so the operator fits the team before anything starts.
- **Then go on to step 2:** say it's installed and ask what they want worked on, and in which repository. A plain
  "install OpenRig" includes this. Stop here only if they say not to start a team.
- **If something fails:** `rig context get help` is the help guide for the installed version. If `rig` itself won't
  run, use https://www.openrig.dev/help/agents. Getting started: https://openrig.dev/docs/getting-started

## 2. Open OpenRig and give its operator the goal

A seat's startup text points an installing agent here. [references/installing-for-someone.md](references/installing-for-someone.md)
adds what this step does not spell out (starting the daemon and kernel, what counts as ready and as finished) and relays the same
commands; if the two ever differ, this step is right.

- **Start OpenRig:** `rig daemon status`, and `rig daemon start` if it isn't running. `rig preflight` and `rig doctor`
  don't start it. Starting it also starts OpenRig's own team, the kernel, whose operator sets up the person's team.
  Keep it. If its output says no person is registered, make the offer it names before you go on, and register only on
  the person's yes ("Who answers OpenRig's questions" below).
- **If the person uses Codex:** now that OpenRig is running, make the one-time offer under "Codex: one offer, once,
  after OpenRig starts" at the end of this step.
- **Show them OpenRig, the handoff:** once OpenRig is running, open the OpenRig TUI and operator for the person. Say
  you're opening it, then run `rig terminal open saved:kernel --window` on the daemon's desktop. This is the next step
  after installing or starting OpenRig, and the way back whenever they want their agents or OpenRig again. Don't wait
  to be asked or for particular words. If they've said not now, give them that command for later. It opens a view
  itself, using herdr when installed or plain tmux otherwise:
  - **Inside Herdr** (you run in a Herdr pane): it switches the person's Herdr to an `openrig kernel` space, reusing a live
    one. No new window and no macOS prompt; their own spaces stay in the sidebar.
  - **Inside Rex** (you run in a Rex block, or in a tmux started in one): it opens an `openrig kernel` session on the same Rex server and asks the
    Rex app to switch to it. No new window and no macOS prompt. Opening it again adds a numbered session.
  - **In Terminal or Ghostty:** a new tab or window the size of theirs.
  - **From Claude Desktop, iTerm or VS Code on a Mac:** a new Ghostty window when supported, otherwise Terminal. Only
    here, tell the person before running it that **Allow is fine** if macOS asks to control that app.
    `echo $TERM_PROGRAM $__CFBundleIdentifier $REX_BLOCK` tells you where you run. `herdr`, `rex`, `Apple_Terminal` or
    `ghostty`, or `tmux` with `com.apple.Terminal`, `com.mitchellh.ghostty` or a `REX_BLOCK` value, mean no macOS
    prompt, so don't mention one. `tmux` with anything else (iTerm, VS Code) can prompt, so say Allow is fine first.
  - **Layout:** under 120 columns the operator fills the first page; from 120, the dashboard and operator share it. The
    advisor has its own tab or tmux window.

  Then tell the person in a sentence or two where it opened and that the operator is ready for what they want to
  build. Don't list agents or statuses (the TUI shows them), and don't suggest a command for them to type.
  Preserve the current terminal. If OpenRig's notes say it couldn't confirm the view, say so plainly. If it's already
  open, point them to it rather than opening another. Only if the window cannot open, `rig tui --shared` is the
  dashboard-only fallback; explain the failure and help with the chosen fallback. Herdr is visible only in a terminal
  the person can see; switching the shared TUI to `:terminals` does not open one. No and headless/SSH use are valid
  background outcomes. Provider-only `--provider herdr`, `--provider cmux` or `--provider rex` is for a provider that's
  already running, not the first desktop window. Each `cmux` or `rex` open adds a new workspace; `herdr` focuses one
  that still shows the view live, else adds one. `--provider herdr-app` opens
  the view in the herdr-app window you run it in (it adds OpenRig's mods there first). Inside a herdr-app
  terminal, plain `rig terminal open <view>` does the same when that window is answering. `--window` always asks for a
  new desktop window.
- **If the window can't open, or over headless SSH:** say plainly that no visible terminal was opened, and ask the
  person to open a new terminal window or tab on the daemon's host. Over SSH, that's a new SSH session to it with the
  known account. If you only know an HTTP daemon address, ask for the SSH details rather than inventing them. Then
  give them one complete command:
  - **The command OpenRig printed:** when `rig terminal open saved:kernel --window` can't open a window, it says why
    and ends with `run:` and a command (the `error` field with `--json`). That command already names the installed
    herdr binary and the daemon's socket, or the conversation to attach. Relay it exactly rather than composing one.
    If a note asks you to place the view once Herdr starts, run that `rig terminal open` yourself after they start it.
  - **If it printed no command:** find `operator.agent` in
    `rig ps --nodes --rig kernel --json --fields logicalId,canonicalSessionName,tmuxAttachCommand` and give
    `env -u TMUX` followed by its `tmuxAttachCommand`, exactly as listed (never a guessed name), for the operator's
    conversation. That command names the daemon's tmux server when it isn't the default one.

  For any other failure, the table under "What can interrupt installation and the OpenRig view" in
  `rig context get reference/getting-started.md#open-the-kernel-conversations` says why and what to do next.
- **Offer to join this session before the first send:** if this session hasn't already joined, recommend joining
  OpenRig in a plain shell so the operator sees a named teammate instead of "unknown sender". Inside tmux, offer
  joining as optional, with the effects below. Ask the person yes or no after this short explanation:
  - This adds me as a named member of the team, with my name on messages.
  - While the team works, I bring each seat's permission prompt to you here as a question and send your answer, so
    you don't need to open the seats' terminals. Joining puts my name on those answers.
  - In a plain shell, joining writes no files in your project or personal settings.
  - Inside tmux, my sender and reply address is `<member>@<rig>`, even when your tmux session is named `0`;
    `rig attach --self` returns it and `rig whoami` confirms it; `--display-name` does not change it.
  - Inside tmux, other agents can type into this window, and stopping the team (`rig down`) also closes this tmux
    session (both from source, not hand-tested). Transcript recording and, for Claude Code, writing
    `.openrig/context-collector.cjs` and `.claude/settings.local.json` for the status line were hand-tested on 0.6.11.
    Updating an existing `.claude/settings.local.json`, keeping its custom status line, is from source.
  - In a plain shell, other agents reply through the task queue because they can't type into this window, and
    stopping the team leaves this session running.

  Attach only on their yes; if they decline, continue the operator handoff. For this first contact, use the kernel's
  rig ID (the `rigId` of the `kernel` row in `rig ps --json`) and its `operator` pod:
  `rig attach --self --rig <rigId> --pod operator --member person-agent --runtime <claude-code|codex|omp> --print-env`.
  `--node <logicalId>` binds to an existing seat instead. Attach once, and keep the variables it prints
  (`OPENRIG_NODE_ID` and `OPENRIG_SESSION_NAME`). If it fails, don't retry with other names: continue unjoined, and
  hand over the goal with `--return-route auto` ("If the person stays with you" below), so the team's questions still
  come back here. Each command may run in a fresh shell, so put them in front of every later `rig` command. Check with
  `rig whoami --json`, and use it or `rig seat status` later for identity and state, not `rig attach --json` output.
  Don't print `OPENRIG_ACTIVITY_*` values: they're credentials.
  If they decline, a message that must still say who it's from can go as a queue item with a declared source,
  `rig queue create --source <their id>@external --destination <seat> --summary "<one line>" --body-file <file>`: the
  seat sees that name, recorded as declared, and can reply to them if they're registered (`rig gateway human list`).
  A declared name is a claim, not a seat's own identity: for a team that acts only on seat identity, the attached
  shell above is the route. For work whose questions and result must come back to this session, use a return
  address ("If the person stays with you" below), not a declared name.
- **Who answers OpenRig's questions:** read `rig gateway participants` (its `default:` line) before the handoff.
  - A default person is there: say requests and asks that name nobody go to them (a pairing request or an ask can
    name someone else), and don't offer again.
  - Several people with no default: ask which should get requests nobody is named for (`rig gateway default <id>`),
    or leave it. Never pick one yourself.
  - Nobody is registered: offer it in a sentence or two. Registering records them as the person for questions no agent
    is bringing them, such as a team seat's permission prompt or another machine asking to pair. Without a connector
    such as Slack, those reach them only in the TUI's Feed and Steering, so say so if they won't have the TUI open. If
    they stay with you, you bring them the team's questions and its result here either way ("If the person stays with
    you" below). Ask the name to use (their login name is only a suggestion). On yes, run
    `rig gateway human add <id> --display-name "<name>" --delivery-class B --default`: they're reached in the TUI's Feed
    and Steering, and Slack can be added later. On no or not now, register nothing and say that questions no agent
    brings them, such as pairing, can't reach them until someone is registered, with that command for later.
  - Never pass `--default` over an existing default, or `--replace`, unless they ask. Their own words decide: a
    different name, Slack now, or not now.
  - An agent reads their answers: the kernel operator, or the agent chosen in `agents.operator_session`. If the kernel
    isn't running here and no agent is chosen, offer to choose the team's lead (`rig config set agents.operator_session
    <seat>@<rig>`), on their yes only.
  - A machine they'll pair with needs its own person: registering here doesn't give that machine one.
- **Give the operator the goal:** ask what they want worked on, in which repository and on which branch, unless they've
  said. Hand it over by where the person will answer the team. Staying here is the default: the pane route needs their
  explicit choice.
  - **They stay here** (they said so, or they haven't chosen the pane): hand the goal over as a task with a return
    route ("If the person stays with you" below), giving the operator your return address for the team's questions and
    result. A seat's prompt may still not reach this conversation. Tell them in a line that this goal's route selects
    this conversation ahead of a Slack connection they've registered; their other work doesn't change, and they can
    talk to the operator in its pane instead whenever they like. Don't tell the operator they'll answer in its pane.
  - **They'll talk to the operator in its pane** (when they chose it): offer the pane only once the view opened where
    they can see it; check how `rig terminal open` ended, above, first. If they chose it and no view can open, give them
    the connection step above and keep their choice, and say the pane is pending until they open or attach to it.
    Find the `operator.agent` row in `rig ps --nodes --rig kernel --json`, take its `canonicalSessionName` (never the
    logical ID or a guessed name) and send:
    `rig send <canonicalSessionName> 'This is the agent that installed OpenRig. The person will answer in your pane. Goal: <goal>. Project folder: <absolute path>. Branch: <branch>.'`
    If no view opened, put this in place of its second sentence: "The person chose to answer in your pane; it is not open
    for them yet, so your questions wait there until they open or attach to it."
  - **Their choice holds:** a later goal goes by the route they chose until they say otherwise. Don't ask where they'll
    answer before the handoff, and don't switch routes on your own.

  Carry their constraints, which logins they have (an installed provider that isn't signed in doesn't count), and any
  permission choice they made, chosen or declined, in either handoff.
  Or the person types the goal and folder in the operator's pane. If they give you a goal later, forward it the same
  way, by the route they chose. The operator helps them pick a team that fits their logins, starts it (`rig up`) only on their yes to the plan it
  shows, and gives the goal to the team's lead. Before that yes, it says what launching into their folder changes for their own agent there; relay
  that with the question. Show them where the operator answers, and don't build the project yourself.
- **If you start a team yourself** instead of through the operator, do its fit check first. A built-in team can need a
  sign-in the person doesn't have: `starter` runs its reviewer on Codex, so someone on Claude Code alone stops at a Codex
  sign-in just when the review should start. `rig specs preview <team> --kind rig --json` lists each seat's runtime.
  Check those logins (`claude auth status`, `codex login status`), or go by what the person told you. If one is missing
  or you can't tell, say so before launching and let them choose: the operator adapts the team to the logins they have,
  or they sign in first.
- **If the person stays with you** (unless they declined the Codex offer below and explicitly chose the operator
  route), you're their front door to the team: you hand it the goal, bring its questions to them, its seats' permission
  prompts included, and bring back what it produced and what its latest review found, through the task queue rather
  than the operator's screen.
  - **Your return address:** if this session joined the team (above), it's the `OPENRIG_SESSION_NAME` that
    `rig attach` printed, and you hand over the goal with `--return-route self`. Otherwise OpenRig issues you one when
    you hand over the goal with `--return-route auto` (below): an address on the kernel's rig, such as
    `conversation-3f2a9c1b7e44@kernel`. It's an address the queue takes tasks for; nothing is launched for it and no
    file is written. If the person keeps more than one of these conversations, each hands over its own goal and gets its
    own address; one address shares its questions.
    To tell the team what it's for, the person can add it to a roster as a hosted member
    (`docs/reference/hosted-members.md` in the OpenRig package).
    Once you have it, put it in front of every other `rig queue` and `rig send` command:
    `OPENRIG_SESSION_NAME=<address> rig queue ...` or `OPENRIG_SESSION_NAME=<address> rig send ...` (add
    `OPENRIG_HOME=<home>` when OpenRig doesn't use the default home). Without it, a send reaches the seat from
    `<unknown sender>`. A `--source` name only labels the one task it's on: claiming and answering the team's questions
    need the address in `OPENRIG_SESSION_NAME`.
  - **Hand over the goal:** write it to a file with what the message above carries (that you're the agent that
    installed OpenRig and the person stays with you, the goal, folder, branch, constraints, logins and permission
    choices), and end it with this paragraph:

    > To ask me anything, create a queue item to my return address, this item's `returnRoute` (`rig queue show <this
    > id> --full` prints it): `rig queue create --destination <that address> ...`, then
    > block this item on that new item's id (`rig queue block <this id> --on <question id>`), so my answer wakes you. I
    > check it whenever the person talks to me. Don't ask in your own terminal: the person isn't there. A seat's
    > permission prompt in this work is their question too: send me its own text and choices, the seat, what it was
    > doing and any escalation's id, unless a question about that prompt is already open at my address. Whoever sent
    > the question passes on the answer, and no one else does. Capture that seat again first (a changed prompt needs a
    > new answer), then `rig send <seat> "<key>" --dangerously-interact --reason 'task <question id>: <their answer>'`
    > with the key the prompt shows for their choice (for Escape, `$'\e'` in place of `"<key>"`, never the word). Keep
    > the reason in single quotes so the shell runs nothing in their words, and write each `'` in them as `'\''`. A no
    > stays a no. If they gave no answer, or their words don't
    > clearly pick one choice (a condition the action doesn't plainly meet, say), ask me again before sending anything,
    > and never pick a "don't ask again" choice they didn't pick. Their answer covers only the prompt it answered: a
    > later prompt, even one like it, is a new question to me. Check the effect, and never send again while it's
    > unknown. To give this work to another seat, hand this item itself on (`rig queue handoff <this id> --to <seat>`), so
    > my return address goes with it, and don't close it as a duplicate of a new item. If you hand this item on or give
    > this work to another seat, copy this paragraph into the new item. When
    > you finish, put the outcome in this item's resolution, with what the latest review found, and any file in its
    > evidence ref.

    Then run
    `rig queue create --destination <canonicalSessionName> --return-route auto --summary "<the goal in a sentence>" --body-file <file> --verify`
    (if this session joined, `--return-route self` with your `OPENRIG_SESSION_NAME` in front). It prints
    `Return route: <address>`: that's your address from now on. The goal's handoffs carry it. Bring a seat's prompt in
    this work to this address as a task; it may still not reach you by itself, so check the seats when the person is
    waiting. Tell the person the task ID it prints, and keep the goal, your address and that ID: they're how you find
    this work again. If the outcome is unknown, repeat the same command with
    `--id` and the ID from its `Queue create request ID:` line, which it prints before it sends: the same task keeps the
    same address.
  - **Get woken when a task arrives at your address:** right after the handover, start this wait with your shell tool's
    background option (in Claude Code versions that wake you when a background command ends), with your address in place
    of `<address>`:

        until OPENRIG_SESSION_NAME='<address>' rig queue list --owned --state pending --json 2>/dev/null | grep -q '"qitemId"'; do sleep 20; done

    It runs only `rig` and `sleep`, so it spends no model tokens while it waits, and it reads the same in bash and zsh.
    When it ends, claim each pending task at once (claiming isn't answering: it stays open until the person answers),
    handle what's waiting (below), then start the wait again, so it ends only on new work. A harness with no background
    wake (Codex, for one) keeps the check whenever the person talks to you.
  - **When a question arrives at your address as a task,** list the pending work with
    `OPENRIG_SESSION_NAME=<address> rig queue list --owned --state pending,in-progress`. Read each in full
    (`rig queue show <id> --full`) and show the person the whole question in the team's words. Record only what they
    tell you, a condition included ("yes, but only on a branch"): claim it, then
    `OPENRIG_SESSION_NAME=<address> rig queue update <id> --state done --closure-reason no-follow-on --resolution '<their words>'`,
    keeping their words in single quotes and writing each `'` in them as `'\''`, so the shell runs and changes nothing in them.
    Add no label, quotation marks or notes of your own, and don't turn their words into a yes or a no: the agent that
    asked decides what they mean. You speak as yourself, never as the person. If they aren't there to answer, leave
    it open and tell them it's waiting; never answer for them.
    A question can be a seat's permission prompt that the operator or a team seat sent you: show it with the seat,
    the exact action and the choices it offers, and record their words the same way. The agent that sent it passes
    their answer to the seat, so don't send that prompt's answer yourself as well. A task from OpenRig itself
    (`daemon@kernel`: "<seat> is stopped at a prompt in the work you handed over") is a prompt no agent is relaying:
    capture the seat to show it, record their words on that task, and send their choice yourself, as its text says.
  - **A question only on the operator's screen:** if the operator asks in its pane and nothing reached your address,
    read it with `rig capture <canonicalSessionName>`, show the person, and send their words as a new task to the
    operator that names your task's ID, not as keys typed into its pane.
  - **Delivery isn't the task's state.** A task's state says where the work is: pending (created and readable, not
    yet claimed), claimed or in progress (an agent took it), handed off (follow the next item) or done (read its
    resolution). Whether its agent was woken is a separate fact, the wake outcome `--verify` reports: `verified` (it
    rendered in the seat's pane) or `claimed` (picked up); `delivered-ack-pending` (sent, render unconfirmed: not
    proof it was woken); `retained` (the seat's typing guard held the wake, the task is still there to read, and it
    isn't retried automatically: wake the task's destination once its input is free with
    `rig send <destination> "task <id> is yours"`); `failed` (the wake wasn't delivered, and the task still needs
    doing: wake it the same way); `indeterminate` or `still-pending` (unknown, neither failed nor delivered: check
    before you wake it again). A pending task with no wake isn't lost or done.
  - **Nothing wakes this chat** when the team asks or finishes: while its work is open, start each of your turns by
    listing your address's tasks (above), before anything else, including when the person talks to you and when they
    come back. A Claude Desktop scheduled task can pick the team's results up on a schedule, in a fresh session, not
    this chat. Offer it if they'd like that.
- **If the operator answers with a model error,** such as "… not supported when using Codex with a ChatGPT account", its
  Codex sign-in works but that account can't run the model. OpenRig put the operator on Codex because the sign-in
  passed. Tell the person which model failed. If Claude Code is signed in, offer to move the operator to it; on their
  yes, run
  `rig seat set-runtime <canonicalSessionName> --runtime claude-code --reason "<model> isn't available to this Codex account"`
  (`--dry-run` first). If it isn't, or you can't tell, say so and offer their choices: sign in to Claude Code, or give the
  seat a model their account can run with `rig seat set-model`, then start it again with
  `rig seat launch <seat> --fresh --stop --reason "…"` and check the model it reports. Either way the operator starts a
  new conversation without your handoff, so send it again: the goal, folder, branch, constraints and permission choices.
- **Installation is finished** when the operator is ready and the person is talking to it or, when they stay with you,
  once the goal has reached it as a task with your return route (read its wake outcome); a healthy daemon alone isn't
  that. If they'd rather talk later, keep that choice, leave them the exact connection step and say the handoff to the
  operator is still pending.
- **See what's running:** `rig ps`, then `rig ps --nodes --rig <rig>` for a team's agents. If a team is already
  running in that repository, tell the operator.
- **Check it's ready before you say so:** `rig ps --nodes --rig <rig>`. If an agent is stopped at a prompt or a menu,
  read it with `rig capture <seat>@<rig>`.
- **Bring seat permission prompts to the person here, as questions, for as long as the team works,** whether you or
  the operator started it, and whether or not they joined. This is your default responsibility, not a fallback. A permission prompt
  is the person's to answer: they decide, which doesn't mean they type it into the seat's pane, so don't decline to
  relay it. After each step you hand off, and before you report progress, first list your address's tasks
  (`OPENRIG_SESSION_NAME=<address> rig queue list --owned --state pending,in-progress`): a prompt OpenRig or the team
  already sent you is there as its own task, so answer it there. Then check `rig ps --nodes --rig <rig>` for a
  seat stopped at a prompt, and repeat both checks while you wait for a seat's result, so a prompt that appears after
  your last check still reaches them. Show the person each one, with any others waiting, one line each (seat,
  exact action, the choices offered), and the whole prompt when they ask. If a question about that prompt is already
  open at your address (the operator or a team seat sent it), use that one: record their words on it, and its sender
  passes them on, not you (on OpenRig's own task about it, you pass them on). Once you've recorded them, that prompt stays its sender's to answer even while the seat
  still shows it: don't ask about it again or send anything for it unless the prompt changes or the sender asks you
  again. For a commit, also say whether the team's review has run; they may be expecting one. Before sending their choice, capture that
  seat again: if its prompt changed, don't reuse the answer. Then send exactly the choice they made for that prompt:
  `rig send <seat>@<rig> "<key>" --dangerously-interact --reason 'task <id>: <their choice, in their words>'`, with
  the goal's task ID (leave out `task <id>:` when there's no task), where `<key>` is the digit or letter that capture
  shows for their choice, never their words: the text is typed as keys, and a letter can pick a menu's shortcut. Keep
  the reason in single quotes, so the shell runs nothing in their words and the record keeps them as they wrote them;
  write each `'` in them as `'\''`. If
  the screen shows no key for their choice, ask them. If they give no answer, or their words don't clearly pick one
  choice (a condition the action doesn't plainly meet, say), ask them again before sending anything; a no stays a
  no. When their choice is Escape,
  send the key itself, written with bash or zsh quoting:
  `rig send <seat>@<rig> $'\e' --dangerously-interact --reason 'task <id>: <their choice, in their words>'`. It's sent
  once, with no Enter added. Then capture the seat and check the effect before sending anything more; never send or
  resend an answer while its effect is unknown. Never answer a prompt on your own and record it as theirs,
  even one that only reads: ask them, and send their answer. **An answer covers exactly the prompt it answered:** "yes,
  this once" means that one prompt. Each later prompt goes back to them, even one that looks the same, only reads, or
  comes from the same seat or work, and never cite an earlier answer as their approval of a new prompt, in `--reason`
  or anywhere else. Never pick a "don't ask again" choice they didn't pick. If they've told you outright to decide a
  kind of future prompt (say, "approve prompts that only write inside my project"; "this once" never is one), you may
  decide each one: read its
  whole action, answer only when it's clearly inside what they said, and tell them you answered under that instruction,
  not that they said yes. Say the same in `--reason`: your call under their instruction, not their approval. Bring
  anything unclear or outside it back to them; a command's name or a path that looks like
  their project doesn't show what the action touches. Their instruction changes no permission setting.
  Don't send them to a bare `tmux attach` to answer: relay their choice this way, or point them to that seat in the
  team's terminals the operator opened. If they want fewer prompts, the operator offers once to allow the commands
  that keep asking, for their project only (`applying-a-permission-policy`); tell it what they chose.
  Trust and hook-review prompts are the person's to answer, as permission prompts are. Once you've sent their answer
  to a prompt a seat stopped at while starting, check `rig ps --nodes --rig <rig>` again: if it shows
  `Startup details (<seat>)` ending in `rig seat continue <seat>`, run that command: it delivers the seat's startup
  instructions in the same conversation.
  Another kind of menu you can answer with
  the key that screen shows, or ask the person. Capture it again before sending anything more.
- **Replies:** in a plain shell, other agents can't type into this session. Their questions and work for you arrive
  at your return address ("If the person stays with you" above). `rig capture <seat>@<rig>` shows what an agent is
  doing; it isn't how answers reach you.

### Codex: one offer, once, after OpenRig starts

First the agent resolves the person's real Codex folder (`CODEX_HOME`, or `~/.codex` when that isn't set) and puts the exact path in the
offer, so the person sees the real file, not a placeholder:

> Codex asks you to approve OpenRig commands. May I let six of them run without asking: `rig ps`, `rig capture`, `rig send`,
> `rig queue`, `rig status` and `rig whoami`, each with whatever follows it? They would run outside Codex's sandbox, in every Codex
> project and session you run on this computer, and `rig send` and `rig queue` can message your agents and change their task records, not
> only read them. I'd add one file, `/home/you/.codex/rules/openrig.rules` (the resolved path). Codex reads it when it starts, so it
> applies from your next Codex session; it won't remove prompts in this one. Keeping individual approvals means even status checks
> and reading an agent's screen may ask each time. You can also talk directly to the operator once it is ready,
> without changing this Codex session's permissions. To undo the rules, ask me to remove the OpenRig rules this added and keep your other rules.

- **No, or no answer:** write nothing and keep their sandbox, network and approval settings. If they decline, honor that choice;
  don't keep offering remembered approval or turn on general network access to avoid the prompts. Offer to continue directly with
  the ready operator, or stay here with individual approvals. If they already chose either route, don't ask again.
- **If they choose the operator:** use the handoff above once, carrying their goal, folder, branch and declined permission choices,
  then point them to its ready conversation. Over headless SSH, use the exact connection/attachment command above. Once they are
  talking to the operator, it follows the team's work and reports the result there; stop this installer's repeated capture/status/queue
  polling. Don't stop, restart or reconfigure either session. If they prefer to stay here, continue relaying with the approvals they chose;
  don't claim those prompts are gone. The rules offer is optional, not a condition of using OpenRig.
- **Yes:** the agent applies it the way OpenRig's existing permission steps already describe (`applying-a-permission-policy`, in the
  installed OpenRig skills): read the existing rules first, keep any stricter rule, change no sandbox or approval setting, and record what
  it added. The file is created only if it doesn't exist; if it does, the agent changes nothing and says what's there. A new file holds
  exactly these two lines:
  ```
  # Added by OpenRig on the person's yes: these six rig command families run without a prompt. Ask to undo, or delete this file if it holds nothing else.
  prefix_rule(pattern = ["rig", ["ps", "capture", "send", "queue", "status", "whoami"]], decision = "allow", justification = "OpenRig coordination commands the person approved once")
  ```
- **Undo** (the same skill's words: "Undo the OpenRig command allowances added by this setup; keep my other rules"): the agent removes
  only the lines it recorded adding, keeps anything else in the file, and deletes the file only if it still holds nothing but those lines.
  It applies from the next Codex session.

## 3. Follow the work to its result

Follow these steps by default. Only when the person declined the Codex offer above and explicitly chose the operator route does the operator own this follow-through.

- **Find the team's task:** if you gave the operator a task, start from it: when the operator hands it to the team's
  lead, `rig queue show <id> --json` lists the next item under `successors`. Otherwise, or if the operator started a
  new task for the lead (`dev-build@starter`, or `orch-lead` in `workshop` and `factory`; for starter and factory,
  `rig specs preview <name> --kind rig` says what each seat does; for a running team, `rig ps --nodes --rig <rig>`),
  find it with `rig queue list --destination <seat>@<rig> -a`.
- **Follow it to the result:** a task that changed hands isn't finished. `rig queue show <id> --full` names the seat it
  went to, and that seat's next task is the one whose `handedOffFrom` is that ID
  (`rig queue list --destination <seat>@<rig> -a -o json`). Follow each handoff until an agent reports the result,
  and report what the record says; `rig capture <seat>@<rig>` only shows what an agent is doing right now. Then read
  what it produced and tell the person what the team actually did (the branch, commit, review or PR text), not just
  that you sent it.
- **Read the latest review before you say it's done:** find the newest review of that work on the chain and tell the
  person its outcome. Work a review sent back with something to fix isn't done, even if a commit exists: say what
  the review asked for, and follow the work until a later review clears it or the person decides.
- **Give the team more work:** write the goal to a file: what to change, in which repository and branch, what done
  looks like, and that the result comes back to you (the branch or commit, the review, any PR text), ending with the
  reply paragraph above. Then
  `OPENRIG_SESSION_NAME=<address> rig queue create --destination <seat>@<rig> --return-route self --summary "<the goal in a sentence>" --body-file <file> --verify`.
  Each goal carries its own route: without `--return-route self`, its seats' prompts don't come to you, and the
  `returnRoute` the reply paragraph points the team to is empty.
  A message informs, and a queue task is the work someone owns. Read its wake outcome as above before you send
  anything else.
- **Then ask what's next.** If no team can take the work, fix that or ask the person. Don't quietly do it yourself.
- **Coming back later:** in a new session, use the same return address and the task IDs you gave the person. Read
  each with `rig queue show <id> --json` and follow its `successors` to the newest item, as above. A task handed to
  another host has no `successors` here: its `successorNote` names the successor as `<id>@<host>`, so read it there
  with `rig queue show <id> --host <host> --json`.
  `OPENRIG_SESSION_NAME=<address> rig queue list --mine -a` lists everything this address sent or owns, finished work
  included (without `-a` it shows only open items). It returns at most 100 rows unless you pass `--limit`, so on a busy
  address keep the task IDs you created, or raise `--limit`. Follow that work rather than creating it again.
  Adding OpenRig's MCP plugin to this app later starts a new session; it doesn't carry this conversation over.
- **Other ways to work with the team:** `rig send <seat>@<rig> "..."` types into an agent's terminal,
  `rig capture <seat>@<rig>` reads its screen, and `rig ps --nodes --rig <rig>` shows who's on it.

## 4. Find out more

- **How OpenRig works:** `rig context profile world-public --situation fresh`.
- **What you can do:** `rig context get onboarding-width` (the capability map).
- **Everything in the library:** `rig context list`.
- **Exact syntax:** `rig <command> --help` is always current for the installed version.

When something here and `rig <command> --help` disagree, `--help` wins.
