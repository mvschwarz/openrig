// What `rig setup` reads to tell the person, before the daemon starts, which addresses its default bind listens on: the
// same bind plan and Tailscale detection the daemon applies at startup.
export { resolveBindPlan, type BindPlan } from "./domain/bind-plan.js";
export { detectTailscaleInterface } from "./middleware/auth-bearer-token.js";
