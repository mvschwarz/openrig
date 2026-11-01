/** A same-daemon canonical seat address, not a host-qualified or synthetic destination. */
export function isEscalationTargetRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/.test(value)
    && !value.startsWith("human@") && !value.endsWith("@external");
}
