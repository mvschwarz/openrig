# Environment Specifics

## Current PATH

```bash
/opt/homebrew/opt/node@22/bin
/opt/homebrew/opt/mysql-client/bin
/opt/homebrew/bin
/opt/homebrew/sbin
/usr/local/bin
/usr/bin
/bin
/usr/sbin
/sbin
~/.nvm/versions/node/v22.12.0/bin
```

## Shell Configuration (~/.zshrc)

```bash
# NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# MySQL Client
export PATH="/opt/homebrew/opt/mysql-client/bin:$PATH"

# WeasyPrint Dependencies
export DYLD_LIBRARY_PATH="/opt/homebrew/lib:$DYLD_LIBRARY_PATH"
export PKG_CONFIG_PATH="/opt/homebrew/lib/pkgconfig:/opt/homebrew/opt/libffi/lib/pkgconfig:$PKG_CONFIG_PATH"
export LDFLAGS="-L/opt/homebrew/opt/libffi/lib"
export CPPFLAGS="-I/opt/homebrew/opt/libffi/include"

# Node 22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

## Installed Versions

```bash
# Python (Homebrew)
python3 --version     # Python 3.13.7 (default)
python3.14 --version  # Python 3.14.0
python3.13 --version  # Python 3.13.7
python3.11 --version  # Python 3.11.13

# Python (UV-managed: ~/.local/share/uv/python/)
# 3.12.11 - Used by `uv run` default
# 3.11.4 - Older managed version

# Other tools
uv --version       # uv 0.8.11
node --version     # v22.12.0 (default)
nvm ls             # v16.x, v18.x, v22.12.0
npm --version      # 10.9.0
brew --version     # Homebrew 4.6.18
docker --version   # Docker 28.3.2
git --version      # git 2.39.5
```

## Python Version Behavior

**Discovery Order:**
1. `python3` command → Follows PATH → `/opt/homebrew/bin/python3` (3.13.7)
2. `uv run` → Checks UV-managed first → `~/.local/share/uv/python/` (3.12.11)
3. `uv venv` → Follows system python3 → 3.13.7

**Key Insight:** UV prioritizes its managed Pythons over system Pythons. This divergence is normal and safe:
- Venvs are immutable (locked to creation Python)
- Production projects use venvs (unaffected by UV's default)
- Use `uv run --python 3.13` for explicit control

**Python Locations:**
- Homebrew: `/opt/homebrew/bin/python3.X` → `/opt/homebrew/Cellar/python@3.X/`
- UV-managed: `~/.local/share/uv/python/cpython-3.X.Y-macos-aarch64-none/`
- System: `/usr/bin/python3` (macOS built-in, 3.9.6)

## Homebrew Packages (Selected)

```bash
brew list | grep -E "python|node|docker|aws|tailscale|postgresql"
# python@3.11
# python@3.13 (linked as python3)
# python@3.14
# node@22
# nvm (via shell function)
# docker
# aws-cli
# tailscale
# postgresql@16 (client)
```

## Configuration File Locations

- Shell: `~/.zshrc`
- Git: `~/.gitconfig`
- Claude Code: `~/.claude/CLAUDE.md`
- Warp: `~/.warp/launch_configurations/`
- SSH: `~/.ssh/`
- AWS: `~/.aws/config`
