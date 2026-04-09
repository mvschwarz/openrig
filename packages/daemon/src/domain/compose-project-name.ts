export const COMPOSE_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function deriveComposeProjectName(rawName: string): string {
  const lower = rawName.toLowerCase();
  const sanitized = lower
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "");

  if (!sanitized) return "rig";
  if (/^[a-z0-9]/.test(sanitized)) return sanitized;
  return `rig-${sanitized}`;
}

