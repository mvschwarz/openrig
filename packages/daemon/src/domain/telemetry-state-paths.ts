import { join } from "node:path";

/** Instance-owned collector copy, independent of any seat's working folder. */
export const CONTEXT_COLLECTOR_RELATIVE_PATH = "state/claude-context-collector/context-collector.cjs";

export function contextCollectorPath(openrigHome: string): string {
  return join(openrigHome, CONTEXT_COLLECTOR_RELATIVE_PATH);
}

export function contextUsageDirectory(openrigHome: string): string {
  return join(openrigHome, "state", "context-usage");
}

export function legacyContextUsageDirectory(openrigHome: string): string {
  return join(openrigHome, "context");
}

export function providerUsageDirectory(openrigHome: string): string {
  return join(openrigHome, "state", "provider-usage");
}

export function legacyProviderUsageDirectory(openrigHome: string): string {
  return join(openrigHome, "provider-usage");
}

export function telemetrySidecarFilename(sessionName: string): string {
  return `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`;
}

export function telemetrySidecarPath(directory: string, sessionName: string): string {
  return join(directory, telemetrySidecarFilename(sessionName));
}
