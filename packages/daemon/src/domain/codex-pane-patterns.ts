// Codex's live turn-status row: a bullet, a header ("Working", or the reasoning summary Codex shows in its place),
// then the elapsed time and "esc to interrupt" in parentheses, e.g. "• Working (1h 09m 39s • esc to interrupt)".
// Completed output that merely says "Working directory: …" or "Working tree is clean." never matches.
export const CODEX_TURN_STATUS_PATTERN = /^[•◦]\s+\S.*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)/;
