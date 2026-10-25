# Codex first-login fixtures

`codex-first-login.txt` and `codex-api-key-login.txt` are unedited tmux captures at 120 columns by 40 rows from the official Codex CLI 0.164.0 Linux binary. `codex-first-login-80x24.txt` captures the same chooser at 80 columns by 24 rows. The capture ran in a fresh container with no credentials or host configuration, with networking disabled. The API-key screen was opened from the initial chooser; no key was entered and no model request was made.

Binary: [codex-x86_64-unknown-linux-musl.tar.gz](https://github.com/openai/codex/releases/download/rust-v0.164.0/codex-x86_64-unknown-linux-musl.tar.gz), SHA-256 `90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4`.

The three `*-no-daemon*.txt` captures also pass `--no-daemon --no-alt-screen`. They retain Codex's earlier banner and empty composer above the newer sign-in panel. A current login panel must win over that older composer, while a newer usable composer below a dismissed panel must not be blocked.

The regression exercises these captured screens through the shared readiness probe, the Codex adapter, and startup persistence/inventory. Modified copies cover another highlighted choice, quoted or incomplete panels, and a newer conversation or native menu. Those variations are synthetic, not additional native captures.
