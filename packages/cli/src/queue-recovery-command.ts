import { shellQuote } from "./cross-host-executor.js";

export function quoteQueueRecoveryValue(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "'" + value.replaceAll("'", "''") + "'" : shellQuote(value);
}

/** A read-only reconciliation command for the operator's local shell. */
export function queueRecoveryCommand(id: string, url?: string, platform: NodeJS.Platform = process.platform): string {
  const quote = (value: string) => quoteQueueRecoveryValue(value, platform);
  const show = `rig queue show ${quote(id)} --full --json`;
  if (!url) return show;
  if (platform !== "win32") return `OPENRIG_URL=${quote(url)} ${show}`;
  // Keep endpoint selection local to this invocation, even when the read fails.
  return `& { $openrigRecoveryUrl = [Environment]::GetEnvironmentVariable('OPENRIG_URL', 'Process'); try { $env:OPENRIG_URL = ${quote(url)}; ${show} } finally { [Environment]::SetEnvironmentVariable('OPENRIG_URL', $openrigRecoveryUrl, 'Process') } }`;
}
