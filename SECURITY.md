# Security policy

## Supported versions

Only the latest published version on npm (`@openrig/cli`) is supported. Fixes are developed on
`main` and released after verification; a merged fix is not necessarily in the published package.
Include the affected version even when reporting a problem in an older installation.

## What OpenRig touches

OpenRig runs a local daemon, drives coding agents in tmux sessions on your machine, and writes
configuration for those harnesses (for example under `~/.claude` and `~/.codex`). The README
section [What OpenRig changes on your machine](README.md#what-openrig-changes-on-your-machine)
describes these effects and the trust/permission choices. Unexpected access, disclosure or
permission changes are useful reports; include what you expected and what you observed.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Open the repository's [Security page](https://github.com/mvschwarz/openrig/security). If
**Report a vulnerability** is available, use it to send a private report to the maintainers.
The reporter and authorized advisory collaborators can also see that report; it is not public.
Availability depends on the repository setting, not on this file being present.

If that option is unavailable, ask in [Discussions Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a)
for a private security contact. Post only the request for a channel: do not include the
vulnerability details, reproduction, logs, credentials or affected private systems in public.
Wait for the private channel before sharing the report.

Include: the OpenRig version, the harnesses involved, the steps to reproduce, and what an attacker
could do. A proof of concept is welcome; a working exploit against a third party's machine is not.

## What to expect

- We will acknowledge the report and coordinate assessment and next steps privately.
- Assessment and fix timing depend on impact and reproduction; no fixed deadline is promised.
- We will agree on disclosure and credit with you. You can ask to remain anonymous.

## Scope notes

- OpenRig assumes the machine and the accounts it runs under are trusted by their owner. Reports
  that require a hostile local user with the same account are still welcome but are unlikely to be
  treated as high severity.
- A harness carrying out an intentionally authorized operation is not by itself evidence of an
  OpenRig vulnerability. Reports of OpenRig bypassing a chosen permission, changing trust
  unexpectedly, or routing data or actions to the wrong destination are in scope.
