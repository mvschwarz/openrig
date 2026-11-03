// #2044 — a Claude member's own plugin channels (spec `plugin_channels`). Claude Code's `--channels` registers the
// session for channel notifications (inbound push) from the MCP servers it names; Claude 2.1.316 hides the option from
// `claude --help`. OpenRig passes only plugin entries, `plugin:<name>@<marketplace>`, as one `--channels` followed by the
// entries. The option takes every following value up to the next option, so each launch puts OpenRig's identity options
// after it. One rule for the spec, the seat's additions record and identity proof.

/** A plugin channel entry as OpenRig passes it: a plain plugin name and marketplace name. Claude refuses to start on an
 *  entry that isn't `plugin:<name>@<marketplace>` or `server:<name>`, and `server:` entries aren't supported here. */
const CLAUDE_PLUGIN_CHANNEL = /^plugin:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isClaudePluginChannel(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_PLUGIN_CHANNEL.test(value);
}
