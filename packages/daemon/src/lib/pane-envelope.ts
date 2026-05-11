// V0.3.1 slice 23 founder-walk-queue-handoff-envelope.
//
// Daemon-side renderer for the email-style envelope the recipient's
// tmux pane shows when a peer sends them a message (`rig send`) or
// when a queue handoff/create nudges them. Wrapping the body with
// From / To / --- / body / --- / ↩ Reply gives both a sender
// identity and a copy-pasteable reply hint.
//
// PARITY CONTRACT with CLI:
// `packages/cli/src/commands/send.ts :: wrapSendBody` must produce
// BYTE-IDENTICAL output for the same inputs. The two implementations
// live in separate packages because cli + daemon don't cross-import
// today; the contract is enforced via:
//   1. Identical function body (visual diff)
//   2. `packages/daemon/test/pane-envelope.test.ts` mirroring the
//      assertions in `packages/cli/test/send-header.test.ts`
//   3. Live integration parity (HG-5): a queue handoff nudge and a
//      rig send to the same destination render byte-identical
//      output except for the body content
// If you update this function, update wrapSendBody in lockstep.

const SENDER_FALLBACK = "<unknown sender>";

/** Wrap a tmux-pane body with the canonical From/To envelope. The
 *  recipient pane sees both the sender's identity and a reply hint.
 *  Cross-host nudges should NOT double-wrap: the remote rig wraps
 *  when it processes the same command (matches `wrapSendBody`'s
 *  cross-host carve-out). */
export function wrapPaneEnvelope(
  sender: string | undefined,
  recipient: string,
  body: string,
): string {
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  return [
    `From: ${senderLabel}`,
    `To: ${recipient}`,
    "---",
    body,
    "---",
    `↩ Reply: rig send ${senderLabel} "..."`,
  ].join("\n");
}
