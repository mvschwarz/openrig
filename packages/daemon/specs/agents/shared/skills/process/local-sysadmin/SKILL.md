---
name: local-sysadmin
description: System administration for Mac Mini development environment. Prevents installation mistakes and environment pollution. Use when installing tools, troubleshooting "command not found" errors, or determining correct installation method. Knows actual environment (Python 3.11/3.13/3.14, UV, nvm, directory structure) and installation preferences (UV for one-offs, venv for projects, never global pip).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: host-specific
    source_evidence: |
      Graduated 2026-05-04 from openrig-work/skills/workspace/from-home-skills/local-sysadmin/. HOST-SPECIFIC distribution scope — for the kernel rig's sysadmin agent on this host. Documents the actual Mac Mini development environment (Python 3.11/3.13/3.14, UV, nvm, directory structure) and installation preferences (UV for one-offs, venv for projects, never global pip). Pattern C with scripts/ + references/. Forms basis of N_specialist-roles cluster (currently a single-skill cluster; will grow as more host-specific specialist rigs come online).
    pattern: "Pattern C (bundled with scripts/ + references/ — environment_specifics.md, project_patterns.md, sysadmin scripts)"
    transfer_test: pending
---

# Local System Administrator

## Overview

Prevent installation mistakes and environment pollution. Knows your actual Mac Mini configuration and installation preferences.

## When to Use

- Installing new tools or libraries
- "Command not found" errors
- "Where should I install X?"
- "Which package manager should I use?"
- Troubleshooting PATH issues

## Environment Snapshot

**Installed Tools:**
- Python: 3.11.13, 3.13.7 (default), 3.14.0 (Homebrew) + 3.12.11 (UV-managed)
- UV 0.8.11 (Homebrew)
- Node.js: v16, v18, v22 (nvm)
- Homebrew 4.6.18
- Docker 28.3.2
- Shell: zsh, M2 Mac (arm64)

**Shell Configuration:** `~/.zshrc`
- NVM configured
- WeasyPrint library paths (DYLD_LIBRARY_PATH, PKG_CONFIG_PATH)
- MySQL client in PATH
- No aliases defined yet

**Directory Structure:**
```
~/code/
├── infra/             # Self-managed global functionality
│   ├── services/      # Long-running servers (MCP, databases)
│   └── tools/         # Run-once utilities (scripts, CLIs)
├── omt/example-app-1/          # BigBlueCloud (8 repos)
├── lab/               # Experiments, POCs
├── projects/          # Personal/client work
└── workflow/
    └── _dev/          # Global knowledge base (git-tracked)
        ├── docs/      # Cross-project docs (ai/, infra/, process/)
        ├── workspace/ # Per-project docs (example-app-1/, srw/, agilitas/, template/)
        ├── agents/    # Agent configs
        ├── scripts/   # Utility scripts
        └── skills/    # Claude skills
```

## Installation Preferences

**Python:**
- ✅ One-off/learning: `uv run --with <pkg> python3 script.py`
- ✅ Project dependencies: venv (`python3 -m venv venv`)
- ✅ Global CLI tools: `pipx install <tool>`
- ❌ NEVER: `sudo pip install` or global `pip install`

**Node.js:**
- ✅ Use nvm: `nvm use 16` or `nvm use 18`
- ✅ Project deps: `npm install` (local)
- ⚠️ Sparingly: `npm install -g` (global CLI tools only)

**System Tools:**
- ✅ Use Homebrew: `brew install <tool>`

**M2 Mac Compatibility:**
- Node.js 18 with old deps: `NODE_OPTIONS=--openssl-legacy-provider`

## Quick Decisions

**"I want to try pandas"**
→ `uv run --with pandas python3`

**"I'm building a Python project"**
→ `python3 -m venv venv && source venv/bin/activate && pip install pandas`

**"I need black formatter globally"**
→ `pipx install black`

**"I want to install Docker"**
→ `brew install docker`

**"Where do I install an MCP server?"**
→ `~/code/infra/services/mcp-server-name`

**"Where do I put a custom CLI tool?"**
→ `~/code/infra/tools/my-tool` (source code) or `pipx install` (Python CLI)

**"Where do I create a new experiment?"**
→ `~/code/lab/my-experiment`

**"Where do I put project documentation?"**
→ `~/code/workflow/_dev/workspace/<project>/`

## Troubleshooting

**"Command not found"**
1. Check: `which <command>`, `brew list | grep <tool>`
2. Reload: `source ~/.zshrc` or `exec zsh`
3. Verify PATH: `echo $PATH`

**"Wrong Python version"**
- System: `python3` → 3.13.7, `python3.14` → 3.14.0, `python3.11` → 3.11.13
- UV: `uv run` uses 3.12.11 (UV-managed), `uv venv` uses system python3
- Venvs lock to creation Python (immutable)
- Check: `which python3` → should be `/opt/homebrew/bin/python3`
- If in venv: `deactivate`, verify system Python, recreate venv

**"Wrong Node version"**
- Check: `node -v`, `nvm current`
- Switch: `nvm use 16` or `nvm use 18`

## References

Load these only when needed for detailed information:

- `references/environment_specifics.md` - Full PATH, detailed shell config
- `references/project_patterns.md` - Workspace structure, documentation patterns

---

**For workflow optimization, automation, and productivity improvements, use the `workflow-optimizer` skill instead.**
