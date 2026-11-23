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
const operations = z.array(z.string());
const objects = z.record(z.string(), operations);
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

/** Keep valid token-file limits; an unusable field narrows only that capability in the existing evaluator. */
export function localCallerProfile(value: {
  objects?: unknown; peerSeats?: unknown; readOnly?: unknown; newWorkRetryAfterSeconds?: unknown;
}, warn: (field: string, repair: string) => void): {
  objects?: Record<string, string[]>; peerSeats?: string[]; readOnly?: boolean; newWorkRetryAfterSeconds?: number;
} {
  const profile: ReturnType<typeof localCallerProfile> = {};
  if (value.objects !== undefined) {
    profile.objects = {};
    const entries = z.record(z.string(), z.unknown()).safeParse(value.objects);
    if (!entries.success) warn("objects", "Set an object-to-operation-list map; object actions are disabled until repaired.");
    else profile.objects = Object.fromEntries(Object.entries(entries.data).map(([name, actions]) => {
      const parsed = operations.safeParse(actions);
      if (!parsed.success) warn(`objects.${name}`, "Set an array of operation names; this object's actions are disabled until repaired.");
      return [name, parsed.success ? parsed.data : []];
    }));
  }
  if (value.peerSeats !== undefined) {
    const parsed = z.array(seat).safeParse(value.peerSeats);
    profile.peerSeats = parsed.success ? parsed.data : [];
    if (!parsed.success) warn("peerSeats", "Set an array of member@rig addresses; no peers are allowed until repaired.");
    if (profile.objects === undefined) {
      profile.objects = {};
      warn("peerSeats", "Add an objects map alongside peerSeats; object actions are disabled until repaired.");
    }
  }
  if (value.readOnly !== undefined) {
    const parsed = z.boolean().safeParse(value.readOnly);
    profile.readOnly = parsed.success ? parsed.data : true;
    if (!parsed.success) warn("readOnly", "Set true or false; this grant is read-only until repaired.");
  }
  if (value.newWorkRetryAfterSeconds !== undefined) {
    const parsed = delay.safeParse(value.newWorkRetryAfterSeconds);
    profile.newWorkRetryAfterSeconds = parsed.success ? Math.min(600, parsed.data) : 600;
    if (!parsed.success) warn("newWorkRetryAfterSeconds", "Set a finite nonnegative number; new work waits up to 600 seconds until repaired, while existing work remains usable.");
  }
  return profile;
}
