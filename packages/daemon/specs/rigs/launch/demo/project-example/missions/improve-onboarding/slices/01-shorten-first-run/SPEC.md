---
id: demo.improve-onboarding.01
slice: 01-shorten-first-run
mission: improve-onboarding
intent: >-
  EXAMPLE — The getting-started path launches a working rig with one command
  and shows the user their first agent inside two minutes.
status: example
stage: wip
created: 2026-08-23
---

# Slice: 01-shorten-first-run (worked example)

## Intent

One command to a running rig; first visible agent within two minutes. (The
slice is the ONLY altitude that specifies — these exact section headings are
what the UI projects on.)

## Mini-requirements

1. `rig up demo` succeeds on a machine that has only run the installer.
2. The attach hint lands the user in a seat that greets them.

## Proof contract

- [ ] A timed transcript of the first run on a clean machine, under two
      minutes from command to visible agent. (Each promise pairs with an
      observable artifact — the one check that reliably goes unmade is "did
      it actually work.")
