import { join } from "node:path";

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
