import net from "node:net";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * F1 gate-lane mutex (arch d6a6c1db; mechanism (B) bound-localhost-port, arch-RATIFIED with 5 binding pins).
 * The arch rationale is the PROPERTY, not the syscall: a machine-wide, kernel-RELEASED-on-process-death,
 * NON-BLOCKING mutex with no stale-lock class. A bound localhost port delivers all three (the kernel frees
 * the port when the holder dies; EADDRINUSE is an immediate non-blocking probe = LOCK_NB) with zero native
 * deps. (Unix-socket bind was REJECTED for the record: the socket file lingers post-kill-9 = stale-artifact.)
 *
 * The 5 pins:
 *  P1 — bind 127.0.0.1 EXPLICITLY (below).
 *  P2 — exclusivity is LOAD-BEARING: NO SO_REUSEPORT (never set; node's default listen doesn't) so a second
 *       concurrent bind MUST fail — with REUSEPORT the mutex silently vanishes. Guard-tested.
 *  P3 — the PORT NUMBER *is* the lock name: ONE named constant, ONE home (GATE_LANE_PORT below).
 *  P4 — the holder-info file is NAMING-ONLY: written AFTER a successful bind (a pre-bind write would be
 *       option-C — a pid-file lock — by the back door), best-effort read/cleanup, NEVER consulted for the
 *       lock DECISION (the bind is the decision; EADDRINUSE alone refuses).
 *  P5 — foreign-squatter honesty (rendered by the runner): holder-info present → names pid/started-at;
 *       absent → honest-unknown; both teach the port constant; ALWAYS hard-refuse, never auto-override.
 */

/** P3 — the one named lock: the port number IS the lock name (fixed, from config). */
export const GATE_LANE_PORT = Number.parseInt(process.env.OPENRIG_GATE_LANE_PORT ?? "40404", 10);

/**
 * @returns {Promise<{ok:true, release:()=>Promise<void>} | {ok:false, reason:"gate-holder"|"foreign-holder"|"bind-error", holder?:{pid:number,startedAt:string}, message?:string}>}
 */
export async function acquireGateLane({ port = GATE_LANE_PORT, holderInfoPath }) {
  // P1 + P2: bind 127.0.0.1 explicitly; do NOT pass reusePort — exclusivity is the mutex.
  const server = net.createServer();
  const bound = await new Promise((resolve) => {
    server.once("error", (err) => resolve({ ok: false, err }));
    server.listen(port, "127.0.0.1", () => resolve({ ok: true }));
  });

  if (!bound.ok) {
    if (bound.err?.code !== "EADDRINUSE") {
      return { ok: false, reason: "bind-error", message: String(bound.err?.message ?? bound.err) };
    }
    // Port busy. A gate holder announces itself via the holder-info file; anything else is foreign load
    // → fail-closed (never run a gate lane beside unknown load).
    if (existsSync(holderInfoPath)) {
      try {
        const holder = JSON.parse(readFileSync(holderInfoPath, "utf8"));
        if (holder && typeof holder.pid === "number" && typeof holder.startedAt === "string") {
          return { ok: false, reason: "gate-holder", holder };
        }
      } catch { /* corrupt info → treat as foreign, fail-closed */ }
    }
    return { ok: false, reason: "foreign-holder" };
  }

  // P4: the bind IS the lock. Announce the holder BEST-EFFORT for naming only — a holder-info write
  // failure must NEVER lose the already-held lane (a contending gate then just sees honest-unknown).
  try {
    mkdirSync(dirname(holderInfoPath), { recursive: true });
    writeFileSync(holderInfoPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch { /* naming-only, best-effort */ }
  const release = () =>
    new Promise((resolve) => {
      try { unlinkSync(holderInfoPath); } catch { /* best-effort */ }
      server.close(() => resolve());
    });
  return { ok: true, release };
}
