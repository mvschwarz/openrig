import { z } from "zod";
import type { McpAccess } from "./mcp-server.js";
import type { McpPrincipal } from "./mcp-http.js";

/** Resolve one credential for this daemon. Methods are JSON-RPC methods, in message order, not authority. */
export type CallerResolver = (request: {
  bearer: string; instance: string; methods: readonly string[]; signal: AbortSignal;
}) => Promise<CallerResolution>;

export type CallerResolution =
  | { ok: true; principal: McpPrincipal; seat: string; access: McpAccess;
      readOnly?: boolean; newWorkRetryAfterMs?: number }
  | { ok: false; refusal: "unknown" | "revoked" | "expired" | "wrong_instance" | "malformed" | "unavailable";
      message?: string };

const text = z.string().max(200).refine(value => value.trim() !== "");
const seat = z.string().regex(/^[^\s@]+@[^\s@]+$/);
const version = z.union([z.number().finite(), z.string().max(64).refine(value => value.trim() !== "")]);
const objects = z.record(z.string(), z.array(z.string()));
const delay = z.number().finite().nonnegative();
const access = z.object({
  principal: text, owner: z.boolean(), rigs: z.array(z.string()), roots: z.array(z.string()), workspace: z.boolean(),
  person: z.string().optional(), readOnly: z.boolean().optional(), newWorkRetryAfterMs: delay.optional(),
  external: z.object({ objects, peerSeats: z.array(seat).optional(), person: z.string().optional(),
    grant: z.object({ id: text, version: version.optional() }).optional(),
    throttle: z.object({ retryAfterSeconds: delay }).optional(),
  }).optional(),
}).refine(value => !value.external || (!value.owner && !value.workspace));
const principal = z.object({ source: text, id: text, grant: text.optional(), version: version.optional(),
  label: text.optional(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`), "utf8") <= 512);
const resolution = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), principal, seat, access, readOnly: z.boolean().optional(), newWorkRetryAfterMs: delay.optional() }),
  z.object({ ok: z.literal(false), refusal: z.enum(["unknown", "revoked", "expired", "wrong_instance", "malformed", "unavailable"]), message: z.string().optional() }),
]);
const personId = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Unreadable authority is unavailable. An unusable optional person withholds only the person tools. */
export function normalizeCallerResolution(value: unknown): CallerResolution | undefined {
  const parsed = resolution.safeParse(value);
  if (!parsed.success) return undefined;
  const caller = parsed.data;
  if (!caller.ok) return caller;
  const profile: McpAccess = { ...caller.access, principal: caller.principal.id,
    ...(caller.readOnly ? { readOnly: true } : {}),
    ...(caller.newWorkRetryAfterMs !== undefined ? { newWorkRetryAfterMs: caller.newWorkRetryAfterMs } : {}),
  };
  if (profile.person !== undefined && !personId.test(profile.person)) delete profile.person;
  if (profile.external?.person !== undefined && !personId.test(profile.external.person)) delete profile.external.person;
  return { ...caller, access: profile };
}

/** The optional token-file work profile uses the same evaluator as resolved callers. */
export const localCallerProfile = z.object({ objects: objects.optional(), peerSeats: z.array(seat).optional(),
  readOnly: z.boolean().optional(), newWorkRetryAfterSeconds: delay.optional(),
}).refine(value => value.peerSeats === undefined || value.objects !== undefined);
