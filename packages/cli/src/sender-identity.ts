import { readOpenRigEnv } from "./openrig-compat.js";

/**
 * The seat identity a CLI dispatch is attributed to — the SAME value the
 * DaemonClient stamps as `X-OpenRig-Session` (the P18 chokepoint), from which
 * the daemon DERIVES the actor / rendered `From:`. `--from` is deprecated and
 * ignored: origin is the seat env, never a caller-supplied body claim.
 */
export function resolveSenderSession(): string | undefined {
  return readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
}

/**
 * A1 REFUSE-LOUD (identity/audit family). The CLI channel of record records only
 * a DERIVED sender. An unattributable dispatch — no resolvable seat identity —
 * must REFUSE at the seat boundary rather than render a fallback marker.
 *
 * This is the CLI-side twin of the shipped daemon precedent
 * (`routes/transport.ts` → `401 unattributable_sender`, P21-I4): both surfaces
 * teach the same lesson — *the sender derives from an authenticated context,
 * never a request-body claim*. Refusing HERE (before dispatch) means the CLI can
 * never put an unattributable marker on the wire, which is why the CLI-side
 * `<unknown sender>` fallbacks are DELETED rather than centralized: the seat
 * boundary makes them unreachable by construction.
 *
 * Returns the resolved seat identity, or `null` AFTER printing the named error
 * and setting a non-zero exit code. Callers MUST `return` on `null` — nothing is
 * rendered and nothing is dispatched.
 */
export function requireAttributableSender(): string | null {
  const sender = resolveSenderSession();
  if (sender && sender.trim().length > 0) return sender;
  console.error(
    "Refusing to send: no resolvable seat identity (unattributable_sender). The sender derives from " +
      "OPENRIG_SESSION_NAME (the managed seat), never a request-body claim; --from is deprecated and " +
      "ignored. Nothing was sent.",
  );
  process.exitCode = 1;
  return null;
}
