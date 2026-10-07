#!/bin/sh
# Opt-in wrapper over the manual install commands. Also accepts a download piped
# to sh; define the complete program before starting any child commands.

install_failed() {
  install_exit=$1
  shift
  printf '\nFAILED %s (exit %s). See the command output above.\n' "$*" "$install_exit" >&2
  exit "$install_exit"
}

install_step() {
  install_label=$1
  shift
  printf '\n[%s] %s\n' "$install_label" "$*"
  # Keep native output and the actual status; a formatting pipe would lose it.
  if "$@"; then
    return 0
  else
    install_failed "$?" "[$install_label] $*"
  fi
}

install_main() {
  case "$#:$1" in
    0:|1:--dry-run) ;;
    1:--help|1:-h)
      printf '%s\n' 'Usage: sh install.sh [--dry-run]' 'For a piped preview: ... | sh -s -- --dry-run'
      return 0 ;;
    *) printf '%s\n' 'Usage: sh install.sh [--dry-run]' >&2; return 2 ;;
  esac

  printf '%s\n' \
    'OpenRig install plan (macOS or Linux):' \
    '  [1/4] Check node and npm on PATH; print their versions.' \
    '  [2/4] npm install -g @openrig/cli' \
    '        Installs the published CLI and dependencies into your npm global prefix.' \
    '        npm prefix -g locates that installation; its bin/rig is used below.' \
    '        Run node "$(npm root -g)/@openrig/cli/scripts/check-abi.mjs" if present.' \
    '        Check Node/SQLite explicitly even if npm skipped postinstall; report if unavailable.' \
    '  [3/4] rig setup --dry-run' \
    "        Show the installed version's setup plan without applying it." \
    '  [4/4] rig setup' \
    '        Checks both Claude Code and Codex; may install missing tools.' \
    '        Checks tmux, writes its defaults, and on macOS may install/configure cmux.' \
    '        On macOS, setup may start cmux while configuring its control.' \
    'This broader setup is optional for the manual selected-provider path.' \
    'The wrapper does not log in, choose a permission policy, launch a team or open a kernel conversation.' \
    'Node advice: Node.js 22 or 24 with npm; use 22 on Apple silicon.' \
    'Distribution packages can be older; check node --version.' \
    'Use the official Node installer, or the Linux route (NodeSource or nvm):' \
    'https://github.com/mvschwarz/openrig/blob/main/docs/reference/getting-started.md' \
    'The installed package checker owns compatibility checks: below 22 and odd majors' \
    'are rejected; later even majors warn as untested. No automatic Node or permission repair.'

  if [ "$1" = '--dry-run' ]; then
    printf '\n%s\n' 'Dry run: no commands executed or changes made.'
    return 0
  fi
  for install_tool in node npm; do
    if ! command -v "$install_tool" >/dev/null 2>&1; then
      printf 'Missing prerequisite: %s. Install Node.js 22 or 24 with npm, then retry.\nDistribution packages can be older; check node --version.\nUse the official Node installer, or the Linux route (NodeSource or nvm):\nhttps://github.com/mvschwarz/openrig/blob/main/docs/reference/getting-started.md\n' "$install_tool" >&2
      install_failed 127 '[1/4] prerequisite check'
    fi
  done
  install_step 1/4 node --version
  install_step 1/4 npm --version
  install_step 2/4 npm install -g @openrig/cli
  if install_prefix=$(npm prefix -g); then :; else
    install_failed "$?" '[2/4] npm prefix -g'
  fi
  install_rig="$install_prefix/bin/rig"
  if [ ! -x "$install_rig" ]; then
    printf 'Installed rig is not executable: %s\n' "$install_rig" >&2
    install_failed 127 '[2/4] locate installed rig'
  fi
  PATH="$install_prefix/bin:$PATH"
  export PATH
  if install_modules=$(npm root -g); then :; else
    install_failed "$?" '[2/4] npm root -g'
  fi
  install_checker="$install_modules/@openrig/cli/scripts/check-abi.mjs"
  if [ -f "$install_checker" ]; then
    install_step 2/4 node "$install_checker"
    printf '\n%s\n' 'Node/SQLite compatibility check passed.'
  else
    printf '\nNode/SQLite compatibility check SKIPPED: installed checker not found at %s\n' "$install_checker" >&2
  fi
  install_step 3/4 "$install_rig" setup --dry-run
  install_step 4/4 "$install_rig" setup
  printf '\n%s\n' 'Follow the next steps printed by rig setup: start the daemon, open the OpenRig view, then tell the operator what you want to build.'
}

# Setup prints policy guidance, not an input prompt. EOF keeps children from
# consuming the rest of a streamed script; no implicit answer is supplied.
install_main "$@" </dev/null
