/**
 * A `--wait-for-idle` longer than one request can carry.
 *
 * A waiting send's response starts only when the wait ends, and Node's fetch gives up on a response that hasn't started
 * within 300 s (undici's headers timeout). So a longer wait failed at about 300 s and read as a daemon that didn't answer,
 * with the send's outcome unknown. A longer wait is made instead as consecutive waits of up to WAIT_FOR_IDLE_STEP_MS, each
 * its own request. Only the daemon's own answer "the seat was still busy and nothing was sent" is followed by the next
 * wait, with what's left; any other answer is returned as it came.
 */
export const WAIT_FOR_IDLE_STEP_MS = 240_000;

type Body = Record<string, unknown>;

/** How to read and replace the daemon's answer in a caller's response shape. */
export interface SendBodyAccess<R> {
  read(response: R): Body | undefined;
  write(response: R, body: Body): R;
}

/** The local daemon client's `{ status, data }` answer. */
export const daemonSendBody: SendBodyAccess<{ status: number; data: Body }> = {
  read: (response) => response.data,
  write: (response, data) => ({ ...response, data }),
};

/** The daemon's own "still busy when the wait ended; no text was sent" answer. */
export function stillBusyNothingSent(body: Body | undefined): boolean {
  return body?.["reason"] === "wait_for_idle_timeout" && body["sent"] === false;
}

export async function sendWaitingForIdle<R>(
  totalMs: number | undefined,
  post: (waitMs: number | undefined) => Promise<R>,
  access: SendBodyAccess<R>,
): Promise<R> {
  if (totalMs === undefined || totalMs <= WAIT_FOR_IDLE_STEP_MS) return post(totalMs);
  let remaining = totalMs;
  let waitedMs = 0;
  for (let waits = 1; ; waits++) {
    const step = Math.min(remaining, WAIT_FOR_IDLE_STEP_MS);
    const response = await post(step);
    remaining -= step;
    const body = access.read(response);
    waitedMs += typeof body?.["waitedMs"] === "number" ? body["waitedMs"] : step;
    if (stillBusyNothingSent(body) && remaining > 0) continue;
    if (waits === 1 || !body) return response;
    // The daemon's answer names only its own step; a send that ended unsent names the whole wait.
    return access.write(response, {
      ...body,
      waitedMs,
      waits,
      ...(body["sent"] === false ? { error: `${String(body["error"] ?? "No text was sent.")} That was the last of ${waits} consecutive waits, ${totalMs}ms in all.` } : {}),
    });
  }
}
