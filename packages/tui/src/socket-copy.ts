// The control-socket status row carries a copy action, and its click has to be recognised before the
// startup, palette and restore screens see it: those handlers consume a status-row click and would
// take the operator somewhere else instead of copying the path.
//
// The recognition is one comparison, kept here rather than inline so it can be tested without a live
// TUI. It compares the action's value with the path the TUI actually bound, which is why the row hands
// over the bound path rather than a cleaned one: cleaning the value would make this false whenever the
// cleaning changed anything, and the click would fall through to the screen underneath.

/** Whether this hit is the bound control socket's own copy action. */
export function isBoundSocketCopy(
  action: { type: string; value?: string } | undefined,
  boundSocketPath: string,
): boolean {
  return action?.type === "print-for-copy" && action.value === boundSocketPath;
}