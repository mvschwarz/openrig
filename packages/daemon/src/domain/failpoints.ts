/**
 * DEV-only failpoints for crash/recovery falsification.
 *
 * When `OPENRIG_FAILPOINT=<name>` matches, the process exits immediately so
 * finally-handlers cannot heal a partial write. Production never sets this.
 */
export function tripFailpoint(name: string): void {
  if (process.env["OPENRIG_FAILPOINT"] === name) {
    try {
      process.stderr.write(`failpoint_trip:${name}\n`);
    } catch {
      /* ignore */
    }
    process.exit(70);
  }
}
