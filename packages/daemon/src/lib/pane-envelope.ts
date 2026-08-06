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

/** Send/broadcast header envelope metadata (ruling 03c35295). The ENVELOPE carries the machine truth;
 *  the rendered header is a PROJECTION of it. Both twins (this + cli wrapSendBody) share this shape. */
export interface EnvelopeScope {
  /** dm = a single recipient; multi = a named recipient set; rig-broadcast/topology = scaled broadcasts. */
  kind: "dm" | "multi" | "rig-broadcast" | "topology";
  /** multi: the full recipient list (WHO got it). */
  recipients?: string[];
  /** rig-broadcast: the rig + seat count (the anti-storm scale). */
  rig?: string;
  seats?: number;
}
export interface EnvelopeMeta {
  /** ISO-8601, stamped ONCE at the transport layer at send-time. Render READS it; never re-derives
   *  (the 51-02 wall-clock-in-projection forbids computing it at read). */
  stampISO?: string;
  scope?: EnvelopeScope;
}

/** The To-line projection + anti-storm scale (header-alone distinguishability, ruling pin 2). */
export function renderToLine(recipient: string, scope?: EnvelopeScope): string {
  if (!scope || scope.kind === "dm") return `To: ${recipient}`;
  if (scope.kind === "multi") return `To: ${(scope.recipients ?? [recipient]).join(", ")}`;
  if (scope.kind === "rig-broadcast") return `To: broadcast to ${scope.rig} (${scope.seats} seats)`;
  return "To: broadcast to topology";
}

/** Short glanceable stamp MM-DD HH:MMZ (12 chars) from the transport ISO (ruling pin 3). */
export function renderShortStamp(stampISO: string): string {
  return `${stampISO.slice(5, 7)}-${stampISO.slice(8, 10)} ${stampISO.slice(11, 16)}Z`;
}

/** Wrap a tmux-pane body with the canonical From/To envelope. The
 *  recipient pane sees both the sender's identity and a reply hint.
 *  Cross-host nudges should NOT double-wrap: the remote rig wraps
 *  when it processes the same command (matches `wrapSendBody`'s
 *  cross-host carve-out).
 *  `meta` (ruling 03c35295) projects the recipient scale + a transport-stamped timestamp; ABSENT ⇒
 *  today's exact DM envelope (backward-compat until every sender surface threads it). */
export function wrapPaneEnvelope(
  sender: string | undefined,
  recipient: string,
  body: string,
  selfHostId?: string | null,
  meta?: EnvelopeMeta,
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
  const header = [`From: ${senderTriple}`, renderToLine(recipient, meta?.scope)];
  if (meta?.stampISO) header.push(`Sent: ${renderShortStamp(meta.stampISO)}`);
  return [...header, "---", body, "---", `↩ Reply: rig send ${senderTriple} "..."`].join("\n");
}
