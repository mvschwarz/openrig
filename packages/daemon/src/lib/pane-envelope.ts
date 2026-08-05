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
  selfHostId?: string | null,
): string {
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  // 51-09 increment 3 (ruling cb19867f Q2 always-suffix + 2e1b737f C1 fail-open):
  // when the origin's boot-reconciled self-host id is known, the sender renders
  // as the <member>@<rig>@<selfHostId> triple ALWAYS (local included) so the
  // signature is self-describing and the reply hint is verbatim-usable. When it
  // is absent (daemon pre-reconcile / unknown sender), fall open to today's exact
  // two-part form — no new failure mode. A sender that ALREADY carries a host (a
  // --from relay passing the ORIGIN's full triple) is preserved verbatim, never
  // re-stamped with THIS host's id (which would forge the origin).
  const senderTriple =
    selfHostId && selfHostId.length > 0 && senderLabel !== SENDER_FALLBACK && senderLabel.split("@").length < 3
      ? `${senderLabel}@${selfHostId}`
      : senderLabel;
  return [
    `From: ${senderTriple}`,
    `To: ${recipient}`,
    "---",
    body,
    "---",
    `↩ Reply: rig send ${senderTriple} "..."`,
  ].join("\n");
}
