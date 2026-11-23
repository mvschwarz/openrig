import { z } from "zod";
import { SettingsStore } from "./user-settings/settings-store.js";

const rigNames = z.string().transform((raw, ctx) => {
  try { return z.array(z.string().min(1)).parse(JSON.parse(raw)); }
  catch { ctx.addIssue({ code: "custom", message: "expected a JSON array of rig names" }); return z.NEVER; }
});
const policy = z.object({
  enabled: z.boolean(), observe: z.boolean(),
  idleThresholdMinutes: z.number().int().min(60).max(525600),
  maxReapsPer24h: z.number().int().positive().max(10000),
  protectedRigs: rigNames, optInRigs: rigNames,
});
export type SeatReaperSettings = z.output<typeof policy>;

export function readSeatReaperSettings(store = new SettingsStore()): SeatReaperSettings {
  // #3836 review: read all six values from ONE configuration snapshot. Six resolveOne
  // calls read the file six times, and a concurrent write between reads could hand the
  // destructive pre-stop gate a mixed enabled/observe pair that neither config allows.
  const all = store.resolveAllWithSource();
  return policy.parse({
    enabled: all["policies.seat_scale.enabled"].value,
    observe: all["policies.seat_scale.observe"].value,
    idleThresholdMinutes: all["policies.seat_scale.idle_threshold_minutes"].value,
    maxReapsPer24h: all["policies.seat_scale.max_reaps_per_24h"].value,
    protectedRigs: all["policies.seat_scale.protected_rigs"].value,
    optInRigs: all["policies.seat_scale.opt_in_rigs"].value,
  });
}
