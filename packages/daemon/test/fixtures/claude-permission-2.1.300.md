# Claude permission menu transcript excerpts

Captured on 2026-10-17 from the real Claude Code 2.1.300 Windows executable
in an isolated scratch project, in default permission mode, with hooks disabled
and an empty strict MCP configuration. The user's existing provider configuration
selected `deepseek-flash`; these are native Claude Code permission menus, not model
output or an OpenRig daemon end-to-end test.

The JSON contains menu excerpts transcribed from ConPTY's incremental ANSI output:
cursor movements and decorative separators are removed, whitespace is normalized,
and the machine-specific project path is replaced with `<project>`. These are not
raw full-screen tmux captures. The ASCII `>` selector is preserved, not replaced
with the macOS/Linux composer glyph to make a test pass.

- Bash: requested one `printf` redirect into `bash-output.txt`; selected one-time Yes.
- Edit: read `seed.txt`, requested a one-line replacement; selected one-time Yes.
- WebFetch: requested only `https://example.com`; selected No.
- `approvedBash` is the running tool after approval, not an idle inference.
- `deniedWebFetch` is the resulting interrupted screen. Its Windows composer is
  intentionally unrecognized by the existing parser; the probe remains unknown.

The tests exercise the existing permission patterns against the three native
question shapes. Separate service/route tests control pane results to test the
seen-first latch, races, and clear propagation. They do not prove native tmux
timing or every Claude release's rendering.
