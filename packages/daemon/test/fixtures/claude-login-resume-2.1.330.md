# Claude Code 2.1.330 resumed to its login refusal

Captured from the official Claude Code 2.1.330 on Linux, in tmux 3.4 (`capture-pane -p`), with no credentials of any kind in the
environment or the home folder. The home folder held only the state OpenRig's managed launch writes (`.claude.json` with
`hasCompletedOnboarding` and the working folder's trust accepted), as on a seat that was set up and never signed in.

How each screen came about:
1. `claude --session-id <id>` started a new conversation. The capture typed `hello`, and Claude answered it with its login
   refusal (`⎿  Not logged in · Please run /login`), which saved the conversation.
2. Claude was closed, and `claude --resume <id>` brought the conversation back.

- `claude-login-resume-2.1.330.txt`, 200×50: the conversation the resume brought back. Its latest reply is the refusal, under an empty
  input box and Claude's `Not logged in · run /login` footer.
- `claude-login-resume-2.1.330-80x24.txt`, 80×24: the same screen at a narrow width. Claude was closed with Ctrl-C twice, which
  saves no turn.
- `claude-login-resume-later-turn-2.1.330-80x24.txt`, 80×24: a control, where Claude was closed with `/exit`, which Claude saved as a
  later turn (`⎿  Bye!`). The refusal isn't the latest reply there, so it isn't a current login refusal.

Each screen stayed the same for at least 10 seconds after it was drawn.

Edited after capture: the shell prompt and the working folder were replaced with `user@host:~/project` and `/home/user/project`. In the
80-column captures, the launch line had wrapped only because of the longer original prompt, so it's one line here. Nothing else changed.
