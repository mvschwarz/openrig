export interface PostureOptions {
  publicAddr?: string;
  daemonPort?: number;
  sshPort?: number;
}

/** Explicit target ports, independent of the calling process's daemon env. */
export function resolvePosturePorts(opts: { daemonPort?: unknown; sshPort?: unknown } = {}): { daemonPort: number; sshPort: number } {
  const port = (value: unknown, fallback: number, label: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) throw new Error(`${label} must be an integer from 1 to 65535`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${label} must be an integer from 1 to 65535`);
    return parsed;
  };
  return { daemonPort: port(opts.daemonPort, 7433, "Posture daemon port"), sshPort: port(opts.sshPort, 22, "Posture SSH port") };
}
